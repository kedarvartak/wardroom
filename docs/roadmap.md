# Roadmap

## Phase 1 — Core MCP Server (current)

**Goal:** A working MCP server with basic read/write tools.

- [x] Project scaffold (`docs/`, `src/`, `package.json`)
- [x] `append_message` tool — write a message to the shared log
- [x] `read_memory` tool — read the full log or filter by agent/persona
- [x] `start_session` tool — open a new dated session block
- [x] `get_context` tool — return the last N messages for quick context injection
- [ ] Publish to npm as `multi-agent-memo`

## Phase 2 — Intelligence Layer

**Goal:** Make memory searchable and summarizable.

- [ ] `search_memory` tool — keyword/semantic search across the log
- [ ] `summarize_session` tool — compress a session into key decisions
- [ ] `get_decisions` tool — extract only decision-type messages (not chatter)
- [ ] Tag support: `#decision`, `#blocker`, `#todo` inline in messages

## Phase 3 — Multi-Repo & Team Support

**Goal:** Share memory across repos and team members.

- [ ] Remote memory backend (S3 / GitHub Gist / Supabase) as opt-in
- [ ] `AGENTS.md` auto-merge strategy for parallel agent writes
- [ ] Per-agent read permissions (e.g. Gemini can read but not write Claude sessions)
- [ ] CLI tool: `memo` — standalone binary to read/write without MCP

## Phase 4 — Agent Personas Registry

**Goal:** Codify what each agent/persona knows and does.

- [ ] `personas.json` config — define roles (coder, pm, reviewer, architect)
- [ ] Auto-inject persona context at session start
- [ ] Cross-agent handoff: `handoff_to` tool that packages context for the next agent
