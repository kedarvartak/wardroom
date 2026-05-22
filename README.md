# multi-agent-memo

Shared memory MCP server for Claude Code, Codex, and Gemini CLI. It stores append-only project memory in a repo-local `AGENTS.md` file so multiple agents can share context without copy-paste.

## What It Does

- `start_session` opens a dated session block for an agent/persona pair.
- `append_message` appends a single user or agent message under the active section.
- `read_memory` reads the full log or filters by `agent` and `persona`.
- `get_context` returns the most recent messages as compact context lines.

## Install

```bash
npm install
chmod +x src/index.ts
```

## MCP Wiring

Point your MCP client at the executable entrypoint:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/absolute/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

This matches the examples in [docs/setup.md](docs/setup.md).

## Memory Format

The server writes a repo-local `AGENTS.md` with a versioned header and append-only sections:

```md
---
format: 1
project: my-repo
created: 2026-05-22
---

# Agent Memory

## Session: 2026-05-22

### codex — coder
**codex** — Implementing the refresh endpoint now.
**me** — Use Redis for persistence.
```

## Development

```bash
npm test
npm start
```

Requires Node `22+`, since the package runs TypeScript directly via Node's native type-stripping support.

## Publishing

The package metadata is set up for npm publishing. Actual release still requires an authenticated `npm publish` from a maintainer account.
