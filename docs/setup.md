# Setup & Wiring Guide

## Install

```bash
npm install -g wardroom    # or use npx wardroom without installing
```

From a clone: `npm install && npm run build`, then the server is
`node dist/index.js`.

Requires Node >= 22.

## Wire into Claude Code

**Step 1 — Register the MCP server** in your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "wardroom": {
      "command": "npx",
      "args": ["wardroom", "mcp"]
    }
  }
}
```

**Step 2 — Cold-start injection (optional).** A `UserPromptSubmit` hook
injects the latest writedown before every prompt:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/node_modules/wardroom/scripts/inject-memory.sh\""
          }
        ]
      }
    ]
  }
}
```

(Adjust the path if you installed globally or run from a clone — the script is
`scripts/inject-memory.sh` in the package.)

**Step 3 — Copy `CLAUDE.md`** from this repo into your project root. It
teaches Claude the shared-checkout protocol (claim before edit, pull tasks
atomically, announce changes).

## Wire into Codex

Codex CLI natively reads `AGENTS.md` at the project root, so it cold-starts
from the generated index automatically. Register the MCP server for
coordination and write-back — in `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "wardroom": {
      "command": "npx",
      "args": ["wardroom", "mcp"]
    }
  }
}
```

Add the protocol rules from `docs/protocol.md` to your `AGENTS.md`-adjacent
instructions if you want Codex to follow the claim/task discipline strictly.

## Wire into Gemini CLI

Register the server in `~/.gemini/settings.json` (same JSON as above) and
copy `GEMINI.md` from this repo into your project root.

## Usage Pattern

```
1. Join         get_context(repo_path="/your/project")
2. Plan once    plan_tasks(repo_path=..., agent="claude", tasks=[
                  { "title": "Define shared types", "files": ["src/types.ts"] },
                  { "title": "Build API",           "files": ["src/api/**"],  "depends_on": ["$0"] },
                  { "title": "Build UI",            "files": ["src/ui/**"],   "depends_on": ["$0"] }
                ])
3. Work loop    claim_next_task → edit → complete_task   (each agent, repeatedly)
4. Ad-hoc edit  claim_files → edit → release_files
5. Announce     post_event(..., type="heads-up", message="renamed X → Y")
6. Catch up     get_events(since_seq=<cursor>)
7. End of day   /writedown  → write_session
```

See `docs/protocol.md` for the full rules and `docs/architecture.md` for how
it works underneath.

## Available Tools

| Tool | Purpose |
|------|---------|
| `get_context` | One-call snapshot: latest writedown + board + claims + events |
| `plan_tasks` | Add tasks with file footprints and dependencies |
| `claim_next_task` | Atomically pull the next runnable, non-conflicting task |
| `complete_task` / `fail_task` / `release_task` | Finish or return a task; releases its leases |
| `get_board` | Render the full task board |
| `claim_files` / `release_files` / `check_files` | Advisory TTL file leases |
| `post_event` / `get_events` | Broadcast + cursor-poll the shared event stream |
| `send_message` / `get_messages` | Directed, threaded messages between agents and the captain |
| `write_session` | Capture a structured session writedown (`/writedown`) |
| `read_memo` | Reload prior writedowns into a fresh chat (`/readmemo`) |

## The wardroom CLI

The same package installs the `wardroom` command for the human:

```
wardroom           start the interactive conductor console (single terminal):
                   command the crew conversationally; it dispatches your agents
wardroom crew      list configured agents and check each is installed
wardroom watch     live dashboard (board, claims, crosstalk, events)
wardroom board     print the task board and exit
wardroom changes   what each task changed (files, +/-)
wardroom show <t>  a task's change summary and full diff
wardroom log -f    merged events + messages timeline, follow mode
wardroom say "<msg>" [--to agent] [--kind question|info] [--thread N]
wardroom plan "<goal>" [--yes]  |  wardroom plan --from FILE
                   planner agent decomposes a goal into a board (approve/edit
                   /regenerate), or commit an edited plan
wardroom run --agents A[,B,...] ["<goal>"] [--max-tasks N] [--no-tty]
                   run a pool of headless workers (one per agent) against the
                   shared board; with a goal, plan+approve first
wardroom mcp       the stdio MCP server (what the CLI configs invoke)
```

Run them from the repo root; state lives in `./.memo/`. Typical setup: your
agent CLIs in their own terminals, `wardroom watch` in one more.

## wardroom.json

A ready-to-edit **starter `wardroom.json` ships at the repo root** — it wires a
`claude` conductor plus a `codex` teammate. Copy it into your own project and
adjust the binaries/flags. Run `wardroom crew` to confirm both are installed
and authenticated, then `wardroom` to start the console.

Two things to check for real use:
- **Claude** is set to `--permission-mode acceptEdits` so it can edit
  headlessly. Use a stricter mode (or a sandbox) if you prefer.
- **Codex**: `codex exec --json` is the baseline; depending on your Codex
  version you may need to add its auto-approve/sandbox flag so it applies edits
  without prompting. A worker whose CLI stalls on approval is killed at the
  timeout.

Full field reference — override binaries, flags (including each CLI's
permission/sandbox flags), the verification gate, and the per-task timeout:

```json
{
  "agents": {
    "claude": {
      "adapter": "claude",
      "bin": "claude",
      "args": ["-p", "--output-format", "stream-json", "--verbose",
               "--permission-mode", "acceptEdits"]
    }
  },
  "verify": "npm test",
  "taskTimeoutMinutes": 20,
  "review": "off",
  "planner": "claude"
}
```

- `review`: `"off"` (default) completes tasks directly; `"changed-files"`
  reviews tasks that touched files; `"all"` reviews every task. A finished
  task is reviewed by a *different* agent before it counts as done — so
  review needs 2+ agents in the run, and an author never reviews its own work.
- `planner`: which agent decomposes goals in `wardroom plan`/`run "<goal>"`.
- `conductor`: the lead you talk to in the interactive console; it interprets
  your commands into board tasks. Defaults to `planner` if unset. The `agents`
  you list are the crew — only those are dispatched (no others are injected).
- `budget`: `{ "tokens": N, "usd": N }` per-session cap. When either is
  reached, workers stop claiming new tasks (in-flight tasks finish) and the
  run ends with a writedown. Omit for no cap.

## Enforcement (optional)

Leases are advisory by default — cooperating agents check before editing. To
*enforce* them for an interactive Claude Code session, add a `PreToolUse` hook
that runs the guard before every edit. It blocks edits to files another agent
has leased. In that project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "npx wardroom guard --agent claude" }
        ]
      }
    ]
  }
}
```

Set `--agent` to this session's agent name (or export `WARDROOM_AGENT`). The
guard fails open: any error allows the edit, so a guard bug can never wedge a
session. Headless pool runs enforce leases structurally already (atomic
claims), so the hook is for interactive sessions.

## Housekeeping

`wardroom run` compacts the working logs automatically at the start of each
run. To compact on demand, `wardroom compact` archives old events, messages,
and terminal tasks under `.memo/archive/`, keeping a recent tail live.

`verify` runs after every file-touching task; the task only counts as done
if the command passes — completion is gated on verification, not on the
model claiming success. Agent CLIs must be authenticated and configured to
run non-interactively (each CLI's own permission flags go in `args`); a
worker whose CLI stalls on an approval prompt is killed at the timeout.
