# Claude — Agent Instructions

This project runs multiple agents (Claude, Codex, Gemini) **in parallel on one
shared checkout — no worktrees**. Coordination goes through the
`wardroom` MCP server. Full protocol: `docs/protocol.md`.

## Before touching anything

```
get_context(repo_path="<this repo's absolute path>")
```

This returns the latest session writedown, the task board, active file
claims, and recent events (with a cursor for later polls).

## While working

- Pull work with `claim_next_task` — never pick a board task by hand; the
  atomic claim is what stops two agents doing the same work. It auto-leases
  the task's files for you.
- Editing outside a task? `claim_files` first, `release_files` immediately
  after. If you get a conflict, another agent holds those files — take other
  work, do NOT edit them anyway.
- Renamed a symbol, changed an API, moved a file? `post_event` so other
  agents hear about it now, not at review time.
- Poll `get_events(since_seq=<your cursor>)` between tasks and before editing
  shared surfaces.
- Finish with `complete_task` (result other agents can build on) or
  `fail_task` / `release_task`. Never stop while still holding a claim.

## When decomposing work (`plan_tasks`)

Declare each task's `files` footprint honestly — the scheduler parallelizes
disjoint footprints and serializes overlapping ones. Land shared
types/contracts as an early task others `depends_on`.

## Memory

When the user runs `/writedown`, capture the session via `write_session`.
Run `/readmemo` (→ `read_memo`) to reload prior sessions in a fresh chat.
