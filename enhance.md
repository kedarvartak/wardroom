# enhance.md — Hardening `multi-agent-memo`

> A detailed engineering review of what this project is *for*, where it is
> **brittle**, and a prioritized plan to make it reliable enough to trust as the
> source of truth across Claude Code, Codex, and Gemini CLI.
>
> Status as of 2026-05-31. References are `file:line` against the current tree.

---

## 0. Pivot (2026-05-31) — manual writedown + read_memo

The project's reliability hinged on §3.6: **write-back was advisory**, so agents
skipped it (context was often thin by the time they remembered). The pivot
replaces *automatic* capture with **explicit, user-triggered** capture:

- **`write_session` (manual).** Triggered by the user via `/writedown`. The agent
  — which still has the full conversation in context at that moment — writes a
  *structured snapshot* (Summary / Decisions / Files touched / Current state /
  Next steps / Blockers), not a raw transcript.
- **`read_memo` (manual).** Triggered via `/readmemo`. Loads the latest N
  writedowns in full plus an index, so a fresh chat can resume on demand.

**Storage changed to per-session files** (`src/writedown.ts`):

```
repo/
├── AGENTS.md              ← generated: format:2 index + "Latest State" snapshot
└── .memo/sessions/
    ├── 2026-05-31T143005-claude.md   ← one writedown = one new file
    └── 2026-05-31T161200-codex.md
```

The per-session files are the **source of truth**; `AGENTS.md` is rebuilt from
the directory on every write. Because each writedown is a *new* file, this design
**eliminates §3.1 (concurrent append races) outright** — there is no shared file
to mutate concurrently and no lock required. It also fixes §3.2 (no per-message
header logic), §3.3 (content stored verbatim, multi-line preserved), and §3.4
(timestamped session ids instead of date-only keys).

Wired in: `src/writedown.ts`, tools in `src/index.ts`, `.claude/commands/
writedown.md` + `readmemo.md`, and `scripts/inject-memory.sh` now injects the
"Latest State" section. Tests: `test/writedown.test.ts`. The legacy line-log
tools in `src/memory.ts` remain for now but are superseded by this path.

> The remaining items below still apply to the legacy `memory.ts` path and to
> hardening the new path (e.g. §3.7 self-dependency, §3.11 write containment).

---

## 1. The Intent (what problem this actually solves)

Modern development increasingly happens across **multiple AI coding tools at
once** — Claude Code in one terminal, Codex in another, Gemini CLI in a third,
plus IDE extensions. Two recurring pains motivate this project:

1. **Cross-tool context loss.** Each CLI starts *cold*. It has no idea what
   another tool just decided, built, or flagged. Switching between them means
   re-explaining architecture, re-stating decisions, and re-routing work by
   hand. The more tools you use, the worse the tax.

2. **Long-chat degradation / forced restarts.** When a single conversation runs
   too long, model performance degrades and you're forced to open a fresh chat —
   which is *also* a cold start. All the hard-won context from the previous
   session is gone unless you manually carry it over.

The project's answer is a **single shared, append-only memory log** —
`AGENTS.md` at the repo root — exposed through an **MCP server**
(`multi-agent-memo`). Every agent reads recent context before acting and writes
its output after. Because the log lives *in the repo*, it versions with the code
and is portable across every tool that speaks MCP.

```
                       AGENTS.md  (single source of truth, in-repo)
                            ▲   ▲   ▲
            read/write ─────┘   │   └───── read/write
                   ┌────────────┼────────────┐
              Claude Code     Codex       Gemini CLI
            (hook + MCP)   (native read)  (GEMINI.md + MCP)
```

**The north star:** any tool, at any time — including a brand-new chat after the
last one degraded — can reconstruct "where are we, what was decided, what's
blocked" without the human re-typing it.

### The longer vision (from `docs/idea.md`, `docs/roadmap.md`)
- **Phase 3 — Personas:** a `personas.json` registry + a `handoff_to` tool that
  packages context for the *next* agent.
