import path from "path";
import { memoDir, normalizeAgent, nowIso, readJson, withLock, writeJsonAtomic } from "./store.ts";

// ── presence ──────────────────────────────────────────────────────────────────
// A lightweight "who is on the bridge right now" record. Each agent stamps its
// last-seen time and current activity; the dashboard shows who is active. This
// is the visible half of heartbeating — the invisible half is workers renewing
// their file leases during long tasks (see worker.ts) so a slow task's lease
// can't lapse and get its work requeued out from under it.

const PRESENCE_FILE = "presence.json";
const STALE_MS = 45_000;

type PresenceMap = Record<string, { lastSeen: string; activity: string }>;

export type Presence = { agent: string; activity: string; lastSeen: string; online: boolean };

function presencePath(repoPath: string): string {
  return path.join(memoDir(repoPath), PRESENCE_FILE);
}

export function heartbeat(repoPath: string, agent: string, activity: string): void {
  const normalized = normalizeAgent(agent);
  withLock(repoPath, "presence", () => {
    const map = readJson<PresenceMap>(presencePath(repoPath), {});
    map[normalized] = { lastSeen: nowIso(), activity: activity.slice(0, 80) };
    writeJsonAtomic(presencePath(repoPath), map);
  });
}

export function getPresence(repoPath: string): Presence[] {
  const map = readJson<PresenceMap>(presencePath(repoPath), {});
  const now = Date.now();
  return Object.entries(map)
    .map(([agent, p]) => ({
      agent,
      activity: p.activity,
      lastSeen: p.lastSeen,
      online: now - Date.parse(p.lastSeen) < STALE_MS,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}
