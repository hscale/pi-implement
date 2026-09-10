import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_DISABLED_CHOICE,
	COMPACTION_ENABLED_CHOICE,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	compactIfNeeded,
	parseCompactionThresholdPercent,
} from "./compaction.ts";
import { ActiveSessionExecutor, type TaskStatus } from "./executor.ts";
import { createLocalGit, type LocalGit } from "./git.ts";
import {
	applyImplementationSettings,
	assertImplementationSettings,
	isImplementationThinkingLevel,
	selectImplementationSettings,
	type ImplementationModelController,
	type ImplementationSettings,
} from "./model.ts";
import {
	GENERATED_TASKS_FILE,
	convertPlanToTaskDocument,
	generatedTasksFileExists,
	writeGeneratedTaskDocument,
} from "./plan.ts";
import {
	STATE_FILE_NAME,
	addStateFileToGitignore,
	deleteState,
	loadState,
	saveState,
	type ImplementationState,
} from "./state.ts";
import { buildTaskFilePrompt, indexTaskFile, type TaskReference } from "./tasks.ts";

const PROGRESS_WIDGET = "implement-progress";
const PROGRESS_TASK_LIMIT = 5;
const GIT_CHECKPOINT_CHOICE = "Git checkpoints: new or current local branch";

type ExecutionOptions = ImplementationSettings & {
	checkpoint: boolean;
	automaticCompaction: boolean;
	compactionThresholdPercent: number;
	branchName?: string;
};

type TitledTaskList = {
	tasks: readonly { title: string }[];
};