- **Phase 4 — Orchestration:** headless `dispatch` to all three CLIs (parallel /
  sequential / targeted), outputs landing in `AGENTS.md`.
- **Phase 5 — Web UI:** browser dispatch + live memory view via Cloudflare
  Tunnel.

These are valuable, but **they are built on a foundation that is not yet solid.**
This document argues we should harden Phases 1–2 before building 3–5 on top.

---

## 2. Current Architecture (as built)

| Piece | File | Role |
|-------|------|------|
| MCP server / tool routing | `src/index.ts` | Registers 7 tools + the `memo://agents-md` resource, validates args with zod, dispatches to `memory.ts`. |
| Storage + parsing engine | `src/memory.ts` | All reads/writes to `AGENTS.md`; regex parsing; search/summarize/decision heuristics. |
| Claude injection hook | `scripts/inject-memory.sh` | `grep`s the last 30 message lines into `<agent_memory>` on every prompt. |
| Per-tool instructions | `CLAUDE.md`, `GEMINI.md` | Tell each agent the read-before / write-after protocol. |
| Wiring | `.claude/settings.json` | MCP + hook registration (currently with placeholder paths). |
| Tests | `test/memory.test.ts` | 7 unit tests over `memory.ts` happy paths. |

**Data model.** Sessions are keyed by **date only** (`## Session: YYYY-MM-DD`),
each containing `### agent — persona` blocks of `**speaker** — message` lines.
Everything is reconstructed by re-reading and **regex-parsing the entire file**
on every call (`parseEntries`, `memory.ts:200`).

---

## 3. Brittleness Catalog

Ordered roughly by blast radius. Severity: 🔴 critical · 🟠 high · 🟡 medium.

### 3.1 🔴 No concurrency control — the core promise is unguarded
**Where:** `appendText` → `fs.appendFileSync` (`memory.ts:135-137`); the
read→compute→append sequence in `ensureSessionAndSection` + `appendMessage`
(`memory.ts:240-303`).

The entire selling point is *multiple agents writing the same file*. But every
write is a **non-atomic read-then-append** with no file lock:

1. Agent A reads `AGENTS.md`, decides it needs a session header.
2. Agent B reads the *same* stale content, decides the same thing.
3. Both append → **duplicate session/agent headers, interleaved lines, or a
   half-written line if a write is preempted.**

There is no `flock`, no lockfile, no atomic `rename()`, no write queue. Under the
exact workload this tool advertises (parallel dispatch in Phase 4 makes this
*guaranteed*), the log silently corrupts. This is the single most important fix.

### 3.2 🔴 Agent header is re-emitted before *every* message
**Where:** `ensureSessionAndSection` (`memory.ts:240-258`), specifically the
`trimmed.endsWith(agentHeader)` check.

**Verified empirically.** Three consecutive `appendMessage` calls from
`codex/coder` produce:

```markdown
### codex — coder
**codex** — First message

### codex — coder
**codex** — Second message

### codex — coder
**me** — Third message
```

Because a *message* line is appended after the header, the file never "ends with
the agent header," so the next append re-adds it. The intended behavior — one
header per consecutive run of an agent's messages — never happens. Result: noisy,
bloated logs and inflated `participants` counts. (The grep-based hook hides this
from Claude, which is why it went unnoticed.)

### 3.3 🔴 Storage format == parse format, with no escaping
**Where:** `MESSAGE_RE` (`memory.ts:8`), `AGENT_HEADER_RE` (`memory.ts:7`),
`SESSION_HEADER_RE` (`memory.ts:6`), `parseEntries` (`memory.ts:200`).

The log is both the human artifact *and* the machine record, but message content
is never escaped. Any of these break round-tripping:

- A message containing `**bold**` → `MESSAGE_RE = /^\*\*([^*]+)\*\* — (.+)$/`
  mis-parses the speaker.
- A message whose text *is* a line like `## Session: 2026-01-01` or
  `### foo — bar` → re-parsed as a real header, **silently corrupting
  attribution.**
- `AGENT_HEADER_RE` mandates the em-dash `—` and forbids agent names starting
  with `-`. A persona containing ` — ` splits wrong.
