---
description: Capture this chat as a structured session writedown into shared memory
---

You are about to persist the current conversation into the project's shared
memory so another agent — or a fresh chat after this one degrades — can resume
without the user re-explaining anything.

Write a **structured snapshot** of this session (not a raw transcript). Keep it
high-signal and compact. Use these Markdown sections, omitting any that are empty:

- `## Summary` — 2–4 sentences: what this session was about and what changed.
- `## Decisions` — bullet list of choices made that should not be revisited. Tag each with `#decision`.
- `## Files touched` — paths created/edited and a few words on each.
- `## Current state` — where things stand right now (what works, what's in progress).
- `## Next steps` — concrete TODOs for whoever picks this up. Tag with `#todo`.
- `## Blockers` — anything preventing progress. Tag with `#blocker`.

Then call the `write_session` MCP tool from `wardroom`:

- `repo_path`: the absolute path of this project's repository
- `agent`: `claude`
- `persona`: the role you were acting in this session (e.g. architect, coder, reviewer)
- `content`: the structured Markdown snapshot above
- `summary`: a single sentence capturing the session, for the index

After it returns, tell the user the session id and file path it wrote, and how
many writedowns are now on file. Do not write anything to `AGENTS.md` directly —
the tool regenerates it.

$ARGUMENTS
