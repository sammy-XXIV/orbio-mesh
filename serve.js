// Runs the full mesh with continuous demo traffic, and serves the dashboard.
// Open the printed URL. Set ORBIO_UPSTREAM + ORBIO_KEY to use the real gateway.
import { spawn } from "node:child_process";
import { Ledger, DEFAULT_ACCOUNT } from "./src/ledger.js";
import { createProxy } from "./src/proxy.js";
import { Router } from "./src/router.js";
import { loadSnapshot, autosave } from "./src/persist.js";
import { Governor } from "./src/governor.js";

// Keep the desk up through transient network blips (RPC/catalogue fetches):
// log and continue rather than letting one rejected fetch kill the server.
process.on("unhandledRejection", (e) => console.error("[warn] unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("[warn] uncaughtException:", e?.message || e));

const UPSTREAM = process.env.ORBIO_UPSTREAM || "http://127.0.0.1:8788";
const UPKEY = process.env.ORBIO_KEY || "mock";
const useMock = !process.env.ORBIO_UPSTREAM;

let mock;
if (useMock) { mock = spawn(process.execPath, ["mock-gateway.js"], { stdio: "inherit" }); }
await new Promise((r) => setTimeout(r, 800));

const router = await Router.create();

// Resume from disk if a snapshot exists for this mode (mock and live are kept
// separate so switching gateways never mixes their agents/keys/spend history).
const SNAP_PATH = `./data/ledger.${useMock ? "mock" : "live"}.json`;
const prior = await loadSnapshot(SNAP_PATH);
const ledger = prior ? Ledger.restore(prior) : new Ledger({ treasuryUsd: 1.50, mode: useMock ? "mock" : "live" });
if (prior) console.error(`[persist] resumed ${ledger.agents.size} agent(s), $${ledger.totalSpent().toFixed(6)} already spent, from ${SNAP_PATH}`);

const seed = { researcher: 0.80, coder: 0.40, summarizer: 0.03 };
const KEY = {};
for (const [id, budgetUsd] of Object.entries(seed)) {
  if (ledger.agents.has(id)) { KEY[id] = ledger.agent(id).key; continue; } // restored: keep its real key
  KEY[id] = ledger.addAgent(id, { budgetUsd, rpm: 240 }).key;
}
// The wallet that would receive activated CREDIT if a prepared top-up were
// ever actually signed. Construct-only: nothing here spends real USDG.
const TREASURY_OWNER = process.env.ORBIO_WALLET || "0x759bbb95c50c8ccb00a4008574ce7bbfa91e3cf7";
if (!ledger.account(DEFAULT_ACCOUNT).walletAddress) ledger.setWalletAddress(DEFAULT_ACCOUNT, TREASURY_OWNER);

const stopAutosave = autosave(ledger, SNAP_PATH);

const governor = new Governor({ ceilingUsdPerWindow: 2, windowMs: 10 * 60 * 1000, burnRateKillUsdPerMin: 0.5 });

const server = createProxy({ ledger, upstreamUrl: UPSTREAM, upstreamKey: UPKEY, router,
                              governor, treasuryOwner: TREASURY_OWNER });
const PORT = process.env.PORT || 8791;
await new Promise((r) => server.listen(PORT, r));
console.error(`\n  Orbio Mesh dashboard -> http://localhost:${PORT}   (${useMock ? "mock" : "LIVE"} gateway)\n`);

// Simulated traffic (allowance refill + random firing below) only makes sense
// against the mock gateway. In live mode it would burn real Orbio balance
// nonstop, forever, off real credentials — never run it there.
if (useMock) {
  // periodic allowance refill: treasury tops each agent back up to a rolling
  // headroom, so tight agents keep cycling (and keep demonstrating downgrades).
  const base = { researcher: 0.80, coder: 0.40, summarizer: 0.03 };
  setInterval(() => {
    for (const [id, b] of Object.entries(base)) {
      const a = ledger.agent(id); a.budgetUsd = a.spentUsd + b;
    }
  }, 8000);

  const agents = ["researcher", "coder", "summarizer"];
  // real catalogue ids across tiers; o1-pro is deliberately dear -> forces downgrades
  const models = ["openai/o1-pro", "google/gemini-3.5-flash:batch",
                  "deepseek/deepseek-v3.1-terminus", "mistralai/mistral-nemo"];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const fire = async (a, m, minTier) => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${KEY[a]}` };
    if (minTier) headers["x-mesh-min-tier"] = minTier;
    try {
      await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
        method: "POST", headers,
        body: JSON.stringify({ model: m, max_tokens: 40 + Math.floor(Math.random()*80),
          messages: [{ role: "user", content: "status ping" }] }),
      });
    } catch {}
  };
  setInterval(() => {
    // random agent on a random model...
    fire(pick(agents), pick(models), Math.random() < 0.3 ? pick(["standard","frontier"]) : null);
    // ...plus the tight agent reaching for a frontier model it can't afford -> downgrade
    if (Math.random() < 0.6) fire("summarizer", "openai/o1-pro", null);
  }, 900);
}

process.on("SIGINT", () => { mock?.kill(); process.exit(0); });
