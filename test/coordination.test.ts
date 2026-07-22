import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFiles, claimFiles, pathsOverlap, releaseFiles } from "../src/claims.ts";
import { getContext } from "../src/context.ts";
import { getEvents, postEvent } from "../src/events.ts";
import {
  claimNextTask,
  completeTask,
  listTasks,
  planTasks,
  releaseTask,
  renderBoard,
} from "../src/tasks.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memo-coord-"));
}

// ── path overlap ──────────────────────────────────────────────────────────────

test("literal paths conflict on equality and directory containment", () => {
  assert.equal(pathsOverlap("src/a.ts", "src/a.ts"), true);
  assert.equal(pathsOverlap("src", "src/a.ts"), true);
  assert.equal(pathsOverlap("src/a.ts", "src/b.ts"), false);
  assert.equal(pathsOverlap("src/auth", "src/authx/a.ts"), false);
});

test("globs conflict conservatively", () => {
  assert.equal(pathsOverlap("src/*.ts", "src/a.ts"), true);
  assert.equal(pathsOverlap("src/**", "src/deep/a.ts"), true);
  assert.equal(pathsOverlap("src/*.ts", "docs/a.md"), false);
  assert.equal(pathsOverlap("src/**", "test/**"), false);
  assert.equal(pathsOverlap("src/**", "src/auth/**"), true);
});

// ── file claims ───────────────────────────────────────────────────────────────

test("claims grant, conflict, renew, and release", () => {
  const repo = makeRepo();

  const first = claimFiles(repo, "claude", ["src/auth.ts"], "editing auth");
  assert.equal(first.status, "granted");

  const rival = claimFiles(repo, "codex", ["src/auth.ts"], "also editing auth");
  assert.equal(rival.status, "conflict");
  assert.equal(rival.status === "conflict" && rival.conflicts[0].holder, "claude");

  // Same agent re-claiming renews rather than conflicting or stacking.
  const renewed = claimFiles(repo, "Claude", ["src/auth.ts"], "still editing");
  assert.equal(renewed.status, "granted");
  assert.equal(checkFiles(repo).claims.length, 1);

  releaseFiles(repo, "claude");
  const after = claimFiles(repo, "codex", ["src/auth.ts"], "my turn");
  assert.equal(after.status, "granted");
});

test("expired claims stop blocking", () => {
  const repo = makeRepo();
  const claimsFile = path.join(repo, ".memo", "claims.json");

  claimFiles(repo, "claude", ["src/x.ts"], "short lease");
  const state = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  state.claims[0].expires = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(claimsFile, JSON.stringify(state));

  const result = claimFiles(repo, "codex", ["src/x.ts"], "after expiry");
  assert.equal(result.status, "granted");
});

// ── task board ────────────────────────────────────────────────────────────────

test("scheduler respects dependencies and file overlap", () => {
  const repo = makeRepo();

  planTasks(repo, "claude", [
    { title: "Build API", files: ["src/api/**"] },
    { title: "Build UI", files: ["src/ui/**"] },
    { title: "Wire UI to API", files: ["src/ui/**", "src/api/client.ts"], depends_on: ["$0", "$1"] },
  ]);

  const a = claimNextTask(repo, "claude");
  assert.equal(a.status, "claimed");
  assert.equal(a.status === "claimed" && a.task.title, "Build API");

  // Codex skips the API task's files (held by claude) and gets the UI task.
  const b = claimNextTask(repo, "codex");
  assert.equal(b.status, "claimed");
  assert.equal(b.status === "claimed" && b.task.title, "Build UI");

  // Third task blocked on both dependencies.
  const c = claimNextTask(repo, "gemini");
  assert.equal(c.status, "empty");

  completeTask(repo, "claude", "task-1", "API done, routes in src/api/routes.ts");
  completeTask(repo, "codex", "task-2", "UI done");

  const d = claimNextTask(repo, "gemini");
  assert.equal(d.status, "claimed");
  assert.equal(d.status === "claimed" && d.task.id, "task-3");
});

