
<div align="center"><pre>
```                    _
__      ____ _ _ __ __| |_ __ ___   ___  _ __ ___
\ \ /\ / / _` | '__/ _` | '__/ _ \ / _ \| '_ ` _ \
 \ V  V / (_| | | | (_| | | | (_) | (_) | | | | | |
  \_/\_/ \__,_|_|  \__,_|_|  \___/ \___/|_| |_| |_|
```
</pre>

![wardroom demo](docs/demo.gif)

Claude Code and Codex run themselves in one terminal, in parallel, on the
same working tree — no worktrees, no merge step. You command a conductor;
it dispatches the crew on a live task board; the agents delegate, question,
and review each other as they go. Every task records exactly what it
changed, so you stay in sync without gating the autonomy.



## Why

Two subscriptions, one checkout. The rest of the field gives each agent an
isolated worktree (deferring conflicts to merge time) or spawns same-vendor
subagents that never talk to each other. Wardroom is the third path: a
shared checkout with real coordination — file leases prevent conflicts
before the edit, a shared board schedules disjoint work in parallel, and
directed messages let a Claude and a Codex integrate continuously instead
of colliding at the end. When and why that beats a single agent — and when
it does not — is argued honestly in
[docs/why-parallel.md](docs/why-parallel.md).

## Quickstart

```bash
npm install -g wardroom
cd your-repo
cp path/to/wardroom.json .   # starter config: claude conductor + codex
wardroom crew                # check each agent is installed and authed
wardroom                     # the conductor console
```

```
$ wardroom
WARDROOM — conductor ready. Crew: claude, codex.
wardroom> add a /login endpoint with JWT, and tests for it
  task-1 login endpoint + JWT  @claude
  task-2 tests for /login      @codex
codex -> claude  your /login 500s on a missing password; filed task-3
wardroom> also rate-limit login to 5/min      # keep commanding, live
```

## Commands

| Command | What it does |
|---------|--------------|
| `wardroom` | Conductor console: command the crew conversationally, watch them work |
| `wardroom run --agents claude,codex ["<goal>"]` | Non-interactive: plan and drain a board, for CI or overnight runs |
| `wardroom changes` / `show <task>` | The receipts: what each task changed, and the full diff |
| `wardroom stats` | Parallelism report: realized speedup, per-agent utilization, ready-wait per task, critical path |
| `wardroom crew` | Roster check: installed, authenticated, ready |
| `wardroom board` / `log` / `say` / `watch` | Inspect the board, tail events, message the crew, live dashboard |
| `wardroom memory` | The crew's shared brief: decisions, conventions, gotchas — injected into every prompt, verified so it can't rot; `pin` / `forget` / `--add` to curate |
| `wardroom guard` / `compact` / `mcp` | Lease enforcement hook, log compaction, the MCP server itself |

Inside the console, slash commands give total runtime control — changes go
live immediately (no restart) and persist to `wardroom.json`:

```
/add claude-2         hire another agent mid-session (vendor inferred from the name)
/drop codex           stand one down — it finishes in-flight work first
/conductor claude     choose who interprets your commands and plans
/review all           off | changed-files | all
/budget 500k          spend cap: 500k / 2m / $5 / off — crew stands down when hit
/verify npm test      completion gate: tasks touching files must pass it
/stats  /crew  /say  /help  /quit
```

All coordination state lives in plain files under `.memo/` in your repo.
Agents connect through the `wardroom` MCP server (`get_context`,
`plan_tasks`, `claim_next_task`, `send_message`, ...) — wiring for each CLI
is in [docs/setup.md](docs/setup.md).

## Documentation

| Document | Contents |
|----------|----------|
| [docs/why-parallel.md](docs/why-parallel.md) | The thesis: when parallel agents beat one agent, the four use cases, what we build next |
| [docs/plan.md](docs/plan.md) | Product plan: architecture, phases, acceptance criteria, risks |
| [docs/differentiation.md](docs/differentiation.md) | Landscape research: the field, what developers want, wardroom's position |
| [docs/unsolved-issues.md](docs/unsolved-issues.md) | Recovery, cost, verification, memory — architecture and phased plan |
| [docs/parallelism.md](docs/parallelism.md) | Worktrees vs subagents vs shared-checkout coordination, with sources |
| [docs/architecture.md](docs/architecture.md) | Coordination core internals: subsystems, on-disk layout, concurrency |
| [docs/protocol.md](docs/protocol.md) | The rules agents follow on a shared checkout |
| [docs/setup.md](docs/setup.md) | Wiring guide for each CLI |

## Development

```bash
git clone https://github.com/kedarvartak/wardroom
cd wardroom && npm install
npm test        # Node 22 native test runner, incl. multi-process concurrency tests
npm run build   # compile TypeScript to dist/
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