- **Multi-line content is destroyed:** `normalizeMessage` (`memory.ts:120-133`)
  flattens newlines to spaces, so code blocks, lists, and diffs — exactly what
  coding agents produce — are collapsed into one unreadable line.

### 3.4 🟠 Sessions keyed by date conflate distinct work
**Where:** `today()` (`memory.ts:60-62`), `SESSION_HEADER_RE`,
`summarizeSession` (`memory.ts:421`).

A "session" is just a calendar date. Two unrelated work sessions on the same day
merge into one block; `summarize_session` cannot separate them. Worse for the
**long-chat-restart use case** — the very scenario this tool targets — a fresh
chat on the same day lands in the same undifferentiated bucket. Also: `today()`
uses UTC (`toISOString`), so work spanning local midnight may split or merge
unexpectedly. There is no session ID, no start/end time, no notion of a
"handoff."

### 3.5 🟠 Read-whole-file-and-reparse on every call — degrades with size
**Where:** every public function calls `readFile` + `parseEntries` over the
*entire* file; e.g. `getContext` (`memory.ts:336-352`) reparses everything just
to `slice(-lastN)`.

The log is **append-only with no compaction or archival**. It grows forever, and
every operation is O(file). The tool that exists to fight context degradation
will itself slow down and eventually return a multi-thousand-line `read_memory`
blob that blows the consumer's context window. There is no pagination, no index,
no rollup, no "distilled current state" view.

### 3.6 🟠 Write-back is advisory, not enforced — silent memory gaps
**Where:** the whole protocol depends on `CLAUDE.md` / `GEMINI.md` *instructing*
the model to call `append_message` after work.

LLMs forget. When an agent doesn't log, the memory has a hole and no one knows.
There is no `Stop`/`SessionEnd` hook that auto-captures a turn, no reconciliation,
no "you did work but logged nothing" nudge. Reliability of the entire system is
bounded by the model's compliance — the weakest possible guarantee.

### 3.7 🟠 Ships broken out of the box
- **Self-dependency.** `package.json:37` lists `"multi-agent-memo": "^0.1.0"` as
  a dependency *of itself* (introduced by commit `043f7d7`). This is circular and
  will confuse `npm install` / publish.
- **Placeholder paths committed.** `.claude/settings.json:9` and the README/setup
  snippets hardcode `/path/to/multi-agent-memo/...`. Copy-paste yields a
  non-functional hook with no error surfaced (`inject-memory.sh` `exit 0`s
  silently if the file is missing).
