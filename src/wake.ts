import fs from "fs";
import path from "path";

// ── event-driven wake ─────────────────────────────────────────────────────────
// All coordination state is files under .memo/, and every mutation lands via an
// atomic rename — which fs.watch on the directory reports immediately. So
// instead of workers sleeping fixed intervals between claim attempts (paying
// the full interval at EVERY dependency hop), they sleep until the board or the
// leases actually change, with the old interval kept only as a fallback for
// platforms where fs.watch is unreliable. Task pickup latency drops from
// seconds to milliseconds; behavior is otherwise identical.

const WAKE_FILES = new Set(["tasks.json", "claims.json"]);

export function waitForBoardChange(repoPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let watcher: fs.FSWatcher | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        // Already closed.
      }
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      watcher = fs.watch(path.join(repoPath, ".memo"), (_event, filename) => {
        if (filename && WAKE_FILES.has(filename)) done();
      });
      watcher.on("error", done);
    } catch {
      // .memo missing or fs.watch unsupported: the timer is the fallback.
    }
  });
}
