import path from "path";
import { activeClaims, claimFiles, releaseClaimsForTask, type ClaimConflict } from "./claims.ts";
import { postEvent } from "./events.ts";
import {
  memoDir,
  normalizeAgent,
  normalizeLabel,
  nowIso,
  readJson,
  withLock,
  writeJsonAtomic,
} from "./store.ts";

// ── task board ────────────────────────────────────────────────────────────────
// A dependency-aware work queue for parallel agents on one checkout. The
// orchestrating agent (or the human) plans tasks up front, each declaring the
// files it expects to touch. Worker agents then pull work with
// `claim_next_task`, which atomically:
//
//   1. picks the first pending task whose dependencies are all done,
//   2. AND whose declared files don't overlap another agent's active claim,
//   3. marks it claimed and takes a file lease on its declared paths.
//
// File-overlap-aware scheduling is what makes shared-checkout parallelism
// efficient: two tasks that touch disjoint files run simultaneously; two tasks
// that collide are automatically serialized — no worktree, no merge conflict,
// no human traffic-cop.

const TASKS_FILE = "tasks.json";
const TASK_TTL_MINUTES = 60;

export type TaskStatus = "pending" | "claimed" | "review" | "done" | "failed";

export type Task = {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependsOn: string[];
  status: TaskStatus;
  agent?: string;
  result?: string;
  created: string;
  updated: string;
  // review flow (Phase 4)
  reviewer?: string;
  reviewAttempts?: number;
  diff?: string;
  // footprint telemetry (Phase 4): files actually changed while this task ran,
  // and the subset that fell outside its declared footprint.
  actualFiles?: string[];
  drift?: string[];
};

type TasksState = { nextId: number; tasks: Task[] };

export type TaskInput = {
  title: string;
  description?: string;
  files?: string[];
  depends_on?: string[];
};

function tasksPath(repoPath: string): string {
  return path.join(memoDir(repoPath), TASKS_FILE);
}

function loadState(repoPath: string): TasksState {
  return readJson<TasksState>(tasksPath(repoPath), { nextId: 1, tasks: [] });
}

function saveState(repoPath: string, state: TasksState): void {
  writeJsonAtomic(tasksPath(repoPath), state);
}

function findTask(state: TasksState, taskId: string): Task {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }
  return task;
}

function depsSatisfied(state: TasksState, task: Task): boolean {
  return task.dependsOn.every(
    (depId) => state.tasks.find((t) => t.id === depId)?.status === "done"
  );
}

export function planTasks(
  repoPath: string,
  agent: string,
  inputs: TaskInput[]
): { created: Task[] } {
  const normalizedAgent = normalizeAgent(agent);
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }

  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const created: Task[] = [];
    const knownIds = new Set(state.tasks.map((t) => t.id));

    for (const input of inputs) {
      const id = `task-${state.nextId}`;
      state.nextId += 1;
      const task: Task = {
        id,
        title: normalizeLabel(input.title, "title"),
        description: String(input.description ?? "").trim(),
        files: (input.files ?? []).map((f) => normalizeLabel(f, "file")),
        dependsOn: input.depends_on ?? [],
        status: "pending",
        created: nowIso(),
        updated: nowIso(),
      };
      knownIds.add(id);
      created.push(task);
      state.tasks.push(task);
    }

    // Dependencies may reference tasks created in this same batch by their
    // position ("$0" = first task in the batch) or by an existing task id.
    for (const task of created) {
      task.dependsOn = task.dependsOn.map((dep) => {
        const positional = dep.match(/^\$(\d+)$/);
        if (positional) {
          const ref = created[Number(positional[1])];
          if (!ref) throw new Error(`Bad positional dependency ${dep}`);
          return ref.id;
        }
        if (!knownIds.has(dep)) throw new Error(`Unknown dependency: ${dep}`);
        return dep;
      });
    }

    saveState(repoPath, state);
    postEvent(repoPath, normalizedAgent, "tasks-planned", `Planned ${created.length} task(s)`, {
      tasks: created.map((t) => ({ id: t.id, title: t.title, files: t.files })),
    });
    return { created };
  });
}

export type ClaimNextResult =
  | { status: "claimed"; task: Task }
  | { status: "empty"; reason: string }
  | { status: "all-blocked"; blocked: { task: string; conflicts: ClaimConflict[] }[] };

