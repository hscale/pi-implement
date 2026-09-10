# Changelog

All notable changes to `pi-implement` are documented in this file.

## [0.2.5] — 2026-09-10

### Added
- **Flexible Directory Support**: `/implement-tasks` can now understand and execute tasks in arbitrary directory structures without enforcing a fixed schema:
  - **Sprint Packs**: Discovers `sprints/*.md` and matches against `backlog.json` (`sprints: [...]`), associating matching prompt guides (`prompts/`), checklists (`checklists/`), and templates (`templates/`).
  - **Classic Planning Directories**: Preserves full support for `tasks/<id>.md` + `status.json` + `backlog.json`.
  - **Standalone Task Directories**: Supports `tasks/*.md` without requiring `status.json` or `backlog.json`.
  - **Markdown Backlogs & Tables**: Parses tasks and acceptance criteria from `TASK_BACKLOG.md`, `BACKLOG.md`, `tasks.md`, or `TODO.md`.
  - **Flat Markdown Files**: Supports directories of loose `.md` files at root.
- **Contextual Task Prompts**: Replaced hardcoded `planning/status.json` paths with dynamic task prompts pointing to authoritative cards, prompt guidelines, checklists, and acceptance criteria.
- **Robust Status & State Sync**: Enhanced `syncPlanningStateIfApplicable` with word-boundary and numeric ID matching to prevent prefix collisions (e.g. `sprint 0` matching `sprint 02`).
