---
description: Load prior session writedowns from shared memory into this chat
---

Recover the context of earlier work on this project so you can continue without
the user re-explaining it.

Call the `read_memo` MCP tool from `wardroom`:

- `repo_path`: the absolute path of this project's repository
- `last_n`: how many of the most recent writedowns to load in full. Default to `1`.
  Use a larger value (e.g. 3) if the user asks for more history or the latest one
  references earlier sessions.

When it returns, read the latest writedown(s) and the session index, then give
the user a short briefing: where work left off, the open decisions, and the
pending next steps / blockers. Treat this as authoritative prior context for the
rest of the chat.

$ARGUMENTS
