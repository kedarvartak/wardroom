# What would make wardroom truly different

> A landscape read of AI coding-agent harnesses (2025-2026), what developers
> actually want from them, where the whitespace is, and an honest assessment of
> where wardroom already wins, what it could uniquely own, and the table-stakes
> it cannot skip. Sourced inline; full list at the end.

---

## 0. The question

wardroom is a single-terminal harness that runs **multiple** coding-agent CLIs
(Claude Code, Codex) **in parallel on one shared checkout — no worktrees**,
coordinated by a conductor you command conversationally. Its thesis:
**fire-and-forget autonomy is the moat; transparency — staying in sync with
what the agents did — is the differentiator.**

The question isn't "which features are we missing." Feature parity is a losing
game against Anthropic and Cursor. The question is: **what strong, opinionated
bet can wardroom make that the field hasn't — and that developers are actively
asking for?** This doc answers that from evidence, not taste.

---

## 1. What "truly different" looks like: Pi as the reference

Pi ([pi.dev](https://pi.dev/), by Mario Zechner / Earendil) is the clearest
example of a harness that is *genuinely* different, and it's instructive because
its differentiation is **an inversion, not a longer feature list**.

Where every other harness ships a feature-rich product that hides its machinery,
Pi ships a **minimal core of primitives** — four tools (`read`, `write`,
`edit`, `bash`), a sub-1,000-token system prompt (vs 7-10k elsewhere), a slim
TUI — and makes **every harness layer a configuration surface you own**: the
model is "just a slot" (swap any of 15+ providers mid-session via
`~/.pi/agent/models.json`), context/compaction/guardrails/verify are all
yours to shape ([dalenguyen.me](https://dalenguyen.me/blog/2026-06-07-pi-dev-agent-harness)).
Its signature move is a **self-modifying agent**: when a capability is missing,
Pi writes its own TypeScript extension, `/reload`, and continues — "a preview of
how self-modifiable software might look"
([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/building-pi-and-what-makes-self-modifying)).
Sessions are JSONL trees you can branch and navigate (`/tree`, `/fork`), praised
as "state-of-the-art for going back" ([HN](https://news.ycombinator.com/item?id=46629341)).
It deliberately **omits** sub-agents, plan mode, and MCP — you build them.

**The meta-lesson for wardroom:** Pi's moat is a *thesis* ("the harness is
yours") executed without compromise, not a checklist. Notably, Pi has **no
native multi-agent** — it tells you to run instances in tmux. wardroom's
equivalent uncompromised thesis is orthogonal and available: **"the
orchestration and the audit trail are yours."** That is the lane to own.

---

## 2. The landscape at a glance

| Tool | Core differentiator | Parallel / multi-agent |
|---|---|---|
| **Claude Code** | Became the #1 coding tool; **Agent Teams** (Feb 2026): a lead + peer-messaging teammates on a shared task list; subagents; `/rewind`; Auto-Memory | Yes — Agent Teams (~10), worktrees, background |
| **Codex CLI / Cloud** | Same agent local + async cloud tasks that open PRs and fix CI | Yes — parallel cloud tasks |
| **Cursor** | Dominant AI IDE; **multi-agent with automatic judging** (best-of-N) + background/cloud agents | Yes — per-agent worktrees, judging |
| **Aider** | Git-native: every edit is a discrete conventional commit (history = the log) | Limited |
| **Amp** (Sourcegraph) | Oracle/subagent architecture; "spend tokens liberally"; team-shared threads | Yes — subagents |
| **Cline** | Transparent BYO-key VS Code agent; **Plan/Act** + **Memory Bank** + checkpoints | Emerging |
| **Devin / Jules / Factory** | Fully autonomous cloud "engineers" that return PRs | Yes — cloud VMs |
| **Warp** | The terminal reinvented as a multi-threaded agentic environment | Yes |
| **Kiro / Antigravity / Spec Kit** | Spec-driven development (requirements → design → tasks) | Varies |

Two things stand out. First, **the universal isolation primitive is the git
worktree** — "each agent gets its own worktree, no merge conflicts." wardroom is
the one system that explicitly rejects this. Second, **every shipping
multi-agent system is single-vendor**: Agent Teams is many *Claude* sessions;
Codex is *Codex*. Nobody mixes vendors on one board.

The closest analog to wardroom is **Claude Code Agent Teams** (Feb 2026):
teammates self-claim tasks from JSON files via file locking and coordinate via
peer messages, each in its own worktree. Its documented gaps are telling:
**no shared memory between teammates**, ~4x the token cost of solo, lagging task
status, **no session resumption for teammates**, one team per session
([alexop.dev](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)).
wardroom's memo log and shared board are, almost exactly, the holes Agent Teams
left open.

---

## 3. What developers actually want (desired vs. missing)

### Memory
**Want:** an end to amnesia — memory that persists across sessions, compounds
into learned preferences, is portable across tools (the reason `AGENTS.md` is
now read by Claude Code, Cursor, Copilot, Gemini, Windsurf, Aider, Zed, Warp),
and needs less hand-curation
([mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).
**Missing — and this is the loudest complaint in the whole field:** memory is
**read but not obeyed.** "CLAUDE.md is a wish list, not a contract"; "I wrote
200 lines of rules for Claude Code, it ignored them all"
([dev.to](https://dev.to/minatoplanb/i-wrote-200-lines-of-rules-for-claude-code-it-ignored-them-all-4639));
after compaction the rules file "no longer counts as a rule but as information"
([HN](https://news.ycombinator.com/item?id=46102048)). And **stale memory rots
worse than no memory** — "a note the model wrote is not evidence; it is a claim
waiting to be confirmed" ([TDS](https://towardsdatascience.com/governed-context-managing-context-rot-in-claude-code/)).
Most tools do *codebase* memory (RAG), not *learned* memory. **Net wish: memory
that is obeyed, self-prunes, compounds, is portable, and is visible.**

### Parallelism
**Want:** fan work across agents for real speedups, best-of-N, background PRs.
**Missing / painful:** a **superlinear merge tax** — "conflict resolution was
eating 30-50% of parallel agent time"; "9 parallel agents: a clusterfuck"
([thedailydeveloper](https://thedailydeveloper.substack.com/p/stop-parallelizing-your-ai-agents)).
Worktrees isolate *files but not runtime* (shared ports, DBs, migrations) and add
bookkeeping ([penligent](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/)).
Comparing/merging outputs is manual, and the human becomes the bottleneck past
**3-5 sessions** ("past that you are not coding, you are juggling"
— [Firecrawl](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)).
The real bottleneck isn't compute, it's **whether the next agent knows what
happened.** **Net wish: coordination without the merge tax, runtime isolation,
compact shared "what happened" memory, automated compare/merge.**

### Context management
**Want:** context that doesn't silently degrade; transparency over magic.
**Missing:** "context rot" is now common vocabulary — every frontier model
"gets worse as input length increases... by 30 to 50 percent well before the
documented limit" ([morphllm](https://www.morphllm.com/context-rot)).
Auto-compaction is a top complaint ("auto compact is the worst... claude has
forgotten everything" — [GitHub #13112](https://github.com/anthropics/claude-code/issues/13112),
closed "not planned"). People hand-roll `/handoff` artifacts because the lossy
summary can't be trusted. **Net wish: observable, steerable context — control
over what survives compaction, and a reliable structured handoff.**

### Autonomy vs. control
**Want:** a **dial, not a switch** — plan → bounded unattended run → review →
cheap rollback. Anthropic is candid about the failure: "users approve 93% of
permission prompts... this constant clicking creates dangerous inattention"
with a "17% false-negative rate on dangerous actions"
([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)).
**Missing:** the catastrophic tail — an agent ran `rm -rf /`; Replit's agent
"deleted a user's production database." And `/rewind` **only covers Write/Edit,
not shell side-effects** like `rm`/`mv` — exactly the YOLO failure class.
**Net wish: bounded autonomy with cheap full rollback that also covers shell
side-effects, and visible risk classification.**

### Trust / observability
**Want:** trust earned **per-diff, with receipts.** "96% of developers don't
fully trust AI-generated code; 38% say reviewing it takes more effort than
reviewing human code" ([Builder.io](https://www.builder.io/blog/developers-drowning-in-ai-prs)).
"Every PR needs to show up with receipts" — intent, scoped diff, tests, risks,
a decision log ([O'Reilly](https://www.oreilly.com/radar/agentic-code-review/)).
**Missing:** reviewing large AI diffs is the new bottleneck — AI PRs sit "4.6x
longer," review time "spiked 91%," "1.7x as many bugs"
([HN](https://news.ycombinator.com/item?id=47425058)). And cost is invisible
until the bill: "left Claude Code running overnight, and it cost $6,000"
([MakeUseOf](https://www.makeuseof.com/someone-left-claude-code-running-overnight-and-it-cost-6000/)) —
no live counter, dashboards lag days. A self-reviewing agent has "an inherent
conflict of interest," so independent review layers (CodeRabbit, `/review`)
exist. **Net wish: per-diff receipts, a live cost fuel-gauge with hard caps and
per-agent attribution, and independent (non-self) review.**

### Integration
**Want:** fit existing git/PR/CI without babysitting; clean tool access.
**Missing:** **MCP context bloat** — 40 tools consumed "143,000 of a 200,000
-token window... before a single query," and tool-selection accuracy
"collapsed from 43% to under 14%" ([agentmarketcap](https://agentmarketcap.ai/blog/2026/04/08/mcp-context-bloat-enterprise-scale-tool-definitions-agent-context-budget)),
driving a "switched from MCP to CLI" movement. **Net wish: collapse
branch→PR→CI into one surface with a human sign-off; keep tooling lean.**

---

## 4. The whitespace

Cross-referencing "want" against "shipped," the field has **not** delivered:

1. **Shared, structured, self-maintaining memory that a team of agents actually
   reads and obeys** — everyone's memory rots or is ignored; Agent Teams has no
   shared memory at all.
2. **Coordination without the worktree merge tax** — the universal primitive
   defers conflicts to a superlinear merge.
3. **Per-task / per-agent change records and cost attribution as first-class
   receipts** — the exact "receipts" developers demand, rarely built in.
4. **Runtime (not just file) isolation** — nobody solves shared ports/DBs.
5. **Automated compare/merge of parallel outputs** — still copy-paste.
6. **Cross-CLI / cross-model teams** — every team today is single-vendor.
7. **Spec-driven development wired into multi-agent decomposition** — SDD is the
   fastest-growing 2026 idea (Spec Kit hit ~115k stars in months) but is
   single-agent.

---

## 5. Wardroom's honest position

### Where wardroom already lands on real demand
- **File leases on a shared checkout directly attack the #1 parallelism pain —
  the merge tax.** The field enforces "one writer per file" with N worktrees it
  then has to reconcile; wardroom enforces the same invariant *without* the
  worktrees, so there's no superlinear merge, no worktree bookkeeping. This is a
  legitimately contrarian architectural bet against worktree orthodoxy.
- **Cross-CLI teams (Claude + Codex on one board)** are genuine whitespace —
  every shipping system is single-vendor. Route model-per-task, a pattern people
  already hand-roll.
- **Per-task change records ("see the diff of what each agent did")** map almost
  verbatim onto the "PRs need receipts" demand. Transparency-as-differentiator
  is validated by the trust data.
- **Session-memory writedowns + the shared memo** fill the exact hole Agent
  Teams left: "there's no shared memory" between teammates.

### Whitespace wardroom could *own*
- **Transparency as the product surface** — a live view of what each agent is
  doing, which files it holds, and the diff so far. Owning **in-flight
  stay-in-sync review** (not just post-hoc PR review) is defensible; observability
  "hasn't kept pace with generation speed."
- **Cross-agent review as a first-class loop** — one agent reviews another's
  diff, answering the "self-review = conflict of interest" complaint with
  *independent* review that's still inside the harness (wardroom already has this).
- **Leases as a brandable primitive that extends to runtime** — worktrees don't
  isolate ports/DBs/migrations. Lease *runtime resources* the same way wardroom
  leases files. Nobody solves this.
- **Memory that is obeyed, not just written** — if writedowns are enforced and
  surfaced, wardroom could beat the "CLAUDE.md is a wish list, memory rots"
  failure that plagues everyone.

### Table-stakes wardroom must not miss (the critical part)
1. **Live cost/token fuel-gauge with hard caps + per-agent attribution.**
   Multi-agent multiplies the "$6,000 overnight" risk (~800k tokens for a
   3-agent team). Several CLIs running unattended with no live spend meter is
   unacceptable. wardroom has budgets and per-agent tokens — this should become a
   prominent live gauge, and per-task cost belongs on the change record.
2. **Cheap rollback that also covers shell side-effects.** `/rewind` famously
   doesn't undo `rm`/`mv`. On a shared checkout with multiple writers, robust
   per-task revert — and protection against one agent's `rm` nuking another's
   work — is essential.
3. **A verification gate for semantic and runtime conflicts.** Leases stop
   *text* conflicts, but "semantic errors pass compilation, linting, and even
   basic tests but fail in production," and shared ports/DBs let one agent's dev
   server or migration trample another's. wardroom has a verify gate; it must be
   real, and it needs a runtime-collision story, or the shared checkout becomes a
   liability instead of an advantage. **This is the sharp edge of the whole bet.**
4. **Autonomy dial + approval gates.** Fire-and-forget must still be *bounded*
   (the Replit-deleted-prod-DB lesson): plan mode, bounded auto-run, review
   before the diff is accepted.
5. **Lease + memory persistence across resume**, so a restarted session picks up
   exactly where it left off (Agent Teams can't — wardroom should).
6. **Clean egress to commits/PRs** without recreating "vibe merging."

---

## 6. Recommendation: the differentiated bet

wardroom's design already lands on the two loudest unmet needs — **the merge
tax of parallel agents** and **transparency/receipts for trust** — and its memo
fills Agent Teams' shared-memory hole. The differentiation is real. To make it
*truly* different rather than just a good orchestrator, lean the whole product
into one sentence:

> **The harness where a crew of any-vendor agents runs itself on one checkout,
> and you always have the receipts — what changed, what it cost, and one command
> to undo it.**

Concretely, in rough priority (each ties to a sourced demand above):

1. **Receipts, all the way** (transparency moat). Per-task change records exist;
   add **per-task cost**, a **decision log** (what the agent tried and ruled
   out), and a **live cost/lease/what-changed gauge** in the TUI. This is the
   in-flight review nobody ships. *(Trust §, Whitespace #3.)*
2. **Side-effect-safe rollback** (`wardroom rollback <task>`), including
   protection against cross-agent `rm`. *(Autonomy §, table-stakes #2.)*
3. **A verification gate that catches semantic/runtime conflicts** before a
   task's diff counts as done — the sharp edge of the shared-checkout bet.
   *(Table-stakes #3.)*
4. **Runtime leases** (ports, DB, migrations, the test-suite) alongside file
   leases — genuine whitespace nobody owns. *(Parallelism §, Whitespace #4.)*
5. **Memory that's obeyed and self-maintaining** — surface the memo as an
   enforced brief the crew must read, and prune/verify it so it doesn't rot.
   *(Memory §, Whitespace #1.)*
6. **Cross-vendor routing as a headline feature** — "Claude plans, Codex tests,
   Gemini reviews" on one board. *(Whitespace #6.)*

The strategic risk to keep honest: the shared checkout trades worktree
merge-pain for **semantic/runtime collision-pain**. The moat holds only if
leases *plus verification* make that a net win. That is the thing to get right.

---

## Sources

- **Pi:** [pi.dev](https://pi.dev/) · [GitHub coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) · [Pragmatic Engineer — Building Pi](https://newsletter.pragmaticengineer.com/p/building-pi-and-what-makes-self-modifying) · [dalenguyen.me](https://dalenguyen.me/blog/2026-06-07-pi-dev-agent-harness) · [HN](https://news.ycombinator.com/item?id=46629341)
- **Multi-agent / parallelism:** [alexop.dev — Agent Teams](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/) · [Cursor 2.0](https://cursor.com/blog/2-0) · [Cursor 2.2 judging](https://forum.cursor.com/t/cursor-2-2-multi-agent-judging/145826) · [Firecrawl — Codex orchestration](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration) · [thedailydeveloper — stop parallelizing](https://thedailydeveloper.substack.com/p/stop-parallelizing-your-ai-agents) · [penligent — runtime isolation](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/) · [Augment — multi-agent workspace](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)
- **Memory:** [mem0 — state of agent memory](https://mem0.ai/blog/state-of-ai-agent-memory-2026) · [hackernoon — AGENTS.md](https://hackernoon.com/the-complete-guide-to-ai-agent-memory-files-claudemd-agentsmd-and-beyond) · [dev.to — 200 lines ignored](https://dev.to/minatoplanb/i-wrote-200-lines-of-rules-for-claude-code-it-ignored-them-all-4639) · [HN — rules after compaction](https://news.ycombinator.com/item?id=46102048) · [TDS — governed context](https://towardsdatascience.com/governed-context-managing-context-rot-in-claude-code/) · [Cognee — persistent memory](https://www.cognee.ai/blog/guides/ai-coding-agent-persistent-codebase-memory)
- **Context:** [morphllm — context rot](https://www.morphllm.com/context-rot) · [Breunig — how contexts fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) · [GitHub #13112 — auto-compact](https://github.com/anthropics/claude-code/issues/13112)
- **Autonomy:** [Anthropic — auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) · [ragunath — background agents & autonomy](https://ragunathjawahar.substack.com/p/background-agents-and-autonomy)
- **Trust / observability:** [Builder.io — drowning in AI PRs](https://www.builder.io/blog/developers-drowning-in-ai-prs) · [O'Reilly — agentic code review](https://www.oreilly.com/radar/agentic-code-review/) · [HN — AI PR review tax](https://news.ycombinator.com/item?id=47425058) · [MakeUseOf — $6000 overnight](https://www.makeuseof.com/someone-left-claude-code-running-overnight-and-it-cost-6000/)
- **Integration / MCP:** [agentmarketcap — MCP context bloat](https://agentmarketcap.ai/blog/2026/04/08/mcp-context-bloat-enterprise-scale-tool-definitions-agent-context-budget) · [Firecrawl — MCP vs CLI](https://www.firecrawl.dev/blog/mcp-vs-cli)
- **Spec-driven development:** [MarkTechPost — 9 SDD tools](https://www.marktechpost.com/2026/05/08/9-best-ai-tools-for-spec-driven-development-in-2026-kiro-bmad-gsd-and-more-compare/)
