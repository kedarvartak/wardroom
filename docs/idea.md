# Multi-Agent Shared Memory — Idea

## The Problem

Claude Code, Codex, and Gemini CLI each operate in isolation. When you use all three on the same project, each agent starts cold — no memory of what another decided, built, or discussed. You end up re-explaining context, re-making decisions, and losing the thread of cross-agent work.

## The Solution

A single MCP server that maintains a **shared conversation log** inside the project repo (`AGENTS.md`). Every agent — Claude, Codex, Gemini — reads from and writes to this log through the MCP. The log is structured, human-readable Markdown.

## Log Format

```
## Session: 2026-05-22

### claude — architect
**claude** — I've scaffolded the auth module under `src/auth/`. Used JWT with refresh token rotation.
**me** — Good. Can you document the token expiry logic?
**claude** — Done, see `docs/auth.md`.

---

### codex — coder
**codex** — Implementing the refresh endpoint now. Should I use Redis or in-memory store?
**me** — Redis, we need persistence across restarts.
**codex** — Got it, adding `ioredis` dependency.

---

### gemini — junior developer 
**gemini** — handles small tasks
**me** — Fix it.
**gemini** — Fixed in commit `a3f9c2`.
```

## Key Properties

- **Append-only** — entries are never edited, only added. Full history is preserved.
- **Agent-tagged** — every entry knows which agent wrote it and what persona it was operating under.
- **Human-readable** — `AGENTS.md` is just Markdown. No database, no binary format.
- **MCP-native** — exposed as MCP tools so any compliant CLI can wire in with one config line.
- **Repo-local** — the memory file lives in the project, so it versions with the code.

## Who This Is For

Developers who run multiple AI coding assistants on the same project and want them to share context without manual copy-paste.