export interface MarkdownInput {
	sourcePath: string;
	resolvedPath: string;
	markdown: string;
	planningDirectory?: boolean;
	indexedTasks?: TaskReference[];
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

export async function readMarkdownInput(
	argument: string,
	cwd: string,
	commandName: string,
): Promise<MarkdownInput> {
	const sourcePath = argument.trim();
	if (!sourcePath) {
		throw new Error(`Usage: ${commandName} <markdown-file>`);
	}

	const resolvedPath = resolve(cwd, sourcePath);
	let fileStats;
	try {
		fileStats = await stat(resolvedPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new Error(`File not found: ${sourcePath}`);
		}
		throw new Error(`Unable to access file: ${sourcePath}`);
	}

	if (fileStats.isDirectory()) {
		const { markdown, tasks } = await readPlanningDirectoryInput(resolvedPath, cwd, sourcePath, commandName);
		return { sourcePath, resolvedPath, markdown, planningDirectory: true, indexedTasks: tasks };
	}

	if (!fileStats.isFile()) {
		throw new Error(`Path is not a file or supported planning directory: ${sourcePath}`);
	}

	let markdown: string;
	try {
		markdown = await readFile(resolvedPath, "utf8");
	} catch {
		throw new Error(`Unable to read file: ${sourcePath}`);
	}

	if (!markdown.trim()) {
		throw new Error(`Markdown file is empty: ${sourcePath}`);
	}

	return { sourcePath, resolvedPath, markdown };
}

function naturalSort(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function extractMarkdownHeading(filePath: string): Promise<string | undefined> {
	try {
		const content = await readFile(filePath, "utf8");
		for (const line of content.split(/\r?\n/)) {
			const match = line.match(/^#\s+(.+)$/);
			if (match && match[1].trim()) {
				return match[1].trim();
			}
		}
	} catch {
		// Ignore
	}
	return undefined;
}

function parseMarkdownBacklogTasks(content: string, sourcePath: string): TaskReference[] {
	const tasks: TaskReference[] = [];
	const lines = content.split(/\r?\n/);
	let currentSection = "";

	for (const line of lines) {
		const heading = line.match(/^##+\s+(.+)$/);
		if (heading) {
			currentSection = heading[1].trim();
			continue;
		}

		// Markdown table row: | ID | Priority | Task | Acceptance |
		const tableMatch = line.match(/^\|\s*([A-Za-z0-9_-]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/);
		if (tableMatch) {
			const id = tableMatch[1].trim();
			if (id.toUpperCase() === "ID" || /^[-:]+$/.test(id)) continue;
			const priority = tableMatch[2].trim();
			const taskName = tableMatch[3].trim();
			const acceptance = tableMatch[4].trim();
			const title = `${id} — ${taskName}`;
			const taskPrompt = [
				`Implement task: "${title}".`,
				"",
				`Source backlog file: ${sourcePath}`,
				currentSection ? `Section: ${currentSection}` : "",
				`Priority: ${priority}`,
				`Acceptance criteria: ${acceptance}`,
				"",
				"Instructions:",
				`1. Read ${sourcePath} as authoritative context.`,
				`2. Fulfill the acceptance criteria: ${acceptance}.`,
				"3. Complete ONLY this task. Do not start subsequent tasks.",
				"",
				"Constraints:",
				"- Do not perform remote Git operations (do not push, pull, fetch, clone, or modify remotes).",
				"- Do not create commits; the implementation workflow manages commits when enabled.",
			].filter(Boolean).join("\n");

			tasks.push({
				id,
				title,
				prompt: taskPrompt,
				status: "pending",
			});
			continue;
		}

		// Checklist item: - [ ] Task name
		const checkMatch = line.match(/^-\s*\[([ xX])\]\s*(.+)$/);
		if (checkMatch) {
			const isDone = checkMatch[1] !== " ";
			const text = checkMatch[2].trim();
			const title = currentSection ? `${currentSection}: ${text}` : text;
			tasks.push({
				title,
				status: isDone ? "done" : "pending",
			});
		}
	}

	return tasks;
}

function buildSprintTaskPrompt(options: {
	sourcePath: string;
	taskNumber: number;
	totalTasks: number;
	title: string;
	cardPath?: string;
	matchedPrompt?: string;
	checklists: string[];
	templates: string[];
	contextFiles: string[];
	hasStatusJson: boolean;
	statusPath?: string;
	hasReportsDir: boolean;
	reportsDir?: string;
}): string {
	const parts: string[] = [
		`Implement task #${options.taskNumber} of ${options.totalTasks}: "${options.title}".`,
		"",
		`Source planning directory: ${options.sourcePath}`,
	];

	if (options.cardPath) {
		parts.push(`Authoritative sprint card: ${options.cardPath}`);
	}
	if (options.matchedPrompt) {
		parts.push(`Prompt instructions / guidance: ${options.matchedPrompt}`);
	}
	if (options.checklists.length > 0) {
		parts.push(`Checklists to review: ${options.checklists.join(", ")}`);
	}
	if (options.templates.length > 0) {
		parts.push(`Templates: ${options.templates.join(", ")}`);
	}
	if (options.contextFiles.length > 0) {
		parts.push(`Planning context: ${options.contextFiles.join(", ")}`);
	}

	parts.push(
		"",
		"Instructions:",
		`1. Read ${options.cardPath ?? options.sourcePath} as the authoritative source for requirements and acceptance criteria.`,
	);

	if (options.matchedPrompt) {
		parts.push(`2. Review ${options.matchedPrompt} for specific implementation guidelines and patterns.`);
	}
	if (options.checklists.length > 0) {
		parts.push(`3. Verify work against applicable checklists (${options.checklists.join(", ")}).`);
	}
	parts.push("4. Complete ONLY this sprint/task. Stop at the sprint boundary. Do not start subsequent tasks.");

	if (options.hasStatusJson && options.statusPath) {
		parts.push(`5. Update task/sprint status in ${options.statusPath} upon completion.`);
	}
	if (options.hasReportsDir && options.reportsDir) {
		parts.push(`6. Write a summary report in ${options.reportsDir} upon completion.`);
	}

	parts.push(
		"",
		"Constraints:",
		"- Do not perform remote Git operations (do not push, pull, fetch, clone, or modify remotes).",
		"- Do not create commits; the implementation workflow manages commits when enabled.",
	);

	return parts.join("\n");
}

function buildTaskCardPrompt(options: {
	sourcePath: string;
	taskNumber: number;
	totalTasks: number;
	id?: string;
	title: string;
	cardPath?: string;
	dependencies?: string[];
	contextFiles: string[];
	hasStatusJson: boolean;
	statusPath?: string;
	hasReportsDir: boolean;
	reportsDir?: string;
}): string {
	const parts: string[] = [
		`Implement task #${options.taskNumber} of ${options.totalTasks}: "${options.title}".`,
		"",
		`Source planning directory: ${options.sourcePath}`,
	];

	if (options.cardPath) {
		parts.push(`Authoritative task card: ${options.cardPath}`);
	}
	if (options.dependencies && options.dependencies.length > 0) {
		parts.push(`Dependencies: ${options.dependencies.join(", ")}`);
	}
	if (options.contextFiles.length > 0) {
		parts.push(`Planning context: ${options.contextFiles.join(", ")}`);
	}

	parts.push(
		"",
		"Instructions:",
		`1. Read ${options.cardPath ?? options.sourcePath} as the authoritative source for requirements and acceptance criteria.`,
	);
	if (options.dependencies && options.dependencies.length > 0) {
		parts.push(`2. Ensure dependencies (${options.dependencies.join(", ")}) are completed before starting.`);
	}
	parts.push("3. Complete ONLY this task. Do not start subsequent tasks.");

	if (options.hasStatusJson && options.statusPath) {
		parts.push(`4. Update task status in ${options.statusPath} upon completion.`);
	}
	if (options.hasReportsDir && options.reportsDir) {
		const reportName = options.id ? `${options.id}.md` : `task-${options.taskNumber}.md`;
		parts.push(`5. Write the task report in ${join(options.reportsDir, reportName)} upon completion.`);
	}

	parts.push(
		"",
		"Constraints:",
		"- Do not perform remote Git operations (do not push, pull, fetch, clone, or modify remotes).",
		"- Do not create commits; the implementation workflow manages commits when enabled.",
	);

	return parts.join("\n");
}

async function readPlanningDirectoryInput(
	resolvedPath: string,
	cwd: string,
	sourcePath: string,
	commandName: string,
): Promise<{ markdown: string; tasks: TaskReference[] }> {
	const rel = (target: string) => {
		const r = relative(cwd, target);
		return r && !r.startsWith("..") ? r : target;
	};

	let dirEntries;
	try {
		dirEntries = await readdir(resolvedPath, { withFileTypes: true });
	} catch {
		throw new Error(`Unable to read directory: ${sourcePath}`);
	}

	const fileNames = new Set(dirEntries.filter((e) => e.isFile()).map((e) => e.name));
	const subDirNames = new Set(dirEntries.filter((e) => e.isDirectory()).map((e) => e.name));

	// 1. Status discovery
	let statusData: any;
	let statusFilePath: string | undefined;
	for (const cand of ["status.json", ".status.json", "tasks.json"]) {
		if (fileNames.has(cand)) {
			try {
				statusFilePath = join(resolvedPath, cand);
				statusData = JSON.parse(await readFile(statusFilePath, "utf8"));
				break;
			} catch {}
		}
	}

	const statusById = new Map<string, { status: string; blocker?: string }>();
	if (statusData) {
		if (Array.isArray(statusData.tasks)) {
			for (const t of statusData.tasks) {
				if (t && typeof t === "object" && t.id !== undefined && t.id !== null) {
					const idStr = String(t.id).trim();
					const stat = typeof t.status === "string" ? t.status : "pending";
					const blocker = typeof t.blocker === "string" ? t.blocker : undefined;
					statusById.set(idStr, { status: stat, blocker });
					statusById.set(idStr.toLowerCase(), { status: stat, blocker });
				}
			}
		}
		if (Array.isArray(statusData.sprints)) {
			for (const s of statusData.sprints) {
				if (s && typeof s === "object" && s.id !== undefined && s.id !== null) {
					const idStr = String(s.id).trim();
					const stat = typeof s.status === "string" ? s.status : "pending";
					const blocker = typeof s.blocker === "string" ? s.blocker : undefined;
					statusById.set(idStr, { status: stat, blocker });
					statusById.set(idStr.toLowerCase(), { status: stat, blocker });
					statusById.set(`sprint ${idStr}`.toLowerCase(), { status: stat, blocker });
					const num = parseInt(idStr, 10);
					if (!isNaN(num)) {
						statusById.set(String(num), { status: stat, blocker });
						statusById.set(String(num).padStart(2, "0"), { status: stat, blocker });
						statusById.set(`sprint ${String(num).padStart(2, "0")}`.toLowerCase(), { status: stat, blocker });
					}
					if (typeof s.name === "string") {
						statusById.set(s.name.trim().toLowerCase(), { status: stat, blocker });
					}
				}
			}
		}
		if (typeof statusData === "object" && statusData !== null && !Array.isArray(statusData)) {
			for (const [key, val] of Object.entries(statusData)) {
				if (key === "tasks" || key === "sprints" || key === "schema_version") continue;
				const stat = typeof val === "string" ? val : (val as any)?.status ?? "pending";
				const blocker = typeof val === "object" && val !== null ? (val as any)?.blocker : undefined;
				statusById.set(key, { status: stat, blocker });
				statusById.set(key.toLowerCase(), { status: stat, blocker });
			}
		}
	}

	// 2. Backlog discovery
	let backlogData: any;
	for (const cand of ["backlog.json", ".backlog.json"]) {
		if (fileNames.has(cand)) {
			try {
				backlogData = JSON.parse(await readFile(join(resolvedPath, cand), "utf8"));
				break;
			} catch {}
		}
	}

	const hasBacklogSprints = Array.isArray(backlogData?.sprints) && backlogData.sprints.length > 0;
	const hasBacklogTasks = Array.isArray(backlogData?.tasks) && backlogData.tasks.length > 0;

	// 3. Subdirectories discovery
	const sprintsDirName = ["sprints", "sprint"].find((d) => subDirNames.has(d));
	const tasksDirName = ["tasks", "task"].find((d) => subDirNames.has(d));
	const promptsDirName = ["prompts", "prompt"].find((d) => subDirNames.has(d));
	const checklistsDirName = ["checklists", "checklist"].find((d) => subDirNames.has(d));
	const templatesDirName = ["templates", "template"].find((d) => subDirNames.has(d));
	const reportsDirName = ["reports", "report"].find((d) => subDirNames.has(d));

	let promptFiles: string[] = [];
	if (promptsDirName) {
		try {
			const pEntries = await readdir(join(resolvedPath, promptsDirName), { withFileTypes: true });
			promptFiles = pEntries
				.filter((f) => f.isFile() && f.name.endsWith(".md"))
				.map((f) => join(resolvedPath, promptsDirName, f.name));
		} catch {}
	}

	let checklistFiles: string[] = [];
	if (checklistsDirName) {
		try {
			const cEntries = await readdir(join(resolvedPath, checklistsDirName), { withFileTypes: true });
			checklistFiles = cEntries
				.filter((f) => f.isFile() && f.name.endsWith(".md"))
				.map((f) => join(resolvedPath, checklistsDirName, f.name));
		} catch {}
	}

	let templateFiles: string[] = [];
	if (templatesDirName) {
		try {
			const tEntries = await readdir(join(resolvedPath, templatesDirName), { withFileTypes: true });
			templateFiles = tEntries
				.filter((f) => f.isFile() && f.name.endsWith(".md"))
				.map((f) => join(resolvedPath, templatesDirName, f.name));
		} catch {}
	}

	const contextDocNames = [
		"README.md",
		"SPRINT_MASTER_PLAN.md",
		"UX_UI_IMPLEMENTATION_PLAN.md",
		"TASK_BACKLOG.md",
		"BACKLOG.md",
		"PLAN.md",
		"REQUIREMENT-COVERAGE.md",
		"RISKS.md",
	];
	const generalContextFiles = contextDocNames
		.filter((name) => fileNames.has(name))
		.map((name) => join(resolvedPath, name));

	// 4. Determine strategy
	const allDiscoveredTasks: TaskReference[] = [];
	const preferTasksOverSprints = hasBacklogTasks || (tasksDirName && !hasBacklogSprints && !sprintsDirName);

	if (!preferTasksOverSprints && sprintsDirName) {
		// Sprint strategy
		const sprintDirPath = join(resolvedPath, sprintsDirName);
		const sprintFiles = (await readdir(sprintDirPath, { withFileTypes: true }))
			.filter((f) => f.isFile() && f.name.endsWith(".md") && !f.name.startsWith("."))
			.map((f) => f.name);

		if (hasBacklogSprints) {
			const total = backlogData.sprints.length;
			for (let i = 0; i < total; i++) {
				const s = backlogData.sprints[i];
				const id = s.id !== undefined && s.id !== null ? s.id : i;
				const name = typeof s.name === "string" ? s.name : String(id);
				const padId = String(id).padStart(2, "0");
				const rawId = String(id);

				let matchedFile = sprintFiles.find((f) => {
					const upper = f.toUpperCase();
					return (
						upper.includes(`SPRINT_${padId}`) ||
						upper.includes(`SPRINT_${rawId}`) ||
						upper.includes(`SPRINT-${padId}`) ||
						upper.includes(`SPRINT-${rawId}`)
					);
				});
				if (!matchedFile) {
					const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
					matchedFile = sprintFiles.find((f) => f.toUpperCase().includes(slug));
				}
				if (!matchedFile) {
					matchedFile = sprintFiles.find((f) => f.includes(rawId));
				}

				const cardPath = matchedFile ? join(sprintDirPath, matchedFile) : undefined;
				let title = `Sprint ${padId} — ${name}`;
				if (cardPath) {
					const heading = await extractMarkdownHeading(cardPath);
					if (heading) title = heading;
				}

				const matchedPrompt = promptFiles.find((p) => {
					const upper = basename(p).toUpperCase();
					if (upper.includes(`SPRINT_${padId}`) || upper.includes(`SPRINT_${rawId}`)) return true;
					const rangeMatch = upper.match(/SPRINT_(\d+)_(\d+)/);
					if (rangeMatch) {
						const start = parseInt(rangeMatch[1], 10);
						const end = parseInt(rangeMatch[2], 10);
						const numId = typeof id === "number" ? id : parseInt(rawId, 10);
						if (!isNaN(numId) && numId >= start && numId <= end) return true;
					}
					const keywords = name.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 2);
					return keywords.some((k) => upper.includes(k));
				});

				const statusEntry =
					statusById.get(rawId) ||
					statusById.get(padId) ||
					statusById.get(`sprint ${rawId}`.toLowerCase()) ||
					statusById.get(`sprint ${padId}`.toLowerCase()) ||
					statusById.get(name.toLowerCase());

				allDiscoveredTasks.push({
					id: rawId,
					title,
					cardPath: cardPath ? rel(cardPath) : undefined,
					status: statusEntry?.status ?? "pending",
					prompt: buildSprintTaskPrompt({
						sourcePath: rel(resolvedPath),
						taskNumber: i + 1,
						totalTasks: total,
						title,
						cardPath: cardPath ? rel(cardPath) : undefined,
						matchedPrompt: matchedPrompt ? rel(matchedPrompt) : undefined,
						checklists: checklistFiles.map((c) => rel(c)),
						templates: templateFiles.map((t) => rel(t)),
						contextFiles: generalContextFiles.map((g) => rel(g)),
						hasStatusJson: !!statusFilePath,
						statusPath: statusFilePath ? rel(statusFilePath) : undefined,
						hasReportsDir: !!reportsDirName,
						reportsDir: reportsDirName ? rel(join(resolvedPath, reportsDirName)) : undefined,
					}),
				});
			}
		} else if (sprintFiles.length > 0) {
			sprintFiles.sort(naturalSort);
			const total = sprintFiles.length;
			for (let i = 0; i < total; i++) {
				const file = sprintFiles[i];
				const cardPath = join(sprintDirPath, file);
				const heading = await extractMarkdownHeading(cardPath);
				const idStr = file.replace(/\.md$/i, "");
				const title = heading || idStr.replace(/[-_]+/g, " ");

				const matchedPrompt = promptFiles.find((p) => {
					const upperP = basename(p).toUpperCase();
					const upperF = idStr.toUpperCase();
					return upperP.includes(upperF) || upperF.includes(upperP);
				});

				const statusEntry = statusById.get(idStr) || statusById.get(idStr.toLowerCase());

				allDiscoveredTasks.push({
					id: idStr,
					title,
					cardPath: rel(cardPath),
					status: statusEntry?.status ?? "pending",
					prompt: buildSprintTaskPrompt({
						sourcePath: rel(resolvedPath),
						taskNumber: i + 1,
						totalTasks: total,
						title,
						cardPath: rel(cardPath),
						matchedPrompt: matchedPrompt ? rel(matchedPrompt) : undefined,
						checklists: checklistFiles.map((c) => rel(c)),
						templates: templateFiles.map((t) => rel(t)),
						contextFiles: generalContextFiles.map((g) => rel(g)),
						hasStatusJson: !!statusFilePath,
						statusPath: statusFilePath ? rel(statusFilePath) : undefined,
						hasReportsDir: !!reportsDirName,
						reportsDir: reportsDirName ? rel(join(resolvedPath, reportsDirName)) : undefined,
					}),
				});
			}
		}
	} else if (tasksDirName) {
		// Tasks directory strategy
		const tasksDirPath = join(resolvedPath, tasksDirName);
		const taskFiles = (await readdir(tasksDirPath, { withFileTypes: true }))
			.filter((f) => f.isFile() && f.name.endsWith(".md") && !f.name.startsWith("."))
			.map((f) => f.name);

		if (hasBacklogTasks) {
			const backlogTasks = (backlogData.tasks as any[]).filter(
				(t) => t && (typeof t.id === "string" || typeof t.id === "number"),
			);
			const total = backlogTasks.length;
			for (let i = 0; i < total; i++) {
				const bt = backlogTasks[i];
				const idStr = String(bt.id).trim();
				const title =
					typeof bt.title === "string" && bt.title.trim() ? `${idStr} — ${bt.title.trim()}` : idStr;
				const dependencies = Array.isArray(bt.dependencies)
					? bt.dependencies.map((d: unknown) => String(d))
					: [];
				const statusEntry = statusById.get(idStr) || statusById.get(idStr.toLowerCase());
				const matchedFile =
					taskFiles.find((f) => f.replace(/\.md$/i, "") === idStr) ||
					taskFiles.find((f) => f.toLowerCase() === `${idStr.toLowerCase()}.md`) ||
					taskFiles.find((f) => f.includes(idStr));
				const cardPath = matchedFile ? join(tasksDirPath, matchedFile) : undefined;

				allDiscoveredTasks.push({
					id: idStr,
					title,
					cardPath: cardPath ? rel(cardPath) : undefined,
					dependencies,
					status: statusEntry?.status ?? "pending",
					prompt: buildTaskCardPrompt({
						sourcePath: rel(resolvedPath),
						taskNumber: i + 1,
						totalTasks: total,
						id: idStr,
						title,
						cardPath: cardPath ? rel(cardPath) : undefined,
						dependencies,
						contextFiles: generalContextFiles.map((g) => rel(g)),
						hasStatusJson: !!statusFilePath,
						statusPath: statusFilePath ? rel(statusFilePath) : undefined,
						hasReportsDir: !!reportsDirName,
						reportsDir: reportsDirName ? rel(join(resolvedPath, reportsDirName)) : undefined,
					}),
				});
			}
		} else if (taskFiles.length > 0) {
			taskFiles.sort(naturalSort);
			const total = taskFiles.length;
			for (let i = 0; i < total; i++) {
				const file = taskFiles[i];
				const cardPath = join(tasksDirPath, file);
				const heading = await extractMarkdownHeading(cardPath);
				const idStr = file.replace(/\.md$/i, "");
				const title = heading || idStr.replace(/[-_]+/g, " ");
				const statusEntry = statusById.get(idStr) || statusById.get(idStr.toLowerCase());

				allDiscoveredTasks.push({
					id: idStr,
					title,
					cardPath: rel(cardPath),
					status: statusEntry?.status ?? "pending",
					prompt: buildTaskCardPrompt({
						sourcePath: rel(resolvedPath),
						taskNumber: i + 1,
						totalTasks: total,
						id: idStr,
						title,
						cardPath: rel(cardPath),
						contextFiles: generalContextFiles.map((g) => rel(g)),
						hasStatusJson: !!statusFilePath,
						statusPath: statusFilePath ? rel(statusFilePath) : undefined,
						hasReportsDir: !!reportsDirName,
						reportsDir: reportsDirName ? rel(join(resolvedPath, reportsDirName)) : undefined,
					}),
				});
			}
		}
	}

	// 5. Backlog markdown file fallback
	if (allDiscoveredTasks.length === 0) {
		const backlogDocNames = [
			"TASK_BACKLOG.md",
			"BACKLOG.md",
			"tasks.md",
			"TASKS.md",
			"todo.md",
			"TODO.md",
			"plan.md",
			"PLAN.md",
		];
		const matchedDoc = backlogDocNames.find((name) => fileNames.has(name));
		if (matchedDoc) {
			const docPath = join(resolvedPath, matchedDoc);
			try {
				const content = await readFile(docPath, "utf8");
				const parsed = parseMarkdownBacklogTasks(content, rel(docPath));
				if (parsed.length > 0) {
					allDiscoveredTasks.push(...parsed);
				}
			} catch {}
		}
	}

	// 6. Loose markdown files fallback
	if (allDiscoveredTasks.length === 0) {
		const ignoredDocs = new Set([
			"readme.md",
			"license.md",
			"contributing.md",
			"code_of_conduct.md",
			"security.md",
			"changelog.md",
		]);
		const looseFiles = [...fileNames]
			.filter((name) => name.endsWith(".md") && !ignoredDocs.has(name.toLowerCase()))
			.sort(naturalSort);

		if (looseFiles.length > 0) {
			const total = looseFiles.length;
			for (let i = 0; i < total; i++) {
				const file = looseFiles[i];
				const cardPath = join(resolvedPath, file);
				const heading = await extractMarkdownHeading(cardPath);
				const idStr = file.replace(/\.md$/i, "");
				const title = heading || idStr.replace(/[-_]+/g, " ");

				allDiscoveredTasks.push({
					id: idStr,
					title,
					cardPath: rel(cardPath),
					status: "pending",
					prompt: buildTaskCardPrompt({
						sourcePath: rel(resolvedPath),
						taskNumber: i + 1,
						totalTasks: total,
						id: idStr,
						title,
						cardPath: rel(cardPath),
						contextFiles: generalContextFiles.map((g) => rel(g)),
						hasStatusJson: !!statusFilePath,
						statusPath: statusFilePath ? rel(statusFilePath) : undefined,
						hasReportsDir: !!reportsDirName,
						reportsDir: reportsDirName ? rel(join(resolvedPath, reportsDirName)) : undefined,
					}),
				});
			}
		}
	}

	if (allDiscoveredTasks.length === 0) {
		throw new Error(`Path is not a file or supported planning directory: ${sourcePath}`);
	}

	// Filter pending tasks
	const isDone = (s?: string) => {
		if (!s) return false;
		const lower = s.toLowerCase();
		return lower === "done" || lower === "deferred" || lower === "completed" || lower === "passed";
	};

	const pendingTasks = allDiscoveredTasks.filter((t) => !isDone(t.status));
	if (pendingTasks.length === 0) {
		throw new Error(`No incomplete tasks found in planning directory: ${sourcePath}`);
	}

	// Generate synthetic markdown queue document
	const lines = [
		"# Planning implementation queue",
		"",
		`Source planning directory: ${rel(resolvedPath)}`,
		"",
		`This synthetic task file was generated by pi-implement from ${rel(resolvedPath)}.`,
		"Treat the referenced task cards and planning files as authoritative.",
		"",
	];

	pendingTasks.forEach((task, index) => {
		lines.push(`## ${index + 1}. ${task.title}`);
		lines.push("");
		if (task.cardPath) {
			lines.push(`Task card: ${task.cardPath}`);
		}
		lines.push(`Current status: ${task.status ?? "pending"}`);
		if (task.dependencies && task.dependencies.length > 0) {
			lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
		}
		lines.push("");
	});

	return { markdown: lines.join("\n"), tasks: pendingTasks };
}

async function requestMarkdownInput(
	argument: string,
	ctx: ExtensionCommandContext,
	commandName: string,
): Promise<MarkdownInput | undefined> {
	const sourcePath = argument.trim()
		? argument
		: await ctx.ui.input(`Markdown file for ${commandName}`, "path/to/file.md");
	if (!sourcePath?.trim()) {
		return undefined;
	}
	return readMarkdownInput(sourcePath, ctx.cwd, commandName);
}

function report(
	ctx: ExtensionCommandContext,
	commandName: string,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.error(`[${commandName.slice(1)}] ${message}`);
	}
}

export function formatPreview(title: string, tasks: TitledTaskList): string {
	const taskLines = tasks.tasks.map((task, index) => `${index + 1}. ${task.title}`);
	return [title, ...taskLines, `${tasks.tasks.length} ${tasks.tasks.length === 1 ? "task" : "tasks"} detected.`].join(
		"\n",
	);
}

export function formatProgress(
	title: string,
	tasks: TitledTaskList,
	statuses: readonly TaskStatus[],
): string[] {
	const symbols: Record<TaskStatus, string> = {
		pending: "○",
		running: "●",
		completed: "✓",
		failed: "✗",
	};

	let currentIndex = tasks.tasks.findIndex((_, index) => statuses[index] === "running");
	if (currentIndex < 0) {
		currentIndex = tasks.tasks.findIndex((_, index) => statuses[index] === "failed");
	}
	if (currentIndex < 0) {
		currentIndex = tasks.tasks.findIndex((_, index) => (statuses[index] ?? "pending") === "pending");
	}
	if (currentIndex < 0) {
		currentIndex = Math.max(0, tasks.tasks.length - 1);
	}

	return [
		title,
		...tasks.tasks.slice(currentIndex, currentIndex + PROGRESS_TASK_LIMIT).map((task, visibleIndex) => {
			const index = currentIndex + visibleIndex;
			return `${symbols[statuses[index] ?? "pending"]} ${index + 1}/${tasks.tasks.length} ${task.title}`;
		}),
	];
}

function updateProgressUi(
	ctx: ExtensionCommandContext,
	title: string,
	tasks: TitledTaskList,
	statuses: readonly TaskStatus[],
): void {
	ctx.ui.setWidget(PROGRESS_WIDGET, formatProgress(title, tasks, statuses));
	const running = statuses.findIndex((status) => status === "running");
	if (running >= 0) {
		ctx.ui.setWorkingMessage(`Implementing ${running + 1}/${tasks.tasks.length}: ${tasks.tasks[running].title}`);
	} else {
		ctx.ui.setWorkingMessage();
	}
}

async function saveFailure(
	ctx: ExtensionCommandContext,
	commandName: string,
	state: ImplementationState,
	nextTaskIndex: number,
	error: unknown,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	state.nextTaskIndex = nextTaskIndex;
	state.status = "failed";
	state.error = message;
	try {
		await saveState(ctx.cwd, state);
		report(ctx, commandName, `Implementation stopped: ${message}`, "error");
	} catch (saveError) {
		report(
			ctx,
			commandName,
			`Implementation stopped: ${message}. ${saveError instanceof Error ? saveError.message : String(saveError)}`,
			"error",
		);
	}
}

async function completeCheckpoint(
	ctx: ExtensionCommandContext,
	git: LocalGit,
	state: ImplementationState,
): Promise<void> {
	const title = state.tasks[state.nextTaskIndex - 1].title.replace(/\s+/g, " ").trim();
	await git.commitChanges(ctx.cwd, `Task ${state.nextTaskIndex}: ${title}`);
	delete state.pendingCheckpoint;
	state.status = "running";
	delete state.error;
	await saveState(ctx.cwd, state);
}

async function executeTaskSet(
	commandName: string,
	progressTitle: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	state: ImplementationState,
	modelController: ImplementationModelController,
): Promise<void> {
	const tasks = { tasks: state.tasks };
	const statuses: TaskStatus[] = state.tasks.map((_, index) =>
		index < state.nextTaskIndex ? "completed" : "pending",
	);
	const update = () => updateProgressUi(ctx, progressTitle, tasks, statuses);
	update();

	const recoveringCheckpoint = state.pendingCheckpoint;
	if (recoveringCheckpoint) {
		try {
			await completeCheckpoint(ctx, git, state);
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}
	}

	if (state.pendingCompaction || (recoveringCheckpoint && state.nextTaskIndex < state.tasks.length)) {
		try {
			await compactIfNeeded(
				ctx,
				state.automaticCompaction,
				state.compactionThresholdPercent,
				state.nextTaskIndex + 1,
				state.pendingCompaction === true,
				async () => {
					state.pendingCompaction = true;
					await saveState(ctx.cwd, state);
				},
			);
			delete state.pendingCompaction;
			state.status = "running";
			delete state.error;
			await saveState(ctx.cwd, state);
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}
	}

	for (let index = state.nextTaskIndex; index < state.tasks.length; index++) {
		statuses[index] = "running";
		update();
		state.nextTaskIndex = index;
		state.status = "running";
		delete state.error;
		if (ctx.model) {
			state.implementationModel = { provider: ctx.model.provider, id: ctx.model.id };
			const currentThinking = modelController.getThinkingLevel();
			if (isImplementationThinkingLevel(currentThinking)) {
				state.implementationThinkingLevel = currentThinking;
			}
		}
		try {
			await saveState(ctx.cwd, state);
		} catch (error) {
			report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
			return;
		}

		try {
			assertImplementationSettings(state, ctx, modelController);
			await executor.execute(state.tasks[index].prompt);
		} catch (error) {
			statuses[index] = "failed";
			update();
			await saveFailure(ctx, commandName, state, index, error);
			return;
		}

		statuses[index] = "completed";
		update();

		state.nextTaskIndex = index + 1;
		if (state.checkpoint) {
			state.pendingCheckpoint = true;
		}
		state.status = "running";
		delete state.error;
		try {
			await saveState(ctx.cwd, state);
			if (state.pendingCheckpoint) {
				await completeCheckpoint(ctx, git, state);
			}
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}

		if (index + 1 < state.tasks.length) {
			try {
				await compactIfNeeded(
					ctx,
					state.automaticCompaction,
					state.compactionThresholdPercent,
					index + 2,
					false,
					async () => {
						state.pendingCompaction = true;
						await saveState(ctx.cwd, state);
					},
				);
				delete state.pendingCompaction;
				await saveState(ctx.cwd, state);
			} catch (error) {
				await saveFailure(ctx, commandName, state, index + 1, error);
				return;
			}
		}
	}

	try {
		await deleteState(ctx.cwd);
		report(ctx, commandName, "Implementation complete.", "info");
	} catch (error) {
		report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
	}
}

async function selectExecutionOptions(
	previewTitle: string,
	tasks: TitledTaskList,
	isRepository: boolean,
	ctx: ExtensionCommandContext,
	git: LocalGit,
	modelController: ImplementationModelController,
): Promise<ExecutionOptions | undefined> {
	const choices = isRepository
		? ["Implement only", GIT_CHECKPOINT_CHOICE, "Cancel"]
		: ["Implement", "Cancel"];
	const choice = await ctx.ui.select(formatPreview(previewTitle, tasks), choices);
	if (choice !== "Implement" && choice !== "Implement only" && choice !== GIT_CHECKPOINT_CHOICE) {
		return undefined;
	}

	const checkpoint = choice === GIT_CHECKPOINT_CHOICE;
	if (checkpoint && !(await git.isWorkingTreeClean(ctx.cwd))) {
		throw new Error("A clean working tree is required for Git checkpoint mode.");
	}

	const compactionChoice = await ctx.ui.select("Automatic compaction between tasks?", [
		COMPACTION_DISABLED_CHOICE,
		COMPACTION_ENABLED_CHOICE,
	]);
	if (compactionChoice !== COMPACTION_DISABLED_CHOICE && compactionChoice !== COMPACTION_ENABLED_CHOICE) {
		return undefined;
	}

	let compactionThresholdPercent = DEFAULT_COMPACTION_THRESHOLD_PERCENT;
	if (compactionChoice === COMPACTION_ENABLED_CHOICE) {
		const thresholdInput = await ctx.ui.input(
			`Compaction threshold percentage (default: ${DEFAULT_COMPACTION_THRESHOLD_PERCENT}%)`,
			String(DEFAULT_COMPACTION_THRESHOLD_PERCENT),
		);
		if (thresholdInput === undefined) {
			return undefined;
		}
		if (thresholdInput.trim()) {
			compactionThresholdPercent = parseCompactionThresholdPercent(thresholdInput);
		}
	}

	const implementationSettings = await selectImplementationSettings(ctx, modelController);
	if (!implementationSettings) {
		return undefined;
	}

	let branchName: string | undefined;
	if (checkpoint) {
		branchName = (await ctx.ui.input("New local branch name (empty to use current branch)", "feature/task-checkpoints"))?.trim();
		if (branchName === undefined) {
			return undefined;
		}
		if (branchName) {
			await git.createBranch(ctx.cwd, branchName);
		} else {
			const confirmed = await ctx.ui.confirm(
				"Continue on the current branch?",
				"Git checkpoints will commit changes directly to the current local branch.",
			);
			if (!confirmed) {
				return undefined;
			}
			branchName = await git.currentBranch(ctx.cwd);
			if (!branchName) {
				throw new Error("Cannot start Git checkpoint mode on a detached HEAD. Switch to a local branch and try again.");
			}
		}
	}

	return {
		...implementationSettings,
		checkpoint,
		automaticCompaction: compactionChoice === COMPACTION_ENABLED_CHOICE,
		compactionThresholdPercent,
		branchName,
	};
}

function automaticExecutionOptions(
	ctx: ExtensionCommandContext,
	modelController: ImplementationModelController,
): ExecutionOptions {
	if (!ctx.model) {
		throw new Error("No model is selected.");
	}
	const currentThinkingLevel = modelController.getThinkingLevel();
	return {
		implementationModel: { provider: ctx.model.provider, id: ctx.model.id },
		implementationThinkingLevel: isImplementationThinkingLevel(currentThinkingLevel) ? currentThinkingLevel : "off",
		checkpoint: false,
		automaticCompaction: false,
		compactionThresholdPercent: DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	};
}

function createImplementationState(
	cwd: string,
	sourcePath: string,
	tasks: TitledTaskList,
	prompts: readonly string[],
	options: ExecutionOptions,
): ImplementationState {
	return {
		version: 1,
		cwd: resolve(cwd),
		sourcePath,
		tasks: tasks.tasks.map((task, index) => ({ title: task.title, prompt: prompts[index] })),
		nextTaskIndex: 0,
		status: "running",
		checkpoint: options.checkpoint,
		automaticCompaction: options.automaticCompaction,
		compactionThresholdPercent: options.compactionThresholdPercent,
		implementationModel: options.implementationModel,
		implementationThinkingLevel: options.implementationThinkingLevel,
		branchName: options.branchName,
	};
}

export async function runTasksWorkflow(
	input: MarkdownInput,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	modelController: ImplementationModelController,
	ignoreStateFile: boolean,
	isRepository: boolean,
): Promise<void> {
	const commandName = "/implement-tasks";
	if (input.indexedTasks) {
		report(ctx, commandName, `Using planning task queue from ${input.sourcePath} without interactive task indexing.`, "info");
	} else {
		report(ctx, commandName, `Indexing tasks in ${input.sourcePath}...`, "info");
	}
	const taskIndex = input.indexedTasks ? { tasks: input.indexedTasks } : await indexTaskFile(input.markdown, ctx);
	const options = input.planningDirectory
		? automaticExecutionOptions(ctx, modelController)
		: await selectExecutionOptions(
			`Implement tasks from ${input.sourcePath}`,
			taskIndex,
			isRepository,
			ctx,
			git,
			modelController,
		);
	if (!options) {
		report(ctx, commandName, "Task-file implementation cancelled.", "info");
		return;
	}

	if (ignoreStateFile) {
		await addStateFileToGitignore(ctx.cwd);
	}
	const prompts = taskIndex.tasks.map((task, index) => buildTaskFilePrompt(input.sourcePath, index + 1, task));
	const state = createImplementationState(ctx.cwd, input.sourcePath, taskIndex, prompts, options);
	await saveState(ctx.cwd, state);
	try {
		await applyImplementationSettings(state, ctx, modelController);
	} catch (error) {
		await saveFailure(ctx, commandName, state, 0, error);
		return;
	}
	await executeTaskSet(
		commandName,
		"Task-file implementation",
		ctx,
		executor,
		git,
		state,
		modelController,
	);
}

function formatRestorePrompt(state: ImplementationState): string {
	const taskNumber = Math.min(state.nextTaskIndex + 1, state.tasks.length);
	const lines = [
		"Unfinished implementation found",
		"Workflow: /implement-tasks",
		`Task: ${taskNumber}/${state.tasks.length}`,
		`Status: ${state.status}`,
		`Model: ${state.implementationModel.provider}/${state.implementationModel.id}`,
		`Thinking: ${state.implementationThinkingLevel}`,
	];
	if (state.automaticCompaction) {
		lines.push(`Compaction threshold: ${state.compactionThresholdPercent}%`);
	}
	if (state.pendingCheckpoint) {
		lines.push("Pending Git checkpoint: yes");
	}
	if (state.pendingCompaction) {
		lines.push("Pending compaction: yes");
	}
	if (state.error) {
		lines.push(`Error: ${state.error}`);
	}
	return lines.join("\n");
}

export async function syncPlanningStateIfApplicable(
	state: ImplementationState,
	cwd: string,
): Promise<void> {
	const sourcePath = resolve(cwd, state.sourcePath);
	let statusContent: string | undefined;

	for (const name of ["status.json", ".status.json", "tasks.json"]) {
		try {
			statusContent = await readFile(join(sourcePath, name), "utf8");
			break;
		} catch {}
	}

	if (!statusContent) {
		for (const name of ["status.json", ".status.json", "tasks.json"]) {
			try {
				statusContent = await readFile(join(cwd, name), "utf8");
				break;
			} catch {}
		}
	}

	if (!statusContent) {
		return;
	}

	let statusJson: any;
	try {
		statusJson = JSON.parse(statusContent);
	} catch {
		return;
	}

	const doneOrDeferred = new Set<string>();
	const isDone = (val: unknown) =>
		typeof val === "string" &&
		["done", "deferred", "completed", "passed", "skipped"].includes(val.toLowerCase().trim());

	if (Array.isArray(statusJson.tasks)) {
		for (const t of statusJson.tasks) {
			if (t && typeof t === "object" && isDone(t.status) && t.id !== undefined && t.id !== null) {
				const idStr = String(t.id).trim().toLowerCase();
				doneOrDeferred.add(idStr);
			}
		}
	}
	if (Array.isArray(statusJson.sprints)) {
		for (const s of statusJson.sprints) {
			if (s && typeof s === "object" && isDone(s.status) && s.id !== undefined && s.id !== null) {
				const idStr = String(s.id).trim().toLowerCase();
				doneOrDeferred.add(idStr);
				doneOrDeferred.add(`sprint ${idStr}`);
				const num = parseInt(idStr, 10);
				if (!isNaN(num)) {
					doneOrDeferred.add(String(num));
					doneOrDeferred.add(String(num).padStart(2, "0"));
					doneOrDeferred.add(`sprint ${String(num).padStart(2, "0")}`);
				}
				if (typeof s.name === "string") {
					doneOrDeferred.add(s.name.trim().toLowerCase());
				}
			}
		}
	}
	if (typeof statusJson === "object" && statusJson !== null && !Array.isArray(statusJson)) {
		for (const [key, val] of Object.entries(statusJson)) {
			if (key === "tasks" || key === "sprints" || key === "schema_version") continue;
			const st = typeof val === "string" ? val : (val as any)?.status;
			if (isDone(st)) {
				doneOrDeferred.add(key.trim().toLowerCase());
			}
		}
	}

	while (state.nextTaskIndex < state.tasks.length) {
		const currentTask = state.tasks[state.nextTaskIndex];

		let matched = false;

		// 1. Sprint ID e.g. Sprint 00, Sprint 0
		const sprintMatch = currentTask.title.match(/sprint\s*(\d+)/i);
		if (sprintMatch) {
			const num = parseInt(sprintMatch[1], 10);
			const idStr = String(num);
			const padStr = idStr.padStart(2, "0");
			if (
				doneOrDeferred.has(idStr) ||
				doneOrDeferred.has(padStr) ||
				doneOrDeferred.has(`sprint ${idStr}`) ||
				doneOrDeferred.has(`sprint ${padStr}`)
			) {
				matched = true;
			}
		}

		// 2. Hyphenated ID e.g. S00-T01, UX-001
		if (!matched) {
			const hyphenMatch = currentTask.title.match(/^([A-Za-z0-9_-]+)/);
			if (hyphenMatch && doneOrDeferred.has(hyphenMatch[1].toLowerCase())) {
				matched = true;
			}
		}

		// 3. Word-boundary token match for done IDs
		if (!matched) {
			for (const doneId of doneOrDeferred) {
				if (doneId.length >= 3) {
					const escaped = doneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const rx = new RegExp(`(^|[^a-zA-Z0-9_-])${escaped}([^a-zA-Z0-9_-]|$)`, "i");
					if (rx.test(currentTask.title)) {
						matched = true;
						break;
					}
				}
			}
		}

		if (matched) {
			state.nextTaskIndex++;
		} else {
			break;
		}
	}
}

async function handleExistingState(
	requestedCommand: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	modelController: ImplementationModelController,
): Promise<boolean> {
	const state = await loadState(ctx.cwd);
	if (!state) {
		return false;
	}

	const choice = await ctx.ui.select(formatRestorePrompt(state), ["Resume", "Discard and start new", "Cancel"]);
	if (choice === "Discard and start new") {
		await deleteState(ctx.cwd);
		return false;
	}
	if (choice !== "Resume") {
		report(ctx, requestedCommand, "Implementation resume cancelled.", "info");
		return true;
	}

	const currentCwd = resolve(ctx.cwd);
	if (currentCwd !== state.cwd) {
		throw new Error(
			`Cannot resume this implementation from a different working directory.\nExpected: ${state.cwd}\nCurrent: ${currentCwd}`,
		);
	}

	if (state.checkpoint) {
		const currentBranch = await git.currentBranch(ctx.cwd);
		if (currentBranch !== state.branchName) {
			throw new Error(
				`Cannot resume: expected local branch ${JSON.stringify(state.branchName)}, but current branch is ${JSON.stringify(currentBranch || "detached HEAD")}. Switch branches manually and try again.`,
			);
		}
	}

	await syncPlanningStateIfApplicable(state, ctx.cwd);
	if (state.nextTaskIndex >= state.tasks.length && !state.pendingCheckpoint) {
		await deleteState(ctx.cwd);
		report(ctx, requestedCommand, "All tasks in the implementation queue are completed.", "info");
		return true;
	}

	try {
		await applyImplementationSettings(state, ctx, modelController);
	} catch (error) {
		await saveFailure(ctx, requestedCommand, state, state.nextTaskIndex, error);
		return true;
	}

	await executeTaskSet("/implement-tasks", "Task-file implementation", ctx, executor, git, state, modelController);
	return true;
}

export default function implementExtension(pi: ExtensionAPI): void {
	let workflowRunning = false;
	const executor = new ActiveSessionExecutor((message) => pi.sendUserMessage(message));
	const git = createLocalGit((command, args, options) => pi.exec(command, args, options));

	pi.on("agent_start", () => executor.onAgentStart());
	pi.on("agent_end", (event) => executor.onAgentEnd(event.messages));
	pi.on("agent_settled", () => executor.onAgentSettled());
	pi.on("session_shutdown", () => executor.cancel("Task execution stopped because the session changed."));

	const runCommand = async (
		commandName: string,
		ctx: ExtensionCommandContext,
		args: string | undefined,
		workflow: (ignoreStateFile: boolean, isRepository: boolean) => Promise<void>,
	): Promise<void> => {
		if (!ctx.hasUI) {
			report(ctx, commandName, `${commandName} requires an interactive UI for confirmation.`, "error");
			return;
		}
		if (workflowRunning) {
			report(ctx, commandName, "An implementation workflow is already running.", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			report(ctx, commandName, `Wait for the current agent turn to finish before using ${commandName}.`, "warning");
			return;
		}

		workflowRunning = true;
		ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
		try {
			if (await handleExistingState(commandName, ctx, executor, git, pi)) {
				return;
			}
			const isRepository = await git.isRepository(ctx.cwd);
			const ignoreStateFile = isRepository
				? await ctx.ui.select(`Add ${STATE_FILE_NAME} to .gitignore?`, ["Yes", "No"])
				: "No";
			await workflow(ignoreStateFile === "Yes", isRepository);
		} catch (error) {
			report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
		} finally {
			ctx.ui.setWorkingMessage();
			workflowRunning = false;
		}
	};

	pi.registerCommand("implement-tasks", {
		description: "Implement tasks sequentially from an authoritative Markdown task file",
		handler: async (args, ctx) =>
			runCommand("/implement-tasks", ctx, args, async (ignoreStateFile, isRepository) => {
				const input = await requestMarkdownInput(args, ctx, "/implement-tasks");
				if (!input) {
					report(ctx, "/implement-tasks", "Task-file implementation cancelled.", "info");
					return;
				}
				await runTasksWorkflow(input, ctx, executor, git, pi, ignoreStateFile, isRepository);
			}),
	});

	pi.registerCommand("implement-plan", {
		description: "Convert a plan to tasks.md and implement it through the task-file workflow",
		handler: async (args, ctx) =>
			runCommand("/implement-plan", ctx, args, async (ignoreStateFile, isRepository) => {
				const input = await requestMarkdownInput(args, ctx, "/implement-plan");
				if (!input) {
					report(ctx, "/implement-plan", "Plan conversion cancelled.", "info");
					return;
				}
				if (!ctx.model) {
					throw new Error("No model is selected.");
				}

				if (await generatedTasksFileExists(ctx.cwd)) {
					const overwrite = await ctx.ui.select(`${GENERATED_TASKS_FILE} already exists. Overwrite it?`, [
						"Overwrite",
						"Cancel",
					]);
					if (overwrite !== "Overwrite") {
						report(ctx, "/implement-plan", "Plan conversion cancelled.", "info");
						return;
					}
				}

				report(ctx, "/implement-plan", `Converting ${input.sourcePath} to ${GENERATED_TASKS_FILE}...`, "info");
				const markdown = await convertPlanToTaskDocument(input.markdown, ctx);
				const resolvedPath = await writeGeneratedTaskDocument(ctx.cwd, markdown);
				report(ctx, "/implement-plan", `Generated ${GENERATED_TASKS_FILE}.`, "info");
				await runTasksWorkflow(
					{ sourcePath: GENERATED_TASKS_FILE, resolvedPath, markdown },
					ctx,
					executor,
					git,
					pi,
					ignoreStateFile,
					isRepository,
				);
			}),
	});
}
