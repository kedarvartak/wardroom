import { render } from "ink";
import path from "path";
import { createElement as h } from "react";
import type { WardroomConfig } from "./config.ts";
import type { PoolResult } from "./pool.ts";
import { startSession } from "./session.ts";
import { App, createBus } from "./tui/app.ts";

// ── the interactive console ───────────────────────────────────────────────────
// Thin driver: start the keep-alive session, bridge its hooks onto the TUI's
// event bus, and mount the Ink app (src/tui/app.ts). Ink owns the terminal —
// raw mode, resize, incremental paint — until the app exits, then we print the
// session receipt into normal scrollback.

export async function runConsole(repoPath: string, crew: string[], config: WardroomConfig): Promise<void> {
  const bus = createBus();
  const session = startSession(repoPath, crew, config, {
    onChange: (state) => bus.emit({ kind: "state", state }),
    onPhase: (agent, phase, task) =>
      bus.emit({ kind: "phase", agent, phase, task: task ? { id: task.id, title: task.title } : undefined }),
  });

  let result: PoolResult | undefined;
  const app = render(
    h(App, {
      repoPath,
      project: path.basename(repoPath),
      crew,
      session,
      bus,
      onResult: (r) => {
        result = r;
      },
    }),
    { exitOnCtrlC: false }
  );

  await app.waitUntilExit();
  if (result) {
    console.log(
      `wardroom · ${result.completed} done, ${result.failed} failed this session` +
        (result.writedownFile ? ` — writedown ${result.writedownFile}` : "")
    );
  }
  process.exit(0);
}