- **Run-instruction drift.** `docs/setup.md` says `node /path/.../src/index.ts`
  (a `.ts` file that won't run without `--experimental-strip-types`), while the
  README uses `npx multi-agent-memo` (the built `dist/`). Two contradictory
  install paths.

### 3.8 🟡 Decision heuristic is noisy
**Where:** `DECISION_HINT_RE` (`memory.ts:10`), `isDecisionEntry`
(`memory.ts:152`).

Matching bare verbs like `use|used|implement|will use` flags huge numbers of
false positives — "I didn't **use** Redis" or "should we **use** X?" both
register as decisions. `get_decisions` and the summary's decision list become
untrustworthy, which undermines the highest-value query in the tool.

### 3.9 🟡 "Semantic search" is substring matching
**Where:** `scoreEntry` (`memory.ts:164`), `normalizeSearchTerms`
(`memory.ts:156`); roadmap claims "keyword/semantic search."

`search_memory` is naive term-presence scoring: no recency weighting, no
stemming/stopwords, no fuzzy or embedding match. README/roadmap over-claim
"semantic." Fine as a v1, but the gap between promise and reality should close.

### 3.10 🟡 No agent/identity validation; case-sensitive filters
**Where:** `normalizeLabel` (`memory.ts:109`); filters in `readMemory`,
`searchMemory`, etc. compare with exact `===`.

`agent` is a free-form string. `Claude` ≠ `claude` ≠ `claude ` create three
phantom identities that filters silently miss. Nothing enforces the
claude/codex/gemini set or a known persona vocabulary.

### 3.11 🟡 Arbitrary filesystem write surface
**Where:** `assertRepoPath` only checks *absoluteness* (`memory.ts:64-68`);
`ensureFile` does `mkdirSync(..., {recursive:true})` + write (`memory.ts:83-88`).

Any caller-supplied absolute `repo_path` causes the server to create directories
and write `AGENTS.md` **anywhere on disk**. No allowlist, no containment. A typo
or hostile prompt can scribble files outside the project.

### 3.12 🟡 Double-injection + fragile hook
**Where:** `scripts/inject-memory.sh:14` *and* `CLAUDE.md` instruction to also
call `get_context`.

Claude gets the same context twice (hook injection + tool call), wasting tokens.
The hook `grep`s on the em-dash literal and a `tail -30` with no token budget,
dedup, or session awareness — and fails silently on any format drift.

### 3.13 🟡 Test coverage misses everything that breaks
**Where:** `test/memory.test.ts` — 7 happy-path unit tests over `memory.ts`.

No tests for: concurrent writes, the header-duplication bug (§3.2), multi-line
messages, messages containing Markdown/header-like lines, malformed files,
format-version mismatch, or **any** of `src/index.ts` (the MCP layer is entirely
untested). The suite passes while the real failure modes go unguarded.

---

## 4. Prioritized Enhancement Plan

### Tier 0 — Make it not corrupt itself (do first)
1. **Atomic, locked writes.** Wrap every mutation in an advisory lock (lockfile
   or `proper-lockfile`); write via temp file + `fs.rename` for atomicity.
   Serialize writes through an in-process async queue so one server's own
   concurrent tool calls can't race either. *(Fixes §3.1.)*
2. **Fix header emission.** Track the last-written `(agent, persona)` so the
   header is written once per consecutive run, not per message. Add a regression
   test asserting exactly one header for N consecutive same-agent messages.
   *(Fixes §3.2.)*
3. **Remove the self-dependency** in `package.json` and reconcile the two install
   paths (`dist/` vs `src/.ts`). Ship a portable hook that resolves its own path
   instead of `/path/to/...`. *(Fixes §3.7.)*

### Tier 1 — Make the data trustworthy
4. **Escape or fence message content** so it can never be re-parsed as structure.
   Options in §5. Preserve multi-line content (the current flattening is data
   loss). *(Fixes §3.3.)*
5. **Real session identity:** a `session_id` (timestamp + short hash) plus
   `started_at`, optional `ended_at`, and the originating agent. Date stays as a
   human grouping but is no longer the key. *(Fixes §3.4.)*
6. **Validate identities:** normalize agent/persona to a known set (configurable),
   case-fold for comparison, warn on unknowns. *(Fixes §3.10.)*
7. **Contain the write surface:** require `repo_path` to be (or live under) a
   configured workspace root; refuse paths outside it. *(Fixes §3.11.)*

### Tier 2 — Make it scale and stay useful
8. **Index + incremental read.** Maintain a lightweight sidecar index (offsets or
   a parsed JSON cache invalidated by mtime/size) so `get_context` / search don't
   reparse the world. *(Fixes §3.5.)*
9. **Compaction / rollup.** A `summarize_session` that can *persist* a distilled
   "state so far" block and archive raw history, plus a `get_state` tool that
   returns the distilled snapshot instead of the raw firehose. This is what
   actually serves the long-chat-restart use case. *(Fixes §3.5, §3.6.)*
10. **Enforce write-back.** Add a `Stop`/`SessionEnd` hook (and Codex/Gemini
    equivalents where possible) that auto-appends a concise turn summary, so
    memory doesn't depend on the model remembering. *(Fixes §3.6.)*

### Tier 3 — Make the intelligence real
11. **Better decisions:** require explicit `#decision` (drop or heavily downrank
    the verb heuristic), or add a confirmation step. *(Fixes §3.8.)*
12. **Better search:** recency weighting + stopword/stemming now; optional
    embedding index later. Stop calling it "semantic" until it is. *(Fixes §3.9.)*
13. **De-duplicate injection** between the hook and the tool; add a token budget
    and session-aware selection to the hook. *(Fixes §3.12.)*
14. **Fill the test gaps:** concurrency, round-trip of adversarial content,
    multi-line, malformed files, and an MCP-layer integration test for
    `index.ts`. *(Fixes §3.13.)*

### Sequencing note
Phases 3–5 of the existing roadmap (personas, orchestration, web UI) should wait
on **Tier 0–1**. Phase 4's parallel `dispatch` makes the §3.1 concurrency race a
*certainty*, not a possibility — building it first would bake corruption in.

---

## 5. Design Decisions That Need Your Input

A few of these enhancements have genuine trade-offs where your call shapes the
result. Flagging them rather than guessing:

### Decision A — How to make message content parse-safe (§3.3)
The constraint: `AGENTS.md` must stay human-readable *and* losslessly
machine-parseable, including multi-line code blocks.

| Option | Pro | Con |
|--------|-----|-----|
| **A1. Escape** structural chars on write, unescape on read | Stays plain Markdown | Escaping is easy to get subtly wrong; human sees `\#\#` |
| **A2. Fence** each message body in a delimited block (e.g. HTML comment markers or a fenced region) | Multi-line safe; content untouched | Slightly noisier raw file |
| **A3. Sidecar JSONL** as source of truth, render `AGENTS.md` as a view | Robust, indexable, scales | Loses "the repo file *is* the truth"; two artifacts to keep in sync |

My lean is **A2 for the log + A3's index as a cache** (Tier 2 #8), but A3-as-truth
is a real philosophical shift worth your explicit sign-off because it changes the
project's "just Markdown, no database" identity.

### Decision B — Concurrency mechanism (§3.1)
Single-machine lockfile (`proper-lockfile`) is simplest and fits the
"runs on your PC" model. A cross-machine story (Phase 5 tunnel, shared repo)
would eventually want a server-side serialization point. Pick the scope now so
the lock abstraction is designed for it.

### Decision C — Does write-back get *enforced* or stay *advisory* (§3.6)?
Auto-capturing every turn via a Stop hook guarantees completeness but can bury
signal in noise and write a lot. Staying advisory keeps the log curated but
leaky. This is a product call about whether the log is a *complete transcript* or
a *curated decision record*.

> If you'd like, I can turn any of A/B/C into a concrete implementation against
> the relevant files — these are the points where your preference genuinely
> changes the design.

---

## 6. Quick-Reference: Bug → Fix Map

| # | Severity | One-liner | Primary file |
|---|----------|-----------|--------------|
| 3.1 | 🔴 | No locking on concurrent writes | `memory.ts:135,240` |
| 3.2 | 🔴 | Agent header repeats every message | `memory.ts:240` |
| 3.3 | 🔴 | Content not escaped; multi-line lost | `memory.ts:8,120` |
| 3.4 | 🟠 | Sessions keyed by date only | `memory.ts:60,421` |
| 3.5 | 🟠 | Reparse whole file every call; no compaction | `memory.ts:200,336` |
| 3.6 | 🟠 | Write-back advisory, not enforced | `CLAUDE.md`/hook |
| 3.7 | 🟠 | Self-dependency + placeholder paths | `package.json:37` |
| 3.8 | 🟡 | Noisy decision heuristic | `memory.ts:10` |
| 3.9 | 🟡 | "Semantic" search is substring | `memory.ts:164` |
| 3.10 | 🟡 | No identity validation; case-sensitive | `memory.ts:109` |
| 3.11 | 🟡 | Arbitrary FS write surface | `memory.ts:64` |
| 3.12 | 🟡 | Double-injection + fragile hook | `inject-memory.sh:14` |
| 3.13 | 🟡 | Tests miss every real failure mode | `test/memory.test.ts` |

---

*End of review. Tier 0 is the recommended starting point — it's the difference
between a log you can trust and one that quietly corrupts under the exact
multi-agent workload the project exists to support.*
