# Unsolved issues — architecture & implementation plan

> The gaps from `differentiation.md`, turned into concrete engineering for
> wardroom: the technical design, data models, module changes, and a phased
> plan. Diagrams in `docs/diagrams/` (referenced inline).

---

## 0. The central bet, restated as an engineering problem

wardroom rejects the industry's worktree isolation and runs many agents on
**one shared checkout**, arbitrated by **file leases**. That kills the parallel
**merge tax** — but it trades it for a sharper problem the research named
bluntly:

> The shared checkout trades worktree merge-pain for **semantic and runtime
> collision-pain**. The moat holds only if leases **plus verification** make
> that a net win.

So the whole plan below is organized around making that trade a net win, plus
the table-stakes that any unattended multi-agent harness needs. Five unsolved
issues, each mapped to concrete architecture:

| # | Unsolved issue | Why it's unsolved elsewhere | wardroom's lever |
|---|---|---|---|
| U1 | **Recovery** — undo an autonomous change, incl. shell side-effects | `/rewind` covers Write/Edit, not `rm`/`mv`; no per-task revert | per-task checkpoints + audit journal on the shared tree |
| U2 | **Cost blindness** — "$6,000 overnight", no live meter | dashboards lag days; no per-agent/per-task attribution | usage already flows through adapters; make it a live receipt |
| U3 | **Runtime collisions** — ports/DBs/suite shared across agents | worktrees isolate files, not runtime | generalize leases from files to **runtime resources** |
| U4 | **Semantic conflicts** — concurrent edits break the build; "passes tests, fails in prod" | text-merge isn't semantic; no integration gate | a **verification gate** + cross-task **integration check** |
| U5 | **Memory rot** — memory is read-but-ignored, and stale | files are wishes; auto-memory worsens rot | memory as an **enforced, verified, self-pruning brief** |

Two differentiators ride on top: **U6 cross-vendor routing** (Claude plans,
Codex tests) and **U7 a bounded-autonomy dial**.

![Target architecture](diagrams/target-architecture.png)

---

## 1. Where we are (the substrate these build on)

Already shipped and reused throughout:

- `store.ts` — mkdir-atomic locks + atomic JSON writes (every mutation).
- `claims.ts` — advisory TTL **file** leases with glob-overlap conflict.
- `tasks.ts` — the board: dependency + footprint-aware scheduling, directed
  `assignee`, cross-agent review, **change records** (`changes`, diff).
- `git.ts` — `changeStat` / `diffOf` / footprint telemetry.
- `worker.ts` / `pool.ts` — the claim→work→verify→complete loop, keep-alive,
  budgets, presence.
- `events.ts` / `messages.ts` — event bus + directed messages (delegation).
- `guard.ts` — a PreToolUse hook that blocks edits to leased files.
- `writedown.ts` — session memory snapshots → `AGENTS.md`.

The plan extends these; it does not replace them.

---

## 2. U1 — Recovery: checkpoints + side-effect-safe rollback

**Problem.** An agent runs free (the moat). When it's wrong, you need to undo
*just that task's* changes cheaply — and know about its shell side-effects,
which no tool reverses today.

**Design.** Two artifacts per task, both on the shared tree.

1. **Footprint checkpoint.** At the `working` transition, snapshot the current
   content of the task's footprint files. Because footprints are disjoint
   (the scheduler guarantees it), a per-task snapshot is clean and small.

   ```
   .memo/checkpoints/<task-id>.json
   { "taskId": "task-3", "created": "...", "baseRef": "<git HEAD sha>",
     "files": [ { "path": "src/auth/login.ts", "before": "<content|null>" } ] }
   ```
   `before: null` = the file did not exist (task created it). Store text
   content; for files over a cap or binary, store the git blob sha instead
   (`git hash-object`) and resolve on rollback. `baseRef` lets us prefer a git
   restore for tracked files and fall back to the stored content.

2. **Audit journal.** The `guard` hook already sees every tool call. Extend it
   to append destructive/shell ops to an append-only journal:

   ```
   .memo/audit.ndjson
   {"seq":42,"time":"...","agent":"codex","task":"task-3","op":"bash",
    "detail":"rm data/tmp.json","reversible":false}
   ```

