import { Box, Static, Text, useApp, useInput } from "ink";
import { createElement as h, Fragment, useEffect, useReducer, useRef, useState } from "react";
import { changeSummary } from "../git.ts";
import { crosstalk } from "../messages.ts";
import { sendMessage } from "../messages.ts";
import type { PoolResult, PoolState } from "../pool.ts";
import type { Session } from "../session.ts";
import { getTask, listTasks, type Task } from "../tasks.ts";
import type { WorkerPhase } from "../worker.ts";
import { parseSlash, SLASH_HELP, type SlashCommand } from "./commands.ts";
import { fmtElapsed, fmtTokens, SPINNER, STATUS_GLYPH, type TranscriptItem } from "./format.ts";
import { agentColor, theme } from "./theme.ts";

// ── the conductor console, Claude Code style ─────────────────────────────────
// React rendered to the terminal via Ink (the same architecture Claude Code
// uses): no alternate screen, no manual repaint loop. The transcript — your
// commands, conductor dispatches, task starts/finishes, crosstalk — flows into
// normal terminal scrollback through <Static>, rendered once each. Only the
// small live region at the bottom re-renders: one status line per agent, the
// board strip, a rounded input box, and a hint line. Yoga flexbox does the
// layout; resize and wrapping are Ink's problem, not ours.

export type BusEvent =
  | { kind: "state"; state: PoolState }
  | { kind: "phase"; agent: string; phase: WorkerPhase; task?: { id: string; title: string } };

export type Bus = {
  subscribe: (fn: (ev: BusEvent) => void) => () => void;
  emit: (ev: BusEvent) => void;
};

// The session starts (and its hooks fire) before Ink mounts the app, so the
// bus buffers events until the first subscriber attaches and replays them —
// the transcript never misses an early claim.
export function createBus(): Bus {
  const listeners = new Set<(ev: BusEvent) => void>();
  const backlog: BusEvent[] = [];
  return {
    subscribe(fn) {
      for (const ev of backlog.splice(0)) fn(ev);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(ev) {
      if (listeners.size === 0) {
        backlog.push(ev);
        if (backlog.length > 500) backlog.shift();
        return;
      }
      for (const fn of listeners) fn(ev);
    },
  };
}

export type AppProps = {
  repoPath: string;
  project: string;
  crew: string[];
  session: Session;
  bus: Bus;
  onResult: (result: PoolResult) => void;
};

function statusColor(status: Task["status"]): string {
  if (status === "done") return theme.good;
  if (status === "failed") return theme.bad;
  if (status === "pending") return theme.faint;
  return theme.warn;
}

// ── transcript rows (rendered once, into scrollback) ─────────────────────────

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "banner":
      return h(
        Box,
        { flexDirection: "column", marginBottom: 1 },
        h(
          Text,
          null,
          h(Text, { color: theme.accent }, "✻ "),
          h(Text, { bold: true }, "wardroom"),
          h(Text, { color: theme.dim }, `  ${item.project} · crew ${item.crew.join(", ")}`)
        ),
        h(Text, { color: theme.faint }, "  command the conductor below · /help for crew control · /quit stands down")
      );
    case "user":
      return h(
        Box,
        { marginTop: 1 },
        h(Text, { color: theme.faint }, "> "),
        h(Text, { color: theme.text }, item.text)
      );
    case "conductor":
      return h(
        Text,
        null,
        h(Text, { color: theme.accent }, "✻ conductor "),
        h(Text, { color: theme.text }, item.text)
      );
    case "agent": {
      const glyph = item.note === "fail" ? "✗ " : "● ";
      const glyphColor = item.note === "fail" ? theme.bad : item.note === "done" ? theme.good : agentColor(item.agent);
      const verb = item.note === "start" ? "started" : item.note === "done" ? "finished" : "failed";
      return h(
        Text,
        null,
        h(Text, { color: glyphColor }, glyph),
        h(Text, { color: agentColor(item.agent) }, item.agent),
        h(Text, { color: theme.dim }, ` ${verb} `),
        h(Text, { color: theme.text }, item.text)
      );
    }
    case "talk":
      return h(
        Text,
        null,
        h(Text, { color: theme.faint }, "  "),
        h(Text, { color: agentColor(item.from) }, item.from),
        h(Text, { color: theme.faint }, " → "),
        h(Text, { color: item.to === "captain" ? theme.warn : agentColor(item.to) }, item.to),
        item.note === "question" ? h(Text, { color: theme.warn }, " [question]") : null,
        h(Text, { color: theme.text }, "  " + item.body)
      );
    case "info":
      return h(Text, { color: theme.dim }, "  " + item.text);
  }
}

