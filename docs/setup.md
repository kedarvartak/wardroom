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
wardroom watch     live dashboard (board, claims, crosstalk, events)
wardroom board     print the task board and exit
wardroom log -f    merged events + messages timeline, follow mode
wardroom say "<msg>" [--to agent] [--kind question|info] [--thread N]
wardroom mcp       the stdio MCP server (what the CLI configs invoke)
```

Run them from the repo root; state lives in `./.memo/`. Typical setup: your
agent CLIs in their own terminals, `wardroom watch` in one more.