export function claimNextTask(repoPath: string, agent: string): ClaimNextResult {
  const normalizedAgent = normalizeAgent(agent);

  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const eligible = state.tasks.filter(
      (task) => task.status === "pending" && depsSatisfied(state, task)
    );

    if (eligible.length === 0) {
      const pending = state.tasks.filter((t) => t.status === "pending").length;
      return {
        status: "empty",
        reason:
          pending > 0
            ? `${pending} pending task(s) are waiting on unfinished dependencies`
            : "No pending tasks on the board",
      };
    }

    const blocked: { task: string; conflicts: ClaimConflict[] }[] = [];
    for (const task of eligible) {
      // Tasks with no declared files are assumed conflict-free (research,
      // review, planning work) and always claimable.
      if (task.files.length > 0) {
        const lease = claimFiles(
          repoPath,
          normalizedAgent,
          task.files,
          `task ${task.id}: ${task.title}`,
          TASK_TTL_MINUTES,
          task.id
        );
        if (lease.status === "conflict") {
          blocked.push({ task: task.id, conflicts: lease.conflicts });
          continue;
        }
      }

      task.status = "claimed";
      task.agent = normalizedAgent;
      task.updated = nowIso();
      saveState(repoPath, state);
      postEvent(repoPath, normalizedAgent, "task-claimed", `Claimed ${task.id}: ${task.title}`, {
        task: task.id,
        files: task.files,
      });
      return { status: "claimed", task };
    }

    return { status: "all-blocked", blocked };
  });
}

export function completeTask(
  repoPath: string,
  agent: string,
  taskId: string,
  result: string
): Task {
  return finishTask(repoPath, agent, taskId, "done", result);
}

export function failTask(
  repoPath: string,
  agent: string,
  taskId: string,
  reason: string
): Task {
  return finishTask(repoPath, agent, taskId, "failed", reason);
}

function finishTask(
  repoPath: string,
  agent: string,
  taskId: string,
  status: "done" | "failed",
  result: string
): Task {
  const normalizedAgent = normalizeAgent(agent);
  const normalizedResult = String(result ?? "").trim();
  if (!normalizedResult) {
    throw new Error(status === "done" ? "result cannot be empty" : "reason cannot be empty");
  }

  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const task = findTask(state, taskId);
    if (task.status !== "claimed") {
      throw new Error(`Task ${taskId} is ${task.status}, not claimed`);
    }
    if (task.agent !== normalizedAgent) {
      throw new Error(`Task ${taskId} is claimed by ${task.agent}, not ${normalizedAgent}`);
    }

    task.status = status;
    task.result = normalizedResult;
    task.updated = nowIso();
    saveState(repoPath, state);
    releaseClaimsForTask(repoPath, taskId);
    postEvent(
      repoPath,
      normalizedAgent,
      status === "done" ? "task-done" : "task-failed",
      `${task.id} ${status}: ${normalizedResult}`,
      { task: task.id }
    );
    return task;
  });
}

// ── cross-agent review (Phase 4) ──────────────────────────────────────────────
// When review is enabled, a worker that finishes a task's work does not mark it
// done — it submits the task for review by a DIFFERENT agent. The task moves to
// status "review" (its file lease released, since editing is done and the diff
// is captured), and a reviewer is assigned. That reviewer, between its own
// tasks, picks the task up, reads the diff, and either approves (-> done) or
// requests changes (-> back to pending with notes, for a re-attempt).

const MAX_REVIEW_ATTEMPTS = 2;

export function submitForReview(
  repoPath: string,
  agent: string,
  taskId: string,
  reviewer: string,
  workSummary: string,
  diff: string,
  telemetry?: { actualFiles: string[]; drift: string[] }
): Task {
  const normalizedAgent = normalizeAgent(agent);
  const normalizedReviewer = normalizeAgent(reviewer);
  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const task = findTask(state, taskId);
    if (task.status !== "claimed" || task.agent !== normalizedAgent) {
      throw new Error(`Task ${taskId} is ${task.status} (agent ${task.agent}); cannot submit for review`);
    }
    task.status = "review";
    task.reviewer = normalizedReviewer;
    task.result = String(workSummary ?? "").trim();
    task.diff = diff;
    if (telemetry) {
      task.actualFiles = telemetry.actualFiles;
      task.drift = telemetry.drift;
    }
    task.updated = nowIso();
    saveState(repoPath, state);
    releaseClaimsForTask(repoPath, taskId);
    postEvent(repoPath, normalizedAgent, "task-review", `${task.id} submitted for review by ${normalizedReviewer}`, {
      task: task.id,
      reviewer: normalizedReviewer,
    });
    return task;
  });
}

// A reviewer's pending queue: tasks in "review" assigned to this agent.
export function pendingReviewFor(repoPath: string, reviewer: string): Task | null {
  const normalizedReviewer = normalizeAgent(reviewer);
  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    return (
      state.tasks.find((t) => t.status === "review" && t.reviewer === normalizedReviewer) ?? null
    );
  });
}

export function anyReviewsOutstanding(repoPath: string): boolean {
  return withLock(repoPath, "tasks", () =>
    loadState(repoPath).tasks.some((t) => t.status === "review")
  );
}

export type ReviewVerdict = "approve" | "request-changes";

