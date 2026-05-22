# Setup & Wiring Guide

## Install

```bash
cd /path/to/multi-agent-memo
npm install

# make the entry point executable
chmod +x src/index.ts
```

## Wire into Claude Code

Add to `~/.claude/claude_desktop_config.json` (or your project's `.claude/settings.json`):

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

## Wire into Codex

Add to `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

## Wire into Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

## Usage Pattern

At the start of every session, whichever agent you open first should call:

```
start_session(repo_path="/your/project", agent="claude", persona="architect")
```

Then for every message exchange:

```
append_message(repo_path="/your/project", agent="claude", persona="architect", speaker="claude", message="I scaffolded the auth module.")
append_message(repo_path="/your/project", agent="claude", persona="architect", speaker="me", message="Good. Add refresh token support.")
```

To pick up context when switching agents:

```
get_context(repo_path="/your/project", last_n=20)
```

The `AGENTS.md` file will be created automatically at the root of your project repo on first write.

## Available Tools

| Tool | Purpose |
|------|---------|
| `start_session` | Open a new session block (call once per working session) |
| `append_message` | Write one message line (agent or user) |
| `read_memory` | Read full log, optionally filter by agent |
| `get_context` | Get last N messages for context injection |
