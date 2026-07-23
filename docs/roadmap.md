# Roadmap

The authoritative delivery plan — phases, deliverables, acceptance criteria,
risks — lives in [plan.md](plan.md), with the timeline diagram in
`diagrams/roadmap.png`.

Summary:

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Coordination core: locked store, task board, file leases, event bus, writedown memory | Shipped |
| P1 | Directed agent messaging (threads, questions, captain) and the CLI skeleton: `wardroom watch\|board\|log\|say\|mcp` | Shipped |
| P2 | Adapters for claude/codex/gemini and the single-worker headless loop (`wardroom run`) | Shipped |
| P3 | Multi-agent live sessions: concurrent worker pool, multiplexed renderer, crash recovery, exit writedown | Shipped |
| P4 | Planner mode (`plan/run "<goal>"`), cross-agent review, footprint-drift telemetry | Shipped |
| P5 | Hardening: enforcement guard, lease heartbeats + presence, log/board compaction, token budgets, 1.0 package | Shipped |
| P6 | Interactive conductor console: directed assignment, `delegate_task`, keep-alive session, conductor, `wardroom` REPL, `crew` | Shipped |
| P7 | Change transparency: per-task change records (files, +/-, diff) surfaced via `changes` / `show` / board / writedown — stay in sync with the crew without gating autonomy | Shipped |

## History

- v0.1 was `multi-agent-memo`: a shared append-only `AGENTS.md` line log.
  Replaced — the post-mortem of its defects is in `../enhance.md`.
- The v0.1 writedown layer (session snapshots, generated `AGENTS.md` index)
  survives unchanged as wardroom's memory subsystem.
- The web UI / tunnel concept in `idea.md` is retired; wardroom is
  terminal-only by design (see non-goals in `plan.md`).
