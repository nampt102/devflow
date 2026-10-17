---
name: project-sync
description: Keep project progress, knowledge base and decision log in sync with the code. Use at the end of a step or session ("sync", "update progress", "cập nhật tiến độ", "kết thúc phiên"), when a decision was made, or to check whether openspec/kb has drifted from the code. Also use at session start to load status.
---

Project memory lives in the repo: `openspec/status.md`, `openspec/kb/`, `openspec/decisions/`, OpenSpec changes. Write in the project's language (see `openspec/config.yaml` context). Read before writing; never invent facts.

## Mode 1: start (load context)
1. Read `openspec/status.md`, `openspec/config.yaml`, and `openspec/decisions/` titles.
2. Run `openspec list` for open changes; read the relevant `proposal.md` and `tasks.md`.
3. Report in 5 lines or fewer: phase, step in progress, blockers, next step.

## Mode 2: end (sync after work)
1. Gather what changed: `git status`, `git diff --stat`, `git log` since the "Last updated" date in `status.md` (if not a git repo, ask the user what changed).
2. `openspec/status.md`: set the date; update "In progress", "Next steps", "Blocked", the progress table (status, change/PR), "Open risks"; prepend one line to "Recent" and trim it to ~10 lines.
3. Active OpenSpec change: tick finished items in `tasks.md` only if the work is truly done and verified. If a change is complete and deployed, ask the user before archiving; never archive on your own.
4. KB: for each code area touched, find the matching `openspec/kb/` file. If the facts changed, update it (cite file paths; mark unknowns "(unverified)"). If no KB file exists and the knowledge is durable, create one. Keep files under ~300 lines.
5. Decisions: if a choice was made this session (technology, direction, accepted trade-off), copy `decisions/0000-template.md` to the next number and fill it. Do not edit old decisions; supersede them.
6. Show the user a short summary of every file changed. Do not commit unless asked.

## Mode 3: check (drift report, writes nothing)
Compare `openspec/kb/*` and `status.md` against the code (paths, commands, table and API names the docs cite). Report: stale statements (doc says X, code says Y, with paths), code areas with no KB coverage, decisions contradicted by code, progress-table rows whose status disagrees with `tasks.md`. Propose fixes; apply only if the user agrees.

## Rules
- The repo is the single source of truth; do not store progress in tool-private memory only.
- If `status.md` is still the unfilled template, fill it from what you can verify, and ask for the rest.
- Keep entries short and specific: what changed and why, not a narration of the session.
