// Ledger durability: periodic snapshot to disk so a restart (crash, OOM
// reap, redeploy) doesn't silently lose agents, keys, or spend history —
// the exact gap that made the dashboard's totals drift from the real
// Orbio balance after the server was killed once already.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadSnapshot(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // no snapshot yet, or unreadable — caller starts fresh
  }
}

export function autosave(ledger, path, intervalMs = 3000) {
  let last = "";
  const save = async () => {
    try {
      const json = JSON.stringify(ledger.snapshot());
      if (json === last) return; // nothing changed, skip the write
      await mkdir(dirname(path), { recursive: true });
      const tmp = path + ".tmp";
      await writeFile(tmp, json);
      await rename(tmp, path); // atomic: never leaves a half-written snapshot
      last = json;
    } catch (e) {
      console.error("[persist] snapshot failed:", e.message);
    }
  };
  const timer = setInterval(save, intervalMs);
  // best-effort: catch graceful shutdowns (won't catch a hard OOM kill,
  // but the interval above bounds how much a crash can lose to ~intervalMs)
  process.on("SIGINT", async () => { await save(); process.exit(0); });
  process.on("SIGTERM", async () => { await save(); process.exit(0); });
  return () => clearInterval(timer);
}
