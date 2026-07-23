# Parallel Coding Agents Without Worktrees — Research & Rationale

> Why wardroom v0.2 is a **shared-checkout coordination server** rather
> than another isolation tool. Research snapshot: July 2026.

---

## 1. The three ways to parallelize coding agents

### 1a. Isolation: worktrees / branches / containers (the dominant paradigm)

Every major tool converged on *structural avoidance*: give each agent its own
copy of the tree so conflicts are impossible **during execution**.

- **Claude Code** — `claude --worktree <name>`: separate checkout per session,
  own branch ([docs](https://code.claude.com/docs/en/common-workflows)).
- **Cursor cloud agents** — fresh isolated VM per task, `agent/<slug>` branch,
  delivery via PR.
- **OpenAI Codex cloud tasks** — isolated container per task, diff/PR per task.
- **Dagger container-use** — MCP server, container + branch per agent; "merge
  conflicts do not occur during agent execution, as no two agents work on the
  same branch simultaneously" ([repo](https://github.com/dagger/container-use)).

**The catch: isolation defers conflicts, it does not resolve them.** The
conflict still happens — at merge time, when context is at its worst:

- Empirical PR-mining studies put agent merge-conflict rates high:
  **27.67%** of 142K+ agentic PRs had merge conflicts
  ([AgenticFlict, arXiv:2604.03551](https://arxiv.org/pdf/2604.03551)); replayed
  merges of temporally co-active agent PR pairs show **19.8%** textual conflict
  for same-agent pairs and **41.7% for cross-agent pairs** — exactly the
  Claude + Codex + Gemini scenario this project targets
  ([arXiv:2607.04697](https://arxiv.org/abs/2607.04697v2)).
- Shared "hotspot" files (route tables, configs, registries, lockfiles,
  barrel exports) collide predictably across branches; guides advise simply not
  touching them in parallel ([Augment Code guide](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)).
- Each worktree agent is blind to sibling decisions. The standard remedy —
  "merge one branch at a time, diff against main" — means **a human serializes
  integration by hand**, which is the bottleneck the parallelism was supposed
  to remove.

Worktrees are the right tool **when tasks have clean separation of concerns**.
When tasks touch overlapping files — refactors, cross-cutting features, shared
types — isolation converts a cheap coordination problem into an expensive
merge problem.

### 1b. Internal parallelism: subagents

Claude Code subagents (and equivalents) fan work out inside one harness. The
documented limits make them the wrong shape for parallel *editing*:

- Each subagent starts with a **fresh, isolated context** — it sees neither the
  parent conversation nor sibling subagents
  ([docs](https://code.claude.com/docs/en/sub-agents)).
- Anthropic's own engineering write-up on their multi-agent research system:
  the orchestrator "can't steer subagents, subagents can't coordinate," results
  funnel synchronously through one lead, and the system blocks on the slowest
  child. Token cost: **~15× a normal chat**
  ([Anthropic engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)).
- Community guidance is consistent: subagents suit **read-heavy fan-out**
  (research, search, review). Coupled write-work belongs on the main thread.

So the user intuition "internal parallelized agents are ineffective" is
well-supported *for concurrent editing*: subagents are a map-reduce over
reads, not a team of writers.

### 1c. Shared checkout + coordination (the gap this project fills)

One working tree, multiple full agents (Claude Code, Codex, Gemini CLI — each
with its own context, model, and terminal), coordinated through an advisory
layer. This is the classic **blackboard architecture**, recently revived for
LLM multi-agent systems (arXiv [2507.01701](https://arxiv.org/abs/2507.01701),
[2510.01285](https://arxiv.org/abs/2510.01285); MetaGPT's shared message pool
is the best-known coding instance).

Existing tools in this niche and what they validate:

| Tool | Mechanism | Lesson |
|---|---|---|
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Markdown inbox threads + **advisory file leases with TTLs** | Leases + messaging is the right primitive pair |
| [Beads](https://github.com/steveyegge/beads) (~25k★) | Dependency-DAG issue tracker; `bd ready` + **atomic claim** | Agents need a ready-work queue with race-free claiming |
| [claude-task-master](https://github.com/eyaltoledano/claude-task-master) | Task decomposition + orchestrator/executor roles | Plan-then-pull beats ad-hoc dispatch |
| [multi-agent-coordination-mcp](https://github.com/AndrewDavidRivers/multi-agent-coordination-mcp) | Auto file-lock per work item, conflict-free scheduling | File-overlap-aware scheduling works |

Notably, every shipped shared-checkout tool chose **advisory** coordination
over mandatory OS-level locking: agents that cooperate through a protocol,
with TTLs so a crashed agent can't deadlock the repo. Git remains the
optimistic-concurrency backstop.

---

## 2. Why conflicts are prevented, not merged, in v0.2

Pessimistic vs optimistic concurrency is a cost question:

- **Optimistic** (worktrees; detect at merge) is right when collisions are
  *rare* and retries are *cheap*. Agent PR data says collisions are **not
  rare** (27–42% when co-active), and an agent merge retry is *expensive* —
  the merging context has neither author's reasoning.
- **Pessimistic-advisory** (leases; prevent before edit) costs a tool call and
  occasionally serializes two tasks. When two tasks touch the same file,
  serializing them is not a loss of parallelism — it is the *correct
  schedule*. Running them "in parallel" in worktrees just runs them serially
  anyway, with the serialization performed by a human resolving the merge.

Hence the v0.2 design rule: **parallelism is scheduled at planning time by
file footprint, and enforced at claim time by leases.** Disjoint-file tasks
run truly concurrently; overlapping-file tasks are automatically ordered.

## 3. What makes shared-checkout parallelism *efficient* (not just safe)

From practitioner reports and the studies above, four practices matter most:

1. **File-scoped task decomposition.** Tasks must be "genuinely independent —
   different files, different concerns." v0.2 makes the file footprint a
   first-class field on every task, so decomposition quality is visible and
   checkable at planning time.
2. **Hotspot serialization.** Route tables, config, barrel files, lockfiles:
   declare them in the footprint of every task that touches them and let the
   scheduler serialize; or claim them explicitly for the duration of a
   cross-cutting change.
3. **Interface-first splitting.** Land shared types/contracts as an early
   task; make implementation tasks `depends_on` it. Dependencies are
   first-class in the v0.2 board (including `$0` positional refs at planning
   time).
4. **Communication over inference.** An agent that renames a symbol posts an
   event; other agents poll cheaply with a cursor before touching shared
   surfaces. This replaces the "discover the rename at merge time" failure
   mode with a one-line heads-up.

One caveat shared-checkout coordination cannot remove: agents in one tree also
share **build artifacts and test runs**. Two agents running the full test
suite simultaneously can interfere (ports, temp dirs, generated files).
Practical mitigations: claim a virtual path like `build/` around full-suite
runs, or scope test runs to the task's files. This is the honest trade
against worktrees — you trade merge conflicts for occasional runtime
contention, which leases handle the same way they handle files.

## 4. Where each approach wins

| Scenario | Best approach |
|---|---|
| Independent features, disjoint subsystems, long-running risky experiments | **Worktrees** — isolation is free when nothing overlaps |
| Read-heavy fan-out: research, code search, multi-file review | **Subagents** — cheap map-reduce over reads |
| Cross-cutting work, refactors, tightly-coupled features, shared hotspots — or any mix where footprints overlap | **Shared checkout + coordination (this project)** |

The approaches compose: nothing stops a coordinated agent from also spawning
read-only subagents, or a genuinely independent task from being farmed to a
worktree. The coordination layer is for the work that *can't* be cleanly
isolated — which practitioner reports suggest is most real-world work on a
mature codebase.
