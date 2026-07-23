import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WardroomConfig } from "../src/config.ts";
import { startSession } from "../src/session.ts";
import { computeStats } from "../src/stats.ts";
import { claimNextTask, listTasks, planTasks, type Task } from "../src/tasks.ts";
import { waitForBoardChange } from "../src/wake.ts";

function makeGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-sched-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

// ── critical-path claiming ────────────────────────────────────────────────────

test("claiming prefers the task that unblocks the most downstream work", () => {
  const repo = makeGitRepo();
  // Board order puts the leaf first; the unlocker has a 2-deep dependent chain.
  planTasks(repo, "conductor", [
    { title: "leaf", files: ["docs/a.md"] },
    { title: "unlocker", files: ["src/types.ts"] },
    { title: "mid", files: ["src/api.ts"], depends_on: ["$1"] },
    { title: "tail", files: ["src/ui.ts"], depends_on: ["$2"] },
  ]);

  const first = claimNextTask(repo, "claude");
  assert.equal(first.status === "claimed" && first.task.title, "unlocker");
  // Next claim (different agent) falls through to the leaf.
  const second = claimNextTask(repo, "codex");
  assert.equal(second.status === "claimed" && second.task.title, "leaf");
});

test("assignee routing still wins over critical-path priority", () => {
  const repo = makeGitRepo();
  planTasks(repo, "conductor", [
    { title: "big unlocker for codex", files: ["src/core.ts"], assignee: "codex" },
    { title: "dependent", files: ["src/a.ts"], depends_on: ["$0"] },
    { title: "small claude task", files: ["docs/b.md"] },
  ]);
  const claim = claimNextTask(repo, "claude");
  // claude cannot take codex's unlocker, however important it is.
  assert.equal(claim.status === "claimed" && claim.task.title, "small claude task");
});

// ── event-driven wake ─────────────────────────────────────────────────────────

test("waitForBoardChange wakes on a board write, not on the timeout", async () => {
  const repo = makeGitRepo();
  fs.mkdirSync(path.join(repo, ".memo"), { recursive: true });
  const started = Date.now();
  const wait = waitForBoardChange(repo, 10_000);
  setTimeout(() => planTasks(repo, "conductor", [{ title: "wake up", files: [] }]), 150);
  await wait;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `expected event wake, got ${elapsed}ms (timeout fallback?)`);
});

test("waitForBoardChange falls back to the timeout when nothing changes", async () => {
  const repo = makeGitRepo();
  fs.mkdirSync(path.join(repo, ".memo"), { recursive: true });
  const started = Date.now();
  await waitForBoardChange(repo, 300);
  assert.ok(Date.now() - started >= 280);
});

test("an idle keep-alive worker picks up new work in well under the old poll interval", async () => {
  const repo = makeGitRepo();
  const AGENT = `
import fs from "fs";
fs.appendFileSync("did.txt", process.argv[2] + "\\n");
console.log("ok");
`;
  const file = path.join(repo, "fake.mjs");
  fs.writeFileSync(file, AGENT);
  const config: WardroomConfig = {
    agents: { claude: { adapter: "gemini", bin: process.execPath, args: [file, "claude"] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: "claude",
  };
  const session = startSession(repo, ["claude"], config, {});
  // Let the worker reach its idle wait.
  await new Promise((r) => setTimeout(r, 600));

  const planned = Date.now();
  planTasks(repo, "conductor", [{ title: "instant", files: ["src/x.ts"] }]);
  const deadline = planned + 1_200;
  let done = false;
  while (Date.now() < deadline) {
    if (listTasks(repo, "done").length === 1) {
      done = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await session.stop();
  assert.ok(done, "task was not picked up within 1.2s of planning (event wake not working)");
});

// ── stats ─────────────────────────────────────────────────────────────────────

function fakeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    title: partial.id,
    description: "",
    files: [],
    dependsOn: [],
    status: "done",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:01:00.000Z",
    ...partial,
  } as Task;
}

test("computeStats: speedup, utilization, ready-wait, and the critical path", () => {
  const t = (sec: number) => `2026-01-01T00:0${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}.000Z`;
  const tasks: Task[] = [
    // a: 0..60 on claude. b: 0..60 on codex (parallel). c: depends on a,
    // ready at 60, claimed at 70 (10s wait), runs 70..130 on claude.
    fakeTask({ id: "a", agent: "claude", claimedAt: t(0), created: t(0), updated: t(60) }),
    fakeTask({ id: "b", agent: "codex", claimedAt: t(0), created: t(0), updated: t(60) }),
    fakeTask({ id: "c", agent: "claude", dependsOn: ["a"], created: t(0), claimedAt: t(70), updated: t(130) }),
    fakeTask({ id: "d", status: "pending", created: t(0) }), // unfinished: excluded
  ];

  const stats = computeStats(tasks)!;
  assert.equal(stats.finished, 3);
  assert.equal(stats.unfinished, 1);
  assert.equal(stats.wallClockMs, 130_000);
  assert.equal(stats.serialMs, 180_000);
  assert.ok(Math.abs(stats.speedup - 180 / 130) < 1e-9);

  const c = stats.waits.find((w) => w.id === "c")!;
  assert.equal(c.waitMs, 10_000);
  assert.equal(c.runMs, 60_000);

  const claude = stats.agents.find((a) => a.agent === "claude")!;
  assert.equal(claude.tasks, 2);
  assert.equal(claude.busyMs, 120_000);

  assert.deepEqual(stats.criticalPath.ids, ["a", "c"]);
  assert.equal(stats.criticalPath.ms, 120_000);
});

test("computeStats returns null with no finished timed tasks", () => {
  assert.equal(computeStats([fakeTask({ id: "x", status: "pending" })]), null);
});