// ── live region ──────────────────────────────────────────────────────────────

function AgentRow({ pane, frame }: { pane: PoolState["panes"][number]; frame: number }) {
  const busy = pane.phase === "working" || pane.phase === "verifying" || pane.phase === "claimed";
  const dot = busy ? SPINNER[frame % SPINNER.length] : pane.phase === "failed" ? "✗" : "●";
  const last = pane.lines[pane.lines.length - 1];
  return h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { color: agentColor(pane.agent), dimColor: !busy }, `${dot} ${pane.agent}`),
    h(Text, { color: theme.dim }, ` ${pane.phase}`),
    pane.taskId ? h(Text, { color: theme.text }, ` ${pane.taskId} · ${pane.taskTitle ?? ""}`) : null,
    busy && last ? h(Text, { color: theme.faint }, `  ${last}`) : null,
    pane.tokens > 0 ? h(Text, { color: theme.faint }, `  ${fmtTokens(pane.tokens)} tok`) : null
  );
}

function BoardStrip({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return h(Text, { color: theme.faint }, "○ board empty");
  const done = tasks.filter((t) => t.status === "done").length;
  return h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { color: theme.dim }, "board "),
    ...tasks
      .slice(-20)
      .map((t) =>
        h(Text, { key: t.id, color: statusColor(t.status) }, `${STATUS_GLYPH[t.status]}${t.id.replace("task-", "")} `)
      ),
    h(Text, { color: theme.faint }, ` ${done}/${tasks.length} done`)
  );
}