export function resolveReview(
  repoPath: string,
  reviewer: string,
  taskId: string,
  verdict: ReviewVerdict,
  note: string
): Task {
  const normalizedReviewer = normalizeAgent(reviewer);
  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const task = findTask(state, taskId);
    if (task.status !== "review" || task.reviewer !== normalizedReviewer) {
      throw new Error(`Task ${taskId} is not awaiting review by ${normalizedReviewer}`);
    }

    const attempts = (task.reviewAttempts ?? 0) + 1;
    task.reviewAttempts = attempts;
    task.updated = nowIso();

    if (verdict === "approve") {
      task.status = "done";
      task.result = `${task.result ?? ""}\n[reviewed by ${normalizedReviewer}: approved] ${note}`.trim();
      delete task.reviewer;
      saveState(repoPath, state);
      postEvent(repoPath, normalizedReviewer, "review-approved", `${task.id} approved`, { task: task.id });
    } else if (attempts >= MAX_REVIEW_ATTEMPTS) {
      // Don't loop forever: after the cap, changes-requested becomes a failure
      // that surfaces to the human rather than another silent re-attempt.
      task.status = "failed";
      task.result = `review kept requesting changes after ${attempts} attempts. Last note: ${note}`;
      delete task.reviewer;
      saveState(repoPath, state);
      postEvent(repoPath, normalizedReviewer, "review-failed", `${task.id} failed review after ${attempts} attempts`, { task: task.id });
    } else {
      // Reopen for another attempt; carry the reviewer's notes into the brief.
      task.status = "pending";
      task.description = `${task.description}\n\n[review attempt ${attempts} - changes requested by ${normalizedReviewer}]: ${note}`.trim();
      delete task.agent;
      delete task.reviewer;
      delete task.diff;
      saveState(repoPath, state);
      postEvent(repoPath, normalizedReviewer, "review-changes", `${task.id} sent back for changes`, { task: task.id });
    }
    return task;
  });
}

// Record footprint telemetry on a task at completion time (non-review path).
export function recordTelemetry(
  repoPath: string,
  taskId: string,
  actualFiles: string[],
  drift: string[]
): void {
  withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task) {
      task.actualFiles = actualFiles;
      task.drift = drift;
      saveState(repoPath, state);
    }
  });
}

// Return a claimed task to the board (agent giving up without failing it) or
// reset a failed task for retry.
export function releaseTask(repoPath: string, agent: string, taskId: string): Task {
  const normalizedAgent = normalizeAgent(agent);
  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const task = findTask(state, taskId);
    if (task.status !== "claimed" && task.status !== "failed") {
      throw new Error(`Task ${taskId} is ${task.status}; only claimed or failed tasks can be released`);
    }
    task.status = "pending";
    delete task.agent;
    delete task.result;
    task.updated = nowIso();
    saveState(repoPath, state);
    releaseClaimsForTask(repoPath, taskId);
    postEvent(repoPath, normalizedAgent, "task-released", `${task.id} returned to the board`, {
      task: task.id,
    });
    return task;
  });
}

// Crash recovery. A task left "claimed" whose file lease has since expired was
// orphaned by an agent (or a whole `wardroom run`) that died without
// completing or failing it. Its lease is gone, so no one is protected from
// editing those files — return it to the board so another worker picks it up.
// Called at pool startup and, optionally, on a periodic sweep during a run.
// Healthy in-flight tasks always hold a live lease, so this never touches them.
export function requeueStaleClaims(repoPath: string): string[] {
  return withLock(repoPath, "tasks", () => {
    const state = loadState(repoPath);
    const leasedTaskIds = new Set(
      activeClaims(repoPath).map((claim) => claim.taskId).filter(Boolean)
    );
    const requeued: string[] = [];

    for (const task of state.tasks) {
      if (task.status === "claimed" && !leasedTaskIds.has(task.id)) {
        const orphanedFrom = task.agent;
        task.status = "pending";
        delete task.agent;
        delete task.result;
        task.updated = nowIso();
        requeued.push(task.id);
        postEvent(
          repoPath,
          "wardroom",
          "task-requeued",
          `${task.id} was orphaned by ${orphanedFrom ?? "an agent"} (lease expired) - returned to the board`,
          { task: task.id }
        );
      }
    }

    if (requeued.length > 0) saveState(repoPath, state);
    return requeued;
  });
}

export function listTasks(repoPath: string, status?: TaskStatus): Task[] {
  const state = withLock(repoPath, "tasks", () => loadState(repoPath));
  return status ? state.tasks.filter((t) => t.status === status) : state.tasks;
}

// Human/agent-readable board snapshot.
export function renderBoard(repoPath: string): string {
  const tasks = listTasks(repoPath);
  if (tasks.length === 0) {
    return "Task board is empty. Use plan_tasks to add work.";
  }

  const icon: Record<TaskStatus, string> = {
    pending: "○",
    claimed: "◐",
    review: "◍",
    done: "●",
    failed: "✗",
  };

  const lines = ["# Task Board", ""];
  for (const task of tasks) {
    const who = task.agent ? ` @${task.agent}` : "";
    const deps = task.dependsOn.length > 0 ? ` (after ${task.dependsOn.join(", ")})` : "";
    const files = task.files.length > 0 ? ` [${task.files.join(", ")}]` : "";
    lines.push(`${icon[task.status]} ${task.id}${who} — ${task.title}${deps}${files}`);
    if (task.result) {
      lines.push(`    ↳ ${task.result}`);
    }
  }
  return lines.join("\n");
}
