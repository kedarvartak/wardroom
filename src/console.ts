import path from "path";
import readline from "readline";
import { renderBridge, type BridgeModel } from "./bridge.ts";
import type { WardroomConfig } from "./config.ts";
import { sendMessage } from "./messages.ts";
import type { PoolState } from "./pool.ts";
import { startSession } from "./session.ts";

// ── the interactive console (full-screen TUI) ─────────────────────────────────
// A proper agent-harness bridge: a header, a live board strip, side-by-side
// agent panes updating in parallel, a crosstalk feed, and a bordered input box.
// You command the conductor; the crew works in front of you. Presentation is
// bridge.ts (pure); this owns terminal I/O — alt screen, raw-mode keystrokes,
// the redraw loop, and clean teardown.

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CLEAR = "\x1b[2J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const HOME = "\x1b[H";

export async function runConsole(repoPath: string, crew: string[], config: WardroomConfig): Promise<void> {
  const out = process.stdout;
  const project = path.basename(repoPath);

  let state: PoolState = {
    startedAt: Date.now(),
    panes: crew.map((agent) => ({ agent, phase: "idle", lines: [], tokens: 0, completed: 0, failed: 0 })),
  };
  let input = "";
  let busy: string | null = null;
  let flash: NodeJS.Timeout | null = null;
  let stopping = false;

  const session = startSession(repoPath, crew, config, {
    onChange: (s) => { state = s; },
  });

  const draw = () => {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const tokens = state.panes.reduce((sum, p) => sum + p.tokens, 0);
    const model: BridgeModel = { project, state, input, busy, tokens };
    const { lines, cursorRow, cursorCol } = renderBridge(repoPath, model, cols, rows);
    out.write(HIDE + HOME + lines.join("\r\n") + `\x1b[${cursorRow};${cursorCol}H` + SHOW);
  };

  const setFlash = (msg: string, ms = 2800) => {
    busy = msg;
    if (flash) clearTimeout(flash);
    flash = setTimeout(() => { busy = null; flash = null; }, ms);
  };

  const timer = setInterval(draw, 120);

  const cleanup = () => {
    clearInterval(timer);
    if (flash) clearTimeout(flash);
    out.removeListener("resize", onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write(SHOW + ALT_OFF);
  };

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    busy = "standing down the crew…";
    draw();
    const result = await session.stop();
    cleanup();
    out.write(
      `wardroom · ${result.completed} done, ${result.failed} failed this session` +
        (result.writedownFile ? ` — writedown ${result.writedownFile}` : "") +
        "\n"
    );
    process.exit(0);
  };

  function onResize() { out.write(CLEAR); draw(); }

  function onKey(str: string | undefined, key: readline.Key): void {
    if (key && key.ctrl && key.name === "c") { void shutdown(); return; }
    if (busy && !flash) return; // a command is being interpreted; only ctrl-c

    if (key && (key.name === "return" || key.name === "enter")) {
      const line = input.trim();
      input = "";
      if (!line) return;
      if (line === "/quit" || line === "/exit") { void shutdown(); return; }
      if (line.startsWith("/say ")) {
        const msg = line.slice(5).trim();
        if (msg) sendMessage(repoPath, "captain", "all", msg);
        return;
      }
      if (flash) { clearTimeout(flash); flash = null; }
      busy = "conductor · interpreting…";
      session
        .command(line)
        .then(({ created, note }) => {
          if (created.length === 0 && note) setFlash("conductor · " + note);
          else busy = null;
        })
        .catch((e) => setFlash("conductor error · " + (e instanceof Error ? e.message : String(e)), 3500));
      return;
    }
    if (key && (key.name === "backspace" || key.name === "delete")) { input = input.slice(0, -1); return; }
    if (str && !key?.ctrl && !key?.meta && str >= " ") { input += str; return; }
  }

  // ── terminal setup ────────────────────────────────────────────────────────
  out.write(ALT_ON + CLEAR);
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", onKey);
  out.on("resize", onResize);
  process.on("SIGTERM", () => void shutdown());
  draw();
}