export function App(props: AppProps) {
  const { repoPath, crew, session, bus } = props;
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>([
    { kind: "banner", project: props.project, crew },
  ]);
  const push = (...added: TranscriptItem[]) => setItems((prev) => [...prev, ...added]);

  // The pool mutates one state object in place; keep it in a ref and bump a
  // counter to re-render, instead of deep-cloning panes on every event.
  const stateRef = useRef<PoolState>({
    startedAt: Date.now(),
    panes: crew.map((agent) => ({ agent, phase: "idle", lines: [], tokens: 0, completed: 0, failed: 0 })),
  });
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [frame, setFrame] = useState(0);
  const talkSeq = useRef(0);

  useEffect(
    () =>
      bus.subscribe((ev) => {
        if (ev.kind === "state") {
          stateRef.current = ev.state;
          bump();
          return;
        }
        const { agent, phase, task } = ev;
        if (!task) return;
        if (phase === "claimed") push({ kind: "agent", agent, note: "start", text: `${task.id} · ${task.title}` });
        if (phase === "done") {
          const stat = changeSummary(getTask(repoPath, task.id)?.changes);
          push({ kind: "agent", agent, note: "done", text: `${task.id} · ${task.title}${stat ? `  (${stat})` : ""}` });
        }
        if (phase === "failed") push({ kind: "agent", agent, note: "fail", text: `${task.id} · ${task.title}` });
      }),
    []
  );

  // Poll the durable state the pool does not push: the board and crosstalk.
  useEffect(() => {
    const t = setInterval(() => {
      setTasks(listTasks(repoPath));
      const fresh = crosstalk(repoPath, 50).filter((m) => m.seq > talkSeq.current);
      if (fresh.length > 0) {
        talkSeq.current = fresh[fresh.length - 1].seq;
        push(...fresh.map((m): TranscriptItem => ({ kind: "talk", from: m.from, to: m.to, note: m.kind, body: m.body })));
      }
    }, 700);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  const shutdown = () => {
    if (stopping) return;
    setStopping(true);
    void session.stop().then((result) => {
      props.onResult(result);
      exit();
    });
  };

  const runSlash = (cmd: SlashCommand) => {
    switch (cmd.kind) {
      case "quit":
        return void shutdown();
      case "help":
        return push(...SLASH_HELP.map((text): TranscriptItem => ({ kind: "info", text })));
      case "crew": {
        const conductor = session.config.conductor || session.config.planner;
        const roster = session.crew().map((name): TranscriptItem => {
          const a = session.config.agents[name];
          return {
            kind: "info",
            text: `${name}  (${a?.adapter ?? "?"} adapter)${name === conductor ? "  — conductor" : ""}`,
          };
        });
        return push(...roster, { kind: "info", text: `review: ${session.config.review}` });
      }
      case "say":
        sendMessage(repoPath, "captain", "all", cmd.body);
        return;
      case "add": {
        const r = session.addAgent(cmd.name, cmd.vendor);
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "drop": {
        const r = session.removeAgent(cmd.name);
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "conductor": {
        const r = session.setConductor(cmd.name);
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "review": {
        const r = session.setReview(cmd.policy);
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "budget": {
        if (cmd.show) {
          const b = session.config.budget;
          const cap = !b ? "none" : b.tokens !== undefined ? `${fmtTokens(b.tokens)} tokens` : `$${b.usd}`;
          const spent = stateRef.current.panes.reduce((sum, p) => sum + p.tokens, 0);
          return push({ kind: "info", text: `budget: ${cap} · spent this session: ${fmtTokens(spent)} tok` });
        }
        const r = session.setBudget(cmd.clear ? undefined : { tokens: cmd.tokens, usd: cmd.usd });
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "verify": {
        if (cmd.show) {
          return push({ kind: "info", text: `verify gate: ${session.config.verify ?? "none"}` });
        }
        const r = session.setVerify(cmd.clear ? undefined : cmd.command);
        return push({ kind: "info", text: r.ok ? r.detail : r.error });
      }
      case "error":
        return push({ kind: "info", text: cmd.message });
    }
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") return shutdown();
    if (stopping) return;
    if (key.return) {
      const line = input.trim();
      setInput("");
      if (!line) return;
      const slash = parseSlash(line);
      if (slash) {
        if (slash.kind !== "quit") push({ kind: "user", text: line });
        runSlash(slash);
        return;
      }
      push({ kind: "user", text: line });
      setThinking(true);
      session
        .command(line)
        .then(({ created, note }) => {
          setThinking(false);
          if (created.length > 0) {
            push(
              { kind: "conductor", text: `dispatched ${created.length} task(s)` },
              ...created.map(
                (t): TranscriptItem => ({
                  kind: "info",
                  text: `${t.id}  ${t.title}${t.assignee ? `  @${t.assignee}` : ""}`,
                })
              )
            );
          } else if (note) {
            push({ kind: "conductor", text: note });
          }
        })
        .catch((e: unknown) => {
          setThinking(false);
          push({ kind: "info", text: `conductor error · ${e instanceof Error ? e.message : String(e)}` });
        });
      return;
    }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
  });

  const panes = stateRef.current.panes;
  const tokens = panes.reduce((sum, p) => sum + p.tokens, 0);
  const spin = SPINNER[frame % SPINNER.length];

  return h(
    Fragment,
    null,
    h(Static<TranscriptItem>, {
      items,
      children: (item, i) => h(TranscriptRow, { key: i, item }),
    }),
    h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...panes.map((p) => h(AgentRow, { key: p.agent, pane: p, frame })),
      h(BoardStrip, { tasks }),
      thinking || stopping
        ? h(Text, { color: theme.accent }, `${spin} ${stopping ? "standing down the crew…" : "conductor is thinking…"}`)
        : null,
      h(
        Box,
        { borderStyle: "round", borderColor: theme.border, paddingX: 1 },
        h(
          Text,
          { wrap: "truncate-start" },
          h(Text, { color: theme.accent }, "> "),
          h(Text, { color: theme.text }, input),
          stopping ? null : h(Text, { inverse: true }, " ")
        )
      ),
      h(
        Box,
        { justifyContent: "space-between", paddingX: 1, marginBottom: 1 },
        h(Text, { color: theme.faint }, "enter send · /help commands · /quit exit"),
        h(Text, { color: theme.faint }, `${fmtElapsed(Date.now() - stateRef.current.startedAt)} · ${fmtTokens(tokens)} tok`)
      )
    )
  );
}
