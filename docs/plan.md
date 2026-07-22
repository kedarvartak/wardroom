# Wardroom — Product Plan

One terminal. Multiple coding agents (Claude Code, Codex, Gemini CLI) working
the same checkout, talking to each other, coordinating work — and you watch it
happen live and steer it.

This document is the build plan: vision, architecture, workstreams, phased
delivery with acceptance criteria, risks. Diagrams referenced here live in
`docs/diagrams/`.

Status: Phases 0-4 complete — core, messaging, the `wardroom` CLI, all three
adapters, the concurrent worker pool with a live multiplexed view, plus
planner mode (`wardroom plan/run "<goal>"`), cross-agent review, and
footprint-drift telemetry. Phase 5 (hardening + 1.0) planned. Last updated
2026-07-22.

---

## 1. Vision

Today, running Claude + Codex + Gemini in parallel means three terminals,
three harnesses, and a human alt-tabbing between them as the message bus.
The v0.2 coordination core (task board, file leases, event bus over MCP)
makes parallel work on one checkout safe — but the operator experience is
still fragmented, and agents only coordinate *implicitly* through board state.

Wardroom collapses this into a single CLI harness:

- You state a goal. A planner agent decomposes it into a file-scoped task
  board you can edit and approve.
- Wardroom spawns each agent CLI headlessly as a worker. Workers pull tasks
  atomically, so two agents never collide on a file.
- Agents send each other directed messages — questions, heads-ups, review
  requests — and answer each other. You see the conversation as a live
  crosstalk feed, alongside each agent's work stream.
- You can interject at any moment: pause a worker, answer a question an agent
  asked, add a task, reassign work.

The product principle: **the terminal is the bridge of the ship.** Everything
visible, everything steerable, nothing graphical. Plain text, ANSI panes,
scrollback-friendly, works over ssh.

## 2. What exists (Phase 0, shipped)

The coordination core, exposed over MCP for interactive CLI sessions:

- `store.ts` — mkdir-atomic locks, stale-lock recovery, atomic JSON writes.
- `tasks.ts` — dependency plus file-overlap-aware board; `claim_next_task`
  is an atomic pull that also leases the task's files.
- `claims.ts` — advisory TTL file leases with conservative glob overlap.
- `events.ts` — cursor-pollable NDJSON broadcast stream.
- `writedown.ts` — durable session memory; `AGENTS.md` generated index.
- 18 tests including multi-process concurrency.

Everything below builds on this core without replacing it. The MCP surface
stays: interactive sessions (a human driving Claude Code by hand) and
wardroom-driven headless workers share the same board, leases, and bus.

## 3. Architecture

See `diagrams/architecture.png`.

```
wardroom CLI (one process, one terminal)
|
|-- conductor/          session controller
|     goal intake -> planner -> board approval -> worker pool -> completion
|
|-- adapters/           one per agent CLI
|     claude.ts         claude -p --output-format stream-json
|     codex.ts          codex exec --json
|     gemini.ts         gemini -p (stream parsing)
|     adapter contract: spawn(task, context) -> AsyncIterable<AgentEvent>
|
|-- coordination/       the v0.2 core (board, claims, events) plus
|     messages.ts       NEW: directed agent-to-agent messages with threads
|
|-- renderer/           terminal presentation, no GUI
|     panes: board | per-agent work streams | crosstalk feed | status bar
|     also: plain --no-tty mode that interleaves labeled lines for CI/logs
|
|-- mcp/                existing stdio MCP server (wardroom mcp)
```

### 3.1 The conductor

A state machine per session:

1. **Intake.** `wardroom run "<goal>"` or `wardroom plan "<goal>"`.
2. **Planning.** The configured planner agent (default: claude) is invoked
   headlessly with the goal, repo map, and planning instructions; it emits a
   task list with file footprints and dependencies via `plan_tasks`. Wardroom
   renders the proposed board; the user approves, edits, or regenerates.
   Nothing executes before approval.
3. **Execution.** One worker per configured agent. Worker loop:
   `claim_next_task` -> assemble prompt (task, `get_context`, unread
   messages) -> spawn adapter -> stream events to renderer -> on exit, run
   the verification gate -> `complete_task` or `fail_task`. Repeat until the
   board drains or the user stops.
4. **Review (Phase 4).** Completed tasks can require a second agent's
   review before counting as done: the reviewer gets the task diff and
   result, replies approve or request-changes as a message; request-changes
   reopens the task with the review attached.
5. **Writedown.** On session end, the conductor writes the session summary
   via `write_session` so the next session cold-starts warm.

### 3.2 Inter-agent messaging (the new primitive)

Broadcast events (Phase 0) are a public-address system; conversation needs
direct mail. `messages.ts` adds, in the same locked-NDJSON style as events:

- `send_message(from, to, body, thread_id?, kind)` — kind is one of
  `question` (expects a reply), `info` (fire-and-forget), `review-request`,
  `review-reply`. `to` may be an agent name or `captain` (the user).
- `get_messages(agent, unread_only)` — inbox with cursor semantics.
- Threading: replies carry the originating `thread_id`, so the renderer can
  show conversations, not interleaved fragments.

