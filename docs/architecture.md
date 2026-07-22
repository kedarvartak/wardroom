# Architecture — wardroom coordination core

One MCP server, three subsystems, all state under `.memo/` in the repo.
This document covers the shipped core; the single-terminal harness built on
top of it is specified in `plan.md`, with diagrams in `diagrams/`.

```
                 ┌────────────────────────────────────────────┐
                 │              wardroom (MCP)                │
                 │                                            │
   Claude Code ──┤  coordination        memory        context │
   Codex       ──┤  ┌───────────┐   ┌────────────┐  ┌───────┐ │
   Gemini CLI  ──┤  │ tasks.ts  │   │writedown.ts│  │context│ │
                 │  │ claims.ts │   │            │  │  .ts  │ │
                 │  │ events.ts │   │            │  └───────┘ │
                 │  └─────┬─────┘   └─────┬──────┘            │
                 │        │               │                   │
                 │     store.ts (locks + atomic writes)       │
                 └────────┼───────────────┼───────────────────┘
                          ▼               ▼
              .memo/tasks.json      .memo/sessions/*.md
              .memo/claims.json     AGENTS.md (generated index)
              .memo/events.ndjson
```

## On-disk layout

```
repo/
├── AGENTS.md                 generated cold-start index (latest writedown + session list)
└── .memo/
    ├── tasks.json            task board: dependency DAG + statuses
    ├── claims.json           active file leases (TTL'd)
    ├── events.ndjson         append-only event stream with seq numbers
    ├── sessions/             one file per writedown — the memory source of truth
    │   └── 2026-07-22T101500-claude.md
    └── *.lock                transient lock directories (mkdir-atomic)
```

Coordination state (`tasks.json`, `claims.json`, `events.ndjson`) is
**ephemeral working state** — gitignoring `.memo/*.json`, `.memo/*.ndjson` is
reasonable. Writedowns and `AGENTS.md` are **durable memory** and belong in
version control.

## Subsystems

### store.ts — the concurrency foundation
Multiple MCP server processes (one per CLI) mutate the same files. Every
mutation runs inside `withLock()`:

- **Lock = a directory created with `mkdir()`** — atomic on all platforms, no
  TOCTOU. Stale locks (crashed process) are broken after 10s; acquisition
  times out at 8s instead of hanging a tool call.
- **Writes are temp-file + `rename()`** — readers never see torn JSON.
- Lock ordering is fixed (`tasks` → `claims` → `events`) so nested
  acquisitions cannot deadlock.

This is the fix for the v0.1 review's top finding (§3.1 in `enhance.md`): the
old line-log did unlocked read-modify-append and corrupted under exactly the
parallel workload the project advertised.

### claims.ts — advisory file leases
`claim_files` / `release_files` / `check_files`. A claim is a set of
paths/globs + holder + reason + expiry. Overlap detection is deliberately
conservative (a false conflict costs a little parallelism; a missed conflict
costs interleaved edits). TTL default 15 min, renewable by re-claiming, so a
dead agent can never wedge the repo. Advisory by design — the same choice
every shipped coordinator made (see `parallelism.md` §1c); git remains the
backstop for uncooperative writers.

### tasks.ts — file-overlap-aware task board
`plan_tasks` / `claim_next_task` / `complete_task` / `fail_task` /
`release_task` / `get_board`. Tasks declare their **file footprint** and
dependencies (`depends_on`, with `$n` positional refs at planning time).
`claim_next_task` atomically picks the first task whose deps are done *and*
whose footprint doesn't overlap another agent's lease — then takes the lease
itself. Scheduling and mutual exclusion are one atomic operation, which is
what makes the parallelism efficient: disjoint tasks flow concurrently,
colliding tasks serialize automatically.

### events.ts — the message bus
Append-only NDJSON with monotonically increasing `seq`. Task lifecycle events
post automatically; agents post free-form heads-ups (`post_event`) and poll
with a cursor (`get_events(since_seq)`) so repeated polls cost O(new). This is
the blackboard channel that worktree isolation lacks: cross-agent decisions
propagate mid-flight instead of surfacing at merge time.

### writedown.ts — durable memory (carried over from v0.1)
User-triggered structured session snapshots (`/writedown` → `write_session`),
one new file per snapshot (concurrency-free by construction), `AGENTS.md`
regenerated as a pure function of the sessions directory. `read_memo` reloads
prior writedowns into a fresh chat.

### context.ts — one-call situational awareness
`get_context` merges: latest writedown (where the project *was*), open tasks
and active claims (what is happening *right now*), recent events (what just
changed). This is the first call every agent makes.

## The harness (Phases 1-3, on top of the core)

- `messages.ts` — directed, threaded agent-to-agent (and agent-to-captain)
  mail; same locked-NDJSON discipline as events.
- `adapters/` — one per CLI (claude/codex/gemini) normalizing headless output
  to a `text`/`tool`/`result`/`usage` event stream; a shared runner enforces
  timeouts and a single terminal result.
- `worker.ts` — the per-agent loop: claim -> prompt (task + context + inbox)
  -> spawn -> stream -> verification gate -> complete/fail.
- `pool.ts` — runs one worker per agent concurrently against the same board.
  No extra concurrency machinery: `claim_next_task` is already atomic, so the
  core arbitrates. Requeues tasks orphaned by a crashed run at startup,
  captures a writedown on exit.
- `renderer.ts` — pure state-to-string views: `renderPool` (live multiplexed
  panes + board + crosstalk + status) and `renderDashboard`/`renderLog`.
- `planner.ts` — invokes the planner agent headlessly with the goal and a
  repo map; parses its JSON task list into a proposed board for the human to
  approve/edit/regenerate before it is committed.
- `git.ts` — footprint telemetry (declared-vs-touched, scoped to each task's
  own footprint so it is attribution-safe under concurrency) and review diffs.
- Cross-agent review (in `worker.ts`/`tasks.ts`): when enabled, a finished
  task is submitted for review by a different agent (status `review`); the
  reviewer approves (-> done) or requests changes (-> reopened with notes,
  capped attempts). A task's author never reviews its own work.
- `guard.ts` — the enforcement hook (`wardroom guard`): reads a tool call on
  stdin and denies edits to files another agent leases. Fail-open by design.
- `compact.ts` — archives old events/messages and terminal tasks under
  `.memo/archive/`, preserving seq/cursor and id-counter invariants. Runs at
  pool start and via `wardroom compact`.
- `presence.ts` — who is active now (heartbeats), shown on the dashboard;
  workers also renew their file lease during long tasks so it can't lapse.
- Token/cost budgets — the pool sums usage events; a cap stops new claims
  (in-flight tasks finish) and the run ends with a writedown.
- `cli.ts` — `plan`/`run "<goal>"` (planner + approve), `run --agents` (pool),
  `watch`, `board`, `log`, `say`, `guard`, `compact`, `mcp`.

## What was removed

`src/memory.ts` — the v0.1 append-only line log (`start_session`,
`append_message`, `read_memory`, `search_memory`, `summarize_session`,
`get_decisions`). It was race-prone (unlocked appends), lossy (flattened
multi-line content), and unparseable under adversarial content — all
documented in `enhance.md` §3. Its three jobs moved to better homes:
durable memory → writedowns; live coordination → tasks/claims/events;
cold-start context → `get_context` + the `AGENTS.md` index.
