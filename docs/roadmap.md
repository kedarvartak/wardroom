# Roadmap

## Phase 1 — Shared memory MCP (v0.1) — shipped, superseded

Append-only `AGENTS.md` line log (`start_session`, `append_message`,
`read_memory`, `get_context`, search/summarize/decisions). Removed in v0.2:
race-prone unlocked appends, lossy single-line storage, unparseable under
adversarial content (see `enhance.md` §3 for the post-mortem).

## Phase 2 — Writedown memory (v0.1.x) — shipped, retained

User-triggered structured session snapshots (`/writedown` → `write_session`,
`/readmemo` → `read_memo`); one file per session under `.memo/sessions/`,
`AGENTS.md` regenerated as the cold-start index.

## Phase 3 — Shared-checkout coordination (v0.2) — current

The pivot: from memory-only to **parallel agents on one checkout, no
worktrees**. Rationale and research: `docs/parallelism.md`.

- [x] `store.ts` — mkdir-atomic locks, stale-lock recovery, atomic JSON writes
- [x] File leases with TTL + conservative glob-overlap detection (`claims.ts`)
- [x] Dependency + file-overlap-aware task board with atomic pull (`tasks.ts`)
- [x] Cursor-pollable NDJSON event bus (`events.ts`)
- [x] Unified `get_context` (writedown + board + claims + events)
- [x] Multi-process concurrency tests
- [x] Docs: `parallelism.md`, `architecture.md`, `protocol.md`
- [ ] Publish v0.2.0 to npm

## Phase 4 — Coordination hardening

- [ ] Enforcement option: a PreToolUse/Edit hook (Claude Code) that blocks
      edits to files leased by another agent — advisory becomes opt-in enforced
- [ ] Heartbeats: auto-renew leases while an agent is active; presence view
      ("who is online, on what")
- [ ] Board hygiene: archive done/failed tasks, compact `events.ndjson` past a
      size threshold
- [ ] `handoff_to`: package a task's context (events since claim, files,
      result-so-far) for another agent to continue
- [ ] Conflict telemetry: log how often claims collide to tune decomposition

## Phase 5 — Orchestration & UI

Headless dispatch (`claude -p` / `codex exec` / `gemini -p`) driven from the
board — an orchestrator that plans tasks, spawns one CLI per runnable task,
and streams progress; then the browser UI over Cloudflare Tunnel (see
`docs/idea.md`). Deferred until Phase 4 proves the coordination layer under
real parallel load.