test("eligible task whose files are leased reports all-blocked", () => {
  const repo = makeRepo();
  claimFiles(repo, "codex", ["src/**"], "manual refactor in flight");
  planTasks(repo, "claude", [{ title: "Touch src", files: ["src/a.ts"] }]);

  const result = claimNextTask(repo, "claude");
  assert.equal(result.status, "all-blocked");
  assert.equal(result.status === "all-blocked" && result.blocked[0].conflicts[0].holder, "codex");
});

test("completing a task releases its file lease and enforces ownership", () => {
  const repo = makeRepo();
  planTasks(repo, "claude", [{ title: "Edit thing", files: ["src/thing.ts"] }]);
  const claimed = claimNextTask(repo, "claude");
  assert.equal(claimed.status, "claimed");

  assert.throws(() => completeTask(repo, "codex", "task-1", "not mine"), /claimed by claude/);

  completeTask(repo, "claude", "task-1", "done");
  assert.equal(checkFiles(repo).claims.length, 0);
  assert.equal(listTasks(repo, "done").length, 1);
});

test("released task returns to pending and is claimable again", () => {
  const repo = makeRepo();
  planTasks(repo, "claude", [{ title: "Flaky work", files: ["src/f.ts"] }]);
  claimNextTask(repo, "claude");
  releaseTask(repo, "claude", "task-1");

  const again = claimNextTask(repo, "codex");
  assert.equal(again.status, "claimed");
});

test("board renders every task with status", () => {
  const repo = makeRepo();
  planTasks(repo, "claude", [{ title: "One" }, { title: "Two", depends_on: ["$0"] }]);
  const board = renderBoard(repo);
  assert.match(board, /task-1/);
  assert.match(board, /task-2/);
  assert.match(board, /after task-1/);
});

// ── events ────────────────────────────────────────────────────────────────────

test("events are sequenced and cursor-pollable", () => {
  const repo = makeRepo();
  postEvent(repo, "claude", "note", "first");
  postEvent(repo, "codex", "note", "second");
  postEvent(repo, "claude", "heads-up", "third");

  const all = getEvents(repo);
  assert.equal(all.events.length, 3);
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3]);

  const newer = getEvents(repo, all.events[1].seq);
  assert.equal(newer.events.length, 1);
  assert.equal(newer.events[0].message, "third");

  const filtered = getEvents(repo, 0, 50, "claude");
  assert.equal(filtered.events.length, 2);
});

// ── concurrency: separate OS processes hammer the same repo ──────────────────

test("parallel writers from separate processes never lose or corrupt events", () => {
  const repo = makeRepo();
  const writers = 4;
  const perWriter = 15;

  const script = `
    import { postEvent } from ${JSON.stringify(path.resolve("src/events.ts"))};
    const [repo, agent, count] = process.argv.slice(2);
    for (let i = 0; i < Number(count); i++) {
      postEvent(repo, agent, "note", agent + " message " + i);
    }
  `;
  const scriptPath = path.join(repo, "writer.mjs");
  fs.writeFileSync(scriptPath, script);

  const children = Array.from(
    { length: writers },
    (_, i) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--experimental-strip-types", scriptPath, repo, `agent${i}`, String(perWriter)],
          (error) => (error ? reject(error) : resolve())
        );
      })
  );

  return Promise.all(children).then(() => {
    const { events } = getEvents(repo, 0, writers * perWriter + 10);
    assert.equal(events.length, writers * perWriter);
    // Every seq exactly once — no lost updates, no duplicates.
    const seqs = new Set(events.map((e) => e.seq));
    assert.equal(seqs.size, writers * perWriter);
    assert.equal(Math.max(...seqs), writers * perWriter);
  });
});

// ── context ───────────────────────────────────────────────────────────────────

test("get_context merges board, claims, and events", () => {
  const repo = makeRepo();
  planTasks(repo, "claude", [{ title: "Do a thing", files: ["src/t.ts"] }]);
  claimFiles(repo, "codex", ["docs/**"], "writing docs");
  postEvent(repo, "gemini", "note", "hello from gemini");

  const context = getContext(repo);
  assert.match(context, /Task board/);
  assert.match(context, /Do a thing/);
  assert.match(context, /codex holds docs/);
  assert.match(context, /hello from gemini/);
});
