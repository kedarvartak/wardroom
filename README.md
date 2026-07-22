# wardroom

One terminal harness for parallel AI coding agents on one checkout.

Claude Code, Codex, and Gemini CLI plan together, talk to each other, and
build simultaneously in the same working tree. No worktrees. No merge
conflicts. You watch the whole crew from a single terminal and steer it.

![npm](https://img.shields.io/npm/v/wardroom?style=flat-square&color=black)
![license](https://img.shields.io/npm/l/wardroom?style=flat-square&color=black)
![node](https://img.shields.io/node/v/wardroom?style=flat-square&color=black)
![mcp](https://img.shields.io/badge/MCP-compatible-black?style=flat-square)

The wardroom is the room on a warship where officers meet, plan, and
coordinate the running of the ship. One ship, one crew, one table.

---

## Why this exists

The standard answer to parallel coding agents is isolation: a git worktree,
branch, or container per agent. That works only when tasks have clean
separation of concerns. The moment tasks touch overlapping files, isolation
does not prevent the conflict — it defers it to merge time, where context is
worst. Empirical studies of agent-authored pull requests put merge-conflict
rates at 27 to 42 percent for co-active work, and the standard remedy is a
human merging branches one at a time — re-serializing the parallelism by
hand.

Subagents inside a single tool do not solve it either: isolated contexts, no
agent-to-agent communication, results funneled through one orchestrator, and
roughly 15x token cost. They are a map-reduce over reads, not a team of
writers.

Wardroom takes the third path: a shared checkout with real coordination.
Conflicts are prevented before the edit instead of merged after. The full
research with sources is in [docs/parallelism.md](docs/parallelism.md).

## How it works

![Architecture](docs/diagrams/architecture.png)

Three layers, all state in plain files under `.memo/` in your repo:

1. **Coordination core** (shipped). A dependency-aware task board where
   every task declares the files it will touch; `claim_next_task` atomically
   hands an agent the next task whose dependencies are done and whose files
   nobody else holds, then leases those files. Advisory TTL file leases for
   ad-hoc edits. A cursor-pollable event bus for broadcasts. Disjoint tasks
   run truly in parallel; colliding tasks serialize automatically.

2. **Memory** (shipped). Structured session writedowns captured on demand;
   `AGENTS.md` is regenerated as the cold-start index every agent reads
   first. A fresh session resumes where the last one stopped.

3. **The harness** (in development, see the plan). A single `wardroom` CLI
   that spawns each agent CLI as a headless worker, gives agents directed
   messaging so they can ask each other questions and announce changes, and
   renders everything live in one terminal: the board, each agent's work
   stream, and the crosstalk between them.

![Session flow](docs/diagrams/session-flow.png)

## Current state

Shipped today: the coordination core, memory, agent-to-agent messaging, and
the harness bridge — a pool of headless agents draining one board
concurrently, rendered live in a single terminal.

```
wardroom plan "add JWT auth with refresh tokens"
                   a planner agent decomposes the goal into a file-scoped
                   task board; you approve, edit, or regenerate it
wardroom run --agents claude,codex,gemini ["<goal>"]
                   run one worker per agent against the board (plan first if
                   a goal is given); optional cross-agent review before done
wardroom watch     live dashboard for interactive (MCP) sessions
wardroom board     print the task board
wardroom log -f    merged events + messages timeline, follow mode
wardroom say "answer" --to claude --thread 4
                   reply to an agent's question as the captain
wardroom mcp       the stdio MCP server the agent CLIs connect to
```

`wardroom run` shows the whole crew at once — a pane per agent, the shared
board, and the crosstalk between them:

```
WARDROOM  myrepo  3 agents  elapsed 02:14

-- board  5/5 done -------------------------------------------------------
  x1  x2  x3  x4  x5

-- claude  working task-2: api -----------------------------------
  Editing src/api.ts
  Ran npm test -- api (12 passed)
  1 done, 0 failed, 1840 tok
-- codex  verifying task-3: ui -----------------------------------
  Reading src/ui.ts
  Wrote src/ui.ts
  1 done, 0 failed, 2210 tok
-- gemini  working task-4: docs ----------------------------------
  Writing docs/x.md

-- crosstalk -------------------------------------------------------------
  codex -> claude [question] does task-1 rename the User type?  (t1)
  claude -> codex yes, it is now Account  (t1)
  claude -> captain [question] keep a legacy alias for User?  (t3)

-- status ----------------------------------------------------------------
  3 working | 5/5 done | 1 question(s) for you — reply: wardroom say ...
```

Agents pull tasks atomically (disjoint files run in parallel, colliding
files serialize), ask each other questions and answer in threads, and
escalate decisions to you by addressing `captain`. With review enabled
(`"review": "all"` in `wardroom.json`), a finished task is checked by a
different agent before it counts as done — a caught bug reopens the task with
the reviewer's notes and the crew fixes it, no operator needed. Tasks
orphaned by a crashed run are recovered on the next run, and footprint drift
(declared-but-untouched files) is reported to sharpen future planning. What
remains is hardening for 1.0 — Phase 5 of [docs/plan.md](docs/plan.md).

![Roadmap](docs/diagrams/roadmap.png)

## Tools (MCP surface)

| Tool | Purpose |
|------|---------|
| `get_context` | One call: latest writedown, task board, claims, recent events |
| `plan_tasks` | Create tasks with file footprints and dependencies |
| `claim_next_task` | Atomically pull the next runnable, non-conflicting task |
| `complete_task` / `fail_task` / `release_task` | Finish or return work; releases leases |
| `get_board` | Render the full task board |
| `claim_files` / `release_files` / `check_files` | Advisory TTL file leases |
| `post_event` / `get_events` | Broadcast and cursor-poll the shared event stream |
| `send_message` / `get_messages` | Directed, threaded agent-to-agent (and agent-to-captain) mail |
| `write_session` / `read_memo` | Durable session writedowns |

## Install and wire

```bash
npm install -g wardroom    # or npx wardroom
```

Register the MCP server in each CLI (Claude Code `.claude/settings.json`,
Codex `~/.codex/config.json`, Gemini `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "wardroom": { "command": "npx", "args": ["wardroom", "mcp"] }
  }
}
```

Copy `CLAUDE.md` and `GEMINI.md` from this repo into your project root;
Codex reads the generated `AGENTS.md` natively. Full wiring, including the
optional cold-start injection hook, is in [docs/setup.md](docs/setup.md).

## Documentation

| Document | Contents |
|----------|----------|
| [docs/plan.md](docs/plan.md) | Product plan: vision, harness architecture, phases, acceptance criteria, risks |
| [docs/parallelism.md](docs/parallelism.md) | Research: worktrees vs subagents vs shared-checkout coordination, with sources |
| [docs/architecture.md](docs/architecture.md) | Coordination core internals: subsystems, on-disk layout, concurrency design |
| [docs/protocol.md](docs/protocol.md) | The rules agents follow on a shared checkout |
| [docs/setup.md](docs/setup.md) | Wiring guide for each CLI |

## Development

```bash
git clone https://github.com/kedarvartak/wardroom
cd wardroom
npm install

npm run build   # compile TypeScript to dist/
npm test        # Node 22 native test runner, incl. multi-process concurrency tests
npm start       # start the MCP server over stdio
```

## License

MIT
