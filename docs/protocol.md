# Agent Protocol — how to work in a shared checkout

The rules every agent (Claude, Codex, Gemini) follows when sharing one
working tree. These are also encoded in `CLAUDE.md` / `GEMINI.md`.

## The loop

```
join            get_context(repo_path)
                     │
plan (once)     plan_tasks(...)          ← one agent (or the human) decomposes
                     │
work            ┌─► claim_next_task ──► edit ──► verify ──► complete_task ─┐
                └──────────────────── get_events(since_seq) ◄──────────────┘
                     │
leave           write_session (/writedown) when the user asks
```

### 1. Join: `get_context`
Before planning or touching any file. It returns the latest writedown, the
live board, active claims, and recent events — including the event cursor to
use for later polls.

### 2. Plan: `plan_tasks` (usually once, by one agent)
Decompose the work into tasks that are **file-disjoint wherever possible**:

- Declare every task's `files` footprint (paths or globs). The scheduler can
  only parallelize what it can see. An undeclared footprint means "touches
  nothing" — reserve that for research/review tasks.
- Put shared contracts (types, interfaces, schemas) in an **early task** and
  make implementations `depends_on` it (`"$0"` refers to the first task in
  the same batch).
- Give hotspot files (route tables, config, barrel exports, lockfiles) to as
  few tasks as possible; the scheduler serializes tasks that share them.

### 3. Work: pull, don't push
- `claim_next_task` — atomically gets you a runnable, non-conflicting task
  and leases its files. Never pick work by reading the board and editing
  directly; the atomic claim is what prevents two agents doing the same task.
- If it returns `all-blocked`, do non-editing work (review, research), poll
  events, or wait — do **not** edit the blocked files anyway.
- Editing outside a task (quick fix, exploratory change)? `claim_files`
  first, `release_files` the moment you're done. Leases you sit on serialize
  everyone else.
- Made a change other agents must know about mid-flight (renamed a symbol,
  changed an API, moved a file)? `post_event` immediately.
- Between tasks — and before editing any shared surface — `get_events` with
  your last cursor.
- Finish with `complete_task` and a result another agent can build on
  ("added POST /auth/refresh in src/api/auth.ts; tests in test/auth.test.ts
  pass"), or `fail_task` / `release_task` so the work returns to the board.
  **Never leave a task claimed when you stop working.**

### 4. Leave: writedowns
When the user runs `/writedown`, capture the session (summary, decisions,
files touched, current state, next steps, blockers) via `write_session`.
That snapshot — not your chat history — is what the next session cold-starts
from.

## Rules of the road

1. **No un-leased edits.** Every file you modify is covered by either your
   current task's footprint or an explicit `claim_files`.
2. **Leases are short.** Default 15 min; renew by re-claiming if you're still
   working. Don't request hours "to be safe."
3. **Conflicts are information, not obstacles.** A conflict tells you the
   correct schedule: that file's work is serialized. Take other work.
4. **Announce surprises.** Any change that invalidates what another agent
   might be assuming gets an event *before* you move on.
5. **Full-suite runs contend too.** If your build/test run fights over ports
   or generated files, claim a virtual path (e.g. `build/`) around it.
6. **The board is the truth about work; events are the truth about now;
   writedowns are the truth about history.** Keep all three honest.
