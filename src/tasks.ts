import path from "path";
import { claimFiles, releaseClaimsForTask, type ClaimConflict } from "./claims.ts";
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

export type TaskStatus = "pending" | "claimed" | "done" | "failed";

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
