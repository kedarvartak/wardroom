# Gemini — Agent Instructions

This project runs multiple agents (Claude, Codex, Gemini) **in parallel on one
shared checkout — no worktrees**. Coordination goes through the
`wardroom` MCP server. Full protocol: `docs/protocol.md`.

## Before touching anything

```
get_context(repo_path="<this repo's absolute path>")
```

## While working

- Pull work with `claim_next_task`; it leases the task's files for you.
- Editing outside a task: `claim_files` first, `release_files` right after.
  On conflict, another agent holds those files — take other work instead.
- Announce breaking mid-flight changes with `post_event`; poll
  `get_events(since_seq=<cursor>)` between tasks.
- Finish every task with `complete_task`, `fail_task`, or `release_task` —
  never stop while holding a claim.

## Memory

`/writedown` → `write_session` captures the session.
`/readmemo` → `read_memo` reloads prior sessions in a fresh chat.
