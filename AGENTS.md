---
format: 1
project: wardroom
created: 2026-05-31
---

# Agent Memory

## Session: 2026-07-22

### claude — architect
**claude** — v0.2 restructure on branch manual-writedown-memory: pivoted the project from shared-memory-only to a shared-checkout coordination server for parallel agents WITHOUT worktrees. #decision Removed legacy src/memory.ts line-log (race-prone, per enhance.md §3). Added src/store.ts (mkdir-atomic locks + atomic writes), claims.ts (TTL file leases with conservative glob overlap), tasks.ts (dependency+file-overlap-aware board with atomic claim_next_task), events.ts (cursor-pollable NDJSON bus), context.ts (unified get_context). Kept writedown.ts. New docs: parallelism.md (research w/ sources), architecture.md, protocol.md; rewrote README/CLAUDE.md/GEMINI.md/setup.md/roadmap.md. Fixed package.json self-dependency; bumped 0.2.0. 18/18 tests incl. multi-process concurrency. Restart MCP clients to pick up the new tool set. #todo publish 0.2.0 to npm.

### claude — architect
**claude** — Project rebranded: multi-agent-memo is now WARDROOM (npm name free, GitHub repo renamed to kedarvartak/wardroom, old URLs redirect). #decision Product pivot: single-terminal CLI harness (no GUI) that spawns Claude/Codex/Gemini as headless workers on one checkout, with directed agent-to-agent messaging (questions/replies/reviews, threaded) rendered as a live crosstalk feed beside the board and per-agent streams. Full PM plan in docs/plan.md (phases P1-P5 with acceptance criteria, risks, non-goals); diagrams in docs/diagrams/ (architecture, session-flow, roadmap). README rewritten, no emojis, banner removed. Local folder is still named multi-agent-memo — rename it manually when convenient. #todo Phase 1 next: messages.ts + wardroom watch.