Delivery to a headless worker: the conductor injects unread messages into
the worker's next prompt (between tasks), or — for a `question` addressed to
an agent mid-task — queues it for that worker's next turn. A `question` with
`blocking: true` pauses the asker's task until the reply arrives, with a
timeout that falls back to the captain.

Messages to `captain` surface in the crosstalk pane highlighted; the user
answers with `wardroom say --to <agent> "<reply>"` (or inline in the live
view). This is how "agent asks, human decides" works without breaking flow.

### 3.3 Adapters and the normalized event stream

Each CLI has a headless mode with structured output. Adapters normalize to:

```
AgentEvent =
  | { kind: "text";      text }         assistant narration
  | { kind: "tool";      name, detail } tool/file activity (Edit src/api.ts)
  | { kind: "result";    ok, summary }  terminal event of the invocation
  | { kind: "usage";     tokens, cost } if the CLI reports it
```

Adapter contract requirements: pass-through of permission configuration
(each CLI's own sandbox/approval flags, configured once in `wardroom.json`),
a hard wall-clock timeout per task, and kill-on-demand so the user can stop
a runaway worker. Adapters are the only code that knows CLI-specific flags;
everything above them is agent-agnostic — adding a fourth CLI is one file.

### 3.4 The renderer

Live mode (TTY): alternate-screen terminal layout, redrawn incrementally.

```
+-- board ------------------+-- claude ------------------------------+
| done    task-1 API        | Editing src/api/routes.ts              |
| active  task-2 UI  codex  | Ran: npm test -- api  (12 passed)      |
| active  task-4 docs claude+-- codex -------------------------------+
| ready   task-3 wiring     | Reading src/ui/App.tsx                 |
| blocked task-5 (task-3)   | Q -> claude: "did task-1 rename        |
|                           |    /auth/refresh? my calls 404"        |
+-- crosstalk --------------+----------------------------------------+
| codex  -> claude   Q: did task-1 rename /auth/refresh?             |
| claude -> codex    R: yes, now POST /auth/token/refresh            |
| claude -> captain  Q: drop the legacy route or keep an alias?      |
+-- status ----------------------------------------------------------+
| 2 workers active | 1 question for you | tokens 41k | elapsed 12:40 |
+--------------------------------------------------------------------+
```

Design rules: crosstalk is a first-class pane, never buried in per-agent
logs; questions to the captain are impossible to miss; every pane is dumb —
it renders coordination state and adapter streams, holds no logic. A
`--no-tty` mode emits the same information as labeled interleaved lines
(`[codex->claude] ...`) so sessions are loggable and CI-friendly.

### 3.5 CLI surface

```
wardroom init                 scaffold wardroom.json, .memo/, agent instructions
wardroom crew                 list/configure agents (bin, flags, role, planner)
wardroom plan "<goal>"        plan the board only; print for approval/editing
wardroom run ["<goal>"]       plan (if goal given) + approve + execute, live view
wardroom board                print the board and exit
wardroom log [--follow]       events + messages, plain text
wardroom say "<msg>" [--to a] inject a captain message (answer questions, steer)
wardroom stop [agent|task]    stop a worker or the session cleanly
wardroom watch                read-only live view (during manual MCP sessions)
wardroom mcp                  stdio MCP server (current default behavior)
```

`wardroom.json` (repo root): agents (bin, args, permission flags, role),
planner choice, verification command (e.g. `npm test`), token budget,
review policy (off | changed-files | all).

## 4. Delivery plan

Sequencing rule: each phase ships something usable on its own; live
visibility arrives before autonomy, so trust is built up in steps. Timeline
view: `diagrams/roadmap.png`.

### Phase 1 — Messages and visibility (foundation)

The bus becomes a conversation medium and gets a window.

Deliverables
- `messages.ts`: directed messages, threads, kinds, blocking semantics;
  MCP tools `send_message` / `get_messages`; `get_context` includes unread
  message count per agent.
- CLI skeleton: `wardroom mcp | board | log | say | watch`; `wardroom watch`
  renders board, claims, crosstalk, events live from `.memo/` file watching.
- Protocol docs updated: interactive agents told to check messages and how
  to address each other and the captain.

Acceptance criteria
- Two interactive CLI sessions (e.g. Claude Code and Codex, driven by hand)
  exchange a question and reply through `send_message`, threaded correctly.
- `wardroom watch` in a third terminal shows the exchange within 1s, plus
  live board and lease changes, with no MCP connection of its own.
- Multi-process message tests in the style of the events concurrency test.

### Phase 2 — Adapters and the single-worker loop

One agent runs headlessly end to end. Proves the execution spine.

Deliverables
- Adapter contract plus `claude.ts` adapter (stream-json parsing, timeout,
  kill, permission pass-through); `codex.ts` and `gemini.ts` following it.
- Worker loop: claim -> prompt assembly (task + context + inbox) -> spawn ->
  stream -> verification gate (configured command) -> complete/fail.
- `wardroom run --agents claude` executes an approved board serially with
  live output through the renderer's single-pane mode.

Acceptance criteria
- A 3-task board with dependencies drains correctly with one worker; a
  failing verification command flips the task to failed with the log
  attached; a wall-clock timeout kills the CLI and releases leases.
- Adapter unit tests run against recorded CLI output fixtures (no network,
  no real agent invocations in CI).

### Phase 3 — The full bridge (multi-agent live sessions)

The headline experience: agents working simultaneously, visibly.

Deliverables
- Worker pool: one worker per configured agent, concurrent claims against
  the shared board (the Phase 0 atomic claim already arbitrates).
- Message injection into worker prompts; blocking questions pause and
  resume tasks; captain questions surface in the live view and `say`
  answers route back.
- Full multiplexed renderer (board, N agent panes, crosstalk, status) plus
  `--no-tty` interleaved mode.
- Session writedown on exit.

Acceptance criteria
- Demo scenario on a sample repo: goal decomposed to 5+ tasks, three agents
  drain it concurrently; at least one agent-to-agent question/reply and one
  captain question occur and render in crosstalk; zero file collisions;
  final board all done; total wall-clock under the serial baseline.
- Kill -9 of one worker mid-task: leases expire, task returns to the board,
  another worker completes it, session finishes clean.

### Phase 4 — Planning quality and cross-agent review

From "executes a board" to "plans well and checks its own work."

Deliverables
- Planner mode: repo-map assembly, planning prompt, board proposal with
  footprints and dependencies, interactive approve/edit/regenerate.
- Review policy: completed tasks fan out as `review-request` to a different
  agent with the diff; approve closes, request-changes reopens with notes.
- Footprint accuracy telemetry: at task completion, compare declared files
  against actually-modified files (git status delta); surface drift in the
  status pane and session writedown — this is the input for better planning
  prompts.

Acceptance criteria
- Planner-produced boards on three sample repos need no manual footprint
  fixes in the demo scenarios; declared-vs-actual drift under 20 percent.
- A seeded bug in one task's output is caught by a reviewing agent and the
  reopen-fix-approve loop completes without operator intervention.

### Phase 5 — Hardening and 1.0

Deliverables
- Optional enforcement: a PreToolUse hook for Claude Code (and equivalents
  where supported) that blocks edits to files leased by another agent —
  advisory becomes opt-in enforced for interactive sessions.
- Lease heartbeats from workers; presence in the status pane.
- Board archival and event/message log compaction past size thresholds.
- Token/cost budget: per-session cap, per-agent display, stop-at-budget.
- npm publish as `wardroom` 1.0; docs site-quality README and guides.

Acceptance criteria
- A 2-hour, 30+ task soak session stays under memory/CPU budgets with logs
  compacted; enforcement hook demonstrably blocks a conflicting edit;
  budget stop triggers cleanly mid-session with a coherent writedown.

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Headless permission models differ per CLI and change between releases | Workers stall on approval prompts or run over-privileged | Permission flags live only in adapters and `wardroom.json`; adapters fail loudly on unexpected prompts; document a recommended sandbox profile per CLI |
| CLI output formats drift (stream-json shape changes) | Adapter breakage | Fixture-based adapter tests; version-pin detection with a clear "adapter needs update" error, not silent garbage |
| Token cost of always-on multi-agent sessions | Expensive sessions | Per-session budget (Phase 5), planner encouraged to keep boards small, workers idle (not polling an LLM) when the board is empty |
| Shared runtime contention: two workers running the full test suite collide on ports/artifacts | Flaky verification | Verification gate serialized through a `build/` virtual lease by default; per-task scoped test commands encouraged |
| Agents ignore the messaging protocol (headless prompt drift) | Coordination degrades to Phase 0 implicit-only | Protocol lives in the prompt the conductor assembles (not agent memory); footprint/message compliance is telemetry in Phase 4 |
| Blocking questions deadlock (A waits on B, B waits on A) | Stalled session | Blocking questions carry timeouts; on timeout, escalate to captain; conductor detects wait cycles and escalates immediately |
| Prompt injection via repo content spreading between agents through messages | One compromised agent steers others | Messages are rendered as data with provenance in prompts ("codex says: ..."); destructive actions remain gated by each CLI's own permission layer |

## 6. Explicit non-goals

- No GUI, no web UI, no browser. The earlier tunnel/web concept
  (`docs/idea.md`) is retired; `idea.md` is kept as history only.
- No cross-machine orchestration in 1.0. One machine, one checkout.
- No custom agent runtime: wardroom drives the official CLIs, it does not
  reimplement them or proxy their model APIs.
- No mandatory OS-level file locking; enforcement remains opt-in hooks.

## 7. Success metrics

- Time-to-drain a standard 6-task board with 3 agents vs one agent serially
  (target: at least 2x wall-clock improvement on disjoint boards).
- File collisions per session (target: zero with cooperating agents).
- Captain interruptions per session (questions answered via `say`) — a
  measure of autonomy quality; should fall phase over phase.
- Declared-vs-actual footprint drift (target: under 20 percent by Phase 4).
- Sessions ending with a writedown (target: 100 percent of `run` sessions).
