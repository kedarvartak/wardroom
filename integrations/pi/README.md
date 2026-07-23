# wardroom × pi

Make a [pi](https://pi.dev) session a first-class member of a wardroom crew:
same board, same file leases, same crew mail as the headless Claude/Codex
workers `wardroom` runs in another terminal.

## Install

```bash
npm install wardroom          # in your project
mkdir -p .pi/extensions
cp node_modules/wardroom/integrations/pi/wardroom-pi.ts .pi/extensions/
```

pi loads extensions via jiti — no build step. Set `WARDROOM_AGENT` to name
the pi seat (defaults to `pi`), and add it to the roster in `wardroom.json`
if you want the conductor to be able to direct tasks at it.

## What it adds

| Layer | Mechanism | Effect |
|-------|-----------|--------|
| Tools | `registerTool` | `wardroom_context`, `wardroom_claim_next`, `wardroom_complete` / `wardroom_fail`, `wardroom_plan`, `wardroom_send` / `wardroom_inbox`, `wardroom_remember` — pi's LLM coordinates through the shared board |
| Guard | `tool_call` event | Edits to files another agent holds a lease on are **blocked**, with the holder and expiry in the refusal — enforcement, not advisory |
| Context | `before_agent_start` | The crew protocol line and the verified Project Brief (crew memory) ride into every turn |
| Commands | `registerCommand` | `/board` and `/crosstalk` for the human |

## Status

Working skeleton, written against pi-mono main as of 2026-07 (extensions
API: [docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)).
The tool/guard layers use documented, stable surfaces; the context-injection
and command-output calls are defensive (`appendSystemPrompt` falling back to
`systemPrompt`, `ctx.print` falling back to `ctx.ui.notify`) and may need a
one-line adjustment as pi's API evolves. Typical workflow: run `wardroom`
(the conductor console + headless crew) in one terminal, pi in another —
the pi seat claims work, gets blocked from leased files, and shows up in
crosstalk like any other agent.