**Rollback.** `wardroom rollback <task>`:
- restore each footprint file to `before` (delete if `before: null`);
- print any audit entries for the task marked `reversible:false` ("task-3 also
  ran `rm data/tmp.json` — not auto-reversible; review manually").

**Cross-agent protection.** The guard gains a rule: **deny a delete/move of a
file leased by another agent, or outside the actor's footprint.** This stops one
agent's `rm` from nuking a peer's in-flight work — the shared-checkout failure
mode worktrees avoid structurally, closed here by policy.

**New:** `src/checkpoint.ts` (snapshot/restore), `guard.ts` (delete-guard +
journal), `tasks.ts` (store `checkpointRef`), `cli.ts` (`rollback`, `audit`).
The full safe-autonomy loop (checkpoint → work → verify → accept/rollback, plus
the integration check) is below.

![Task lifecycle](diagrams/task-lifecycle.png)

**Acceptance.** Snapshot at claim; `rollback` restores modified + created files
and reports shell side-effects; a cross-agent `rm` of a leased file is blocked;
concurrency-safe (per-task files, no shared mutation).

---

## 3. U2 — Cost & receipts: make spend a first-class, live signal

**Problem.** Multi-agent multiplies the "$6,000 overnight" risk (~800k tokens
for a 3-agent team). There is no live meter, no per-agent/per-task attribution.

**Design.**

- **Price table.** `src/pricing.ts`: `model → {inputPer1k, outputPer1k}` (a
  built-in table for common models, overridable in `wardroom.json`). Adapters
  already surface `usage` (`tokens`, and `costUsd` for Claude). For agents that
  don't report cost (Codex/Gemini), compute `tokens × price(model)`.
- **Per-task cost on the receipt.** Attribute usage to the task the agent was
  running and store it on the change record: `task.cost = { tokens, usd }`.
  This makes the "receipt" complete: **what changed + what it cost.**
- **Decision log.** Ask each agent, in the task prompt, to end with a one-line
  `DECISIONS:` note (what it chose and what it ruled out). Capture it into
  `task.decisions`. Cheap, and it's the "ruled-out options" reviewers want.
- **Live gauge.** The TUI header already sums tokens; add a **cost fuel-gauge**
  (`$ / budget`) that turns amber→red near the cap, plus per-agent cost in each
  pane footer. `wardroom show <task>` prints cost + decisions with the diff.
- **Hard caps.** The budget stop exists (tokens/usd). Add a **per-task** cap so
  a single runaway task can't burn the session, and a destructive-op cap.

**New:** `src/pricing.ts`; `tasks.ts` (`cost`, `decisions`); `worker.ts`
(attribute usage, parse decisions); `bridge.ts` (gauge); `pool.ts`/`config.ts`
(per-task cap). **Acceptance.** Every done/failed task shows tokens + $; the
gauge updates live and trips the cap mid-run with a coherent writedown.

---

## 4. U3 — Runtime leases: isolation worktrees can't give

**Problem.** Leases stop two agents editing the same *file*. They do nothing
about two agents binding **port 3000**, running **migrations** on the same dev
DB, or running the **full test suite** at once (ports, temp files, generated
artifacts collide). Worktrees don't solve this either — it's genuine whitespace.

**Design — generalize `claims.ts` from paths to typed resources.**

```ts
type Resource =
  | { kind: "file";   key: string }   // path or glob  (existing behavior)
  | { kind: "port";   key: string }   // "3000" | "*"
  | { kind: "db";     key: string }   // "dev" | "migrations"
  | { kind: "suite";  key: string }   // "test" | "build"
  | { kind: "custom"; key: string };

type Lease = { id; agent; resource: Resource; mode: "exclusive"|"shared";
               reason; taskId?; expires };
```

**Conflict rule** (one function, replaces the paths-only overlap):
- different `kind` → never conflict;
- two `shared` of the same resource → no conflict (parallel reads);
- otherwise → conflict when the keys **match**: `file` uses `pathsOverlap`
  (unchanged); `port`/`db`/`suite`/`custom` use equality or `*` wildcard.

**How workers use it.** A task declares runtime needs alongside its file
footprint (`"needs": ["port:3000","suite:test"]`). `claim_next_task` acquires
file **and** runtime leases atomically — a task needing `suite:test` can't start
while another holds it, so **full-suite runs serialize automatically** while
disjoint-file work still parallelizes. The verification gate (U4) leases
`suite`/`build` the same way.

This is the natural completion of the file-lease idea and the clearest thing
**nobody else owns.**

![Resource leases](diagrams/resource-leases.png)

**Changes.** `claims.ts` (Resource model — keep a `file`-only compatibility
path so nothing breaks), `tasks.ts` (task `needs`), `worker.ts`/`pool.ts`
(acquire/release runtime leases), MCP `claim_resource`/`release_resource`,
config default ports/suite. **Acceptance.** Two tasks both needing `suite:test`
serialize; disjoint tasks still run together; a crashed lease expires (TTL).

---

## 5. U4 — Verification gate: catch semantic & runtime breakage

**Problem — the sharp edge.** File leases prevent *text* conflicts but not
*semantic* ones: agent A renames a symbol in its footprint, agent B's disjoint
file still imports the old name — no text conflict, broken build. "Passes tests,
fails in prod."

**Design — two gates.**

1. **Per-task gate (fast, scoped).** After an agent finishes and before the task
   counts as `done`, run configured checks scoped to the footprint where
   possible: `typecheck`, `lint`, `test` (the existing `verify` generalizes to a
   `checks: [...]` pipeline). A check that needs the whole suite acquires
   `suite:test` (U3) so runs serialize. Fail → task `failed` with the check
   output attached (already the pattern).

2. **Integration check (catches cross-task semantic breakage).** When a *set* of
   recently-completed tasks touched interdependent surfaces, run a **project-wide
   typecheck/build** once, debounced, under the `build` lease. If it fails, the
   integration check bisects: re-runs against each task's checkpoint (U1) to
   attribute the breakage, reopens the culprit task with the error, and posts a
   crosstalk heads-up ("task-5's rename broke task-8's import").

   ```
   config: { "checks": ["tsc --noEmit","eslint ."],
             "integrationCheck": "tsc --noEmit", "verify": "npm test" }
   ```

This is what turns the shared-checkout bet from a liability into an advantage:
worktrees discover the same breakage at *merge* time, with no attribution;
wardroom discovers it *at task boundary*, on one tree, and names the culprit.

**New:** `src/verify.ts` (pipeline + integration check + bisect-by-checkpoint);
`worker.ts` (call the pipeline), `pool.ts` (schedule the debounced integration
check), `config.ts` (`checks`, `integrationCheck`). **Acceptance.** A seeded
cross-task rename that breaks a peer's import is caught by the integration check,
attributed to the right task, and reopened — no human, no merge step.

---

## 6. U5 — Memory that's obeyed and doesn't rot

**Problem.** Memory today is a file the model may ignore ("CLAUDE.md is a wish
list"), and auto-written memory rots ("a note the model wrote is a claim waiting
to be confirmed"). Both failure modes are the field's loudest complaints.

**Design — memory as an enforced, verified, self-pruning brief.**

```
.memo/memory.json
{ items: [ { id, text, kind: "decision"|"convention"|"gotcha",
             files?: string[], confidence: 0..1, source: "task-3|session|human",
             created, lastVerified, verify?: "<shell test>" } ] }
```

- **Obeyed, not filed.** Instead of hoping the agent reads a file, the conductor
  and every worker prompt include a compact **"Project brief — follow these"**
  section built from the memory store (top-N by confidence, scoped to the task's
  files). It's *in the prompt*, so it's used, not skipped.
- **Verified, not trusted.** A memory item can carry a `verify` predicate (a
  shell test, e.g. `grep -q zod package.json`) or a structural check (its `files`
  still exist). Before injection, stale items (verify fails / files gone) are
  **down-weighted or dropped** — killing rot at the source.
- **Self-maintaining.** A consolidation pass (post-session, the "dream") dedupes
  near-identical items, merges, decays `confidence` for unverified items, and
  promotes items confirmed across sessions. Provenance links each item to the
  task/session that created it.
- **Growth without gating.** Agents propose memory via an MCP `remember` tool;
  the human curates with `wardroom memory` (list/pin/forget). Nothing blocks the
  autonomy — memory is captured async and enforced next turn.

**New:** `src/memory-store.ts` (CRUD + verify + consolidate — distinct from the
session-writedown `writedown.ts`); prompt assembly in `conductor.ts`/`worker.ts`
uses it; MCP `remember`; `cli.ts` `memory`. Flow: `diagrams/memory.png`.
**Acceptance.** An injected convention is followed by a fresh agent; a stale item
whose `verify` fails is dropped before injection; consolidation dedupes.

---

## 7. U6 & U7 — cross-vendor routing and the autonomy dial

**U6 — routing.** The conductor already sets `assignee`. Add a **routing policy**
so it dispatches by capability, not ad hoc:

```
config: { "route": { "review": "codex", "architecture": "claude",
                     "tests": "codex", "default": "claude" },
          "agents": { "claude": { "roles": ["plan","arch"] }, ... } }
```
The conductor prompt is handed the policy and tags each task with a `kind`; the
board's directed assignment does the rest. Headline: **"Claude plans, Codex
tests, on one board"** — which no single-vendor system can do.

**U7 — autonomy dial.** One config knob with escalating guardrails, so
fire-and-forget stays *bounded* (the deleted-prod-DB lesson):

```
config: { "autonomy": { "level": "bounded",   // plan | bounded | full
                        "maxCostUsd": 5, "maxFilesPerTask": 20,
                        "allowDestructive": false, "reviewBeforeAccept": true } }
```
- `plan` — the conductor proposes the board and waits (console approval).
- `bounded` — runs free within caps (cost, blast-radius), destructive ops gated
  by the guard, cross-agent review before a diff is accepted.
- `full` — no caps (explicit opt-in).

These reuse existing machinery (assignee, budgets, guard, review); they're
policy, not new subsystems.

---

## 8. Phased plan

Sequenced so each phase ships value and de-risks the next. Timeline:
`diagrams/plan-phases.png`.

| Phase | Scope | Depends on | Headline acceptance |
|---|---|---|---|
| **P8** | **U1** checkpoints + side-effect-safe rollback + audit journal + cross-agent delete guard | change records (done) | `rollback <task>` restores modified+created files, reports shell effects; cross-agent `rm` blocked |
| **P9** | **U2** cost & receipts: price table, per-task cost + decisions, live gauge, per-task cap | adapters' usage | every task shows tokens+$; gauge trips the cap mid-run |
| **P10** | **U3** resource leases: generalize `claims.ts` to typed resources; task `needs`; runtime lease acquire/release | claims/tasks | two `suite:test` tasks serialize; disjoint still parallel |
| **P11** | **U4** verification gate + integration check with checkpoint-bisect attribution | P8 (checkpoints), P10 (suite lease) | a cross-task rename breakage is caught, attributed, reopened |
| **P12** | **U5** obeyed memory: store, verified injection, consolidation, `remember`/`memory` | writedown | injected convention obeyed; stale item dropped |
| **P13** | **U6/U7** routing policy + autonomy dial | all above | model-per-task routing; `bounded` autonomy enforced |

**Sequencing logic.** P8 (recovery) and P9 (cost) are the trust table-stakes and
lowest-risk — build first. P10 (runtime leases) is the whitespace and the
prerequisite for P11 (the verification gate that makes the shared-checkout bet
win). P12 (memory) and P13 (routing/autonomy) are the differentiators layered on
a now-trustworthy core.

**Non-goals (kept honest).** No worktrees (the whole point). No token-level
interruption (fire-and-forget is the moat; steering is at task boundaries). No
custom model runtime — wardroom drives the real CLIs on your own subscriptions.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Checkpoint storage bloat on large files | store git blob sha over content past a cap; compaction prunes old checkpoints |
| Integration check is slow / noisy | debounce; run only when completed tasks share a dependency; scope by changed files; make it opt-in |
| Runtime `needs` mis-declared (agent forgets `port:3000`) | conductor infers common needs from task text; a "port already bound" runtime error re-leases and serializes |
| Memory injection bloats the prompt (context rot) | top-N by confidence, scoped to footprint, hard token budget for the brief |
| Cost table drifts from real prices | overridable in config; fall back to token-only display when a model is unpriced |
| Autonomy caps too blunt | per-task + per-session caps; blast-radius by file count and destructive-op gate, not a single number |
