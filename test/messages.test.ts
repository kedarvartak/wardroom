import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getContext } from "../src/context.ts";
import {
  crosstalk,
  getMessages,
  openQuestions,
  sendMessage,
  unreadCount,
} from "../src/messages.ts";
import { renderDashboard, renderLog } from "../src/renderer.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-msg-"));
}

test("messages are sequenced, threaded, and inboxed", () => {
  const repo = makeRepo();

  const q = sendMessage(repo, "codex", "claude", "did task-1 rename /auth/refresh?", "question");
  assert.equal(q.seq, 1);
  assert.equal(q.thread, 1);

  const r = sendMessage(repo, "claude", "codex", "yes, now POST /auth/token/refresh", "info", q.thread);
  assert.equal(r.thread, q.thread);

  const note = sendMessage(repo, "claude", "all", "heads up: auth routes changed");

  // Claude's inbox: only the question — the reply went to codex, and claude's
  // own broadcast to "all" is not its own mail.
  const claudeInbox = getMessages(repo, "claude");
  assert.deepEqual(claudeInbox.messages.map((m) => m.seq), [1]);

  // Codex sees the reply and the broadcast.
  const codexInbox = getMessages(repo, "codex");
  assert.deepEqual(codexInbox.messages.map((m) => m.seq), [2, 3]);
  assert.equal(codexInbox.unread, 0);

  // Thread view returns the whole conversation regardless of addressee.
  const thread = getMessages(repo, "gemini", false, 20, q.thread);
  assert.deepEqual(thread.messages.map((m) => m.seq), [1, 2]);

  assert.equal(note.thread, note.seq);
});

test("unread cursors advance on read and only for the reader", () => {
  const repo = makeRepo();
  sendMessage(repo, "claude", "captain", "keep the legacy alias?", "question");
  sendMessage(repo, "codex", "all", "ui build passing");

  assert.equal(unreadCount(repo, "captain"), 2);
  assert.equal(unreadCount(repo, "gemini"), 1);

  const inbox = getMessages(repo, "captain");
  assert.equal(inbox.messages.length, 2);
  assert.equal(unreadCount(repo, "captain"), 0);
  assert.equal(unreadCount(repo, "gemini"), 1);

  // Peeking with mark_read=false does not advance the cursor.
  sendMessage(repo, "codex", "captain", "another one");
  const peek = getMessages(repo, "captain", true, 20, undefined, false);
  assert.equal(peek.messages.length, 1);
  assert.equal(unreadCount(repo, "captain"), 1);
});

test("open questions are tracked until someone else replies in-thread", () => {
  const repo = makeRepo();
  const q = sendMessage(repo, "codex", "claude", "which zod version?", "question");
  assert.equal(openQuestions(repo).length, 1);

  // The asker following up does not close the question.
  sendMessage(repo, "codex", "claude", "still waiting", "info", q.thread);
  assert.equal(openQuestions(repo).length, 1);

  sendMessage(repo, "claude", "codex", "3.23, pinned in package.json", "info", q.thread);
  assert.equal(openQuestions(repo).length, 0);
});

test("validation: empty body, unknown thread, self-send, blocking non-question", () => {
  const repo = makeRepo();
  assert.throws(() => sendMessage(repo, "a", "b", "   "), /body cannot be empty/);
  assert.throws(() => sendMessage(repo, "a", "b", "hi", "info", 99), /Unknown thread/);
  assert.throws(() => sendMessage(repo, "claude", "Claude", "hi"), /cannot be the same/);
  assert.throws(() => sendMessage(repo, "a", "b", "hi", "info", undefined, true), /only questions/);
});

test("parallel senders from separate processes never lose or corrupt messages", () => {
  const repo = makeRepo();
  const writers = 4;
  const perWriter = 12;

  const script = `
    import { sendMessage } from ${JSON.stringify(path.resolve("src/messages.ts"))};
    const [repo, agent, count] = process.argv.slice(2);
    for (let i = 0; i < Number(count); i++) {
      sendMessage(repo, agent, "all", agent + " message " + i);
    }
  `;
  const scriptPath = path.join(repo, "sender.mjs");
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
    const all = crosstalk(repo, Number.MAX_SAFE_INTEGER);
    assert.equal(all.length, writers * perWriter);
    const seqs = new Set(all.map((m) => m.seq));
    assert.equal(seqs.size, writers * perWriter);
    assert.equal(Math.max(...seqs), writers * perWriter);
  });
});

test("dashboard and log render crosstalk and open questions", () => {
  const repo = makeRepo();
  sendMessage(repo, "codex", "claude", "refresh route?", "question");
  sendMessage(repo, "claude", "captain", "need a decision on aliases", "question");

  const dashboard = renderDashboard(repo);
  assert.match(dashboard, /crosstalk/);
  assert.match(dashboard, /refresh route\?/);
  assert.match(dashboard, /unanswered/);
  assert.match(dashboard, /message\(s\) for you/);

  const log = renderLog(repo);
  assert.match(log, /\[codex->claude\] \(question\) refresh route\?/);
});

test("get_context includes crosstalk and unanswered questions", () => {
  const repo = makeRepo();
  sendMessage(repo, "gemini", "codex", "who owns src/api?", "question");
  const context = getContext(repo);
  assert.match(context, /Crosstalk/);
  assert.match(context, /gemini -> codex \[question\]: who owns src\/api\?/);
  assert.match(context, /Unanswered questions/);
});

test("cli: board and say work end to end", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".memo"));
  const cli = path.resolve("src/cli.ts");

  const sayOut = execFileSync(
    process.execPath,
    ["--experimental-strip-types", cli, "say", "hello crew", "--to", "claude", "--kind", "question"],
    { cwd: repo, encoding: "utf8" }
  );
  assert.match(sayOut, /sent #1 captain -> claude/);

  const boardOut = execFileSync(process.execPath, ["--experimental-strip-types", cli, "board"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(boardOut, /Task board is empty/);
});
