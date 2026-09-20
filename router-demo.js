// Shows cost-aware routing: same request, three budget/floor situations.
import { Ledger } from "./src/ledger.js";
import { createProxy } from "./src/proxy.js";
import { Router } from "./src/router.js";

const router = await Router.create();
const ledger = new Ledger({ treasuryUsd: 1.0 });
const K={}; K.plenty=ledger.addAgent("plenty",  { budgetUsd: 1.0,     rpm: 999 }).key; // can afford frontier
K.tight=ledger.addAgent("tight",   { budgetUsd: 0.002,   rpm: 999 }).key; // must downgrade
K.strict=ledger.addAgent("strict",  { budgetUsd: 0.002,   rpm: 999 }).key; // tight AND wont drop tier

const server = createProxy({ ledger, upstreamUrl: "http://127.0.0.1:8788", upstreamKey: "mock", router });
await new Promise((r) => server.listen(8790, r));

const FRONTIER = "openai/o1-pro"; // a deliberately expensive model
async function ask(agent, minTier) {
  const res = await fetch("http://127.0.0.1:8790/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${K[agent]}`,
               ...(minTier ? { "x-mesh-min-tier": minTier } : {}) },
    body: JSON.stringify({ model: FRONTIER, max_tokens: 200,
      messages: [{ role: "user", content: "Explain the CREDIT flywheel in one line." }] }),
  });
  return { status: res.status,
    used: res.headers.get("x-mesh-model-used"),
    tier: res.headers.get("x-mesh-tier"),
    downgraded: res.headers.get("x-mesh-downgraded-from"),
    cost: res.headers.get("x-mesh-cost-usd"),
    reason: res.headers.get("x-mesh-reason") };
}

console.log(`requested model (frontier): ${FRONTIER}\n`);
console.log("plenty  ($1.00 budget, any tier):", await ask("plenty"));
console.log("tight   ($0.002 budget, any tier):", await ask("tight"));
console.log("strict  ($0.002 budget, min=frontier):", await ask("strict", "frontier"));
server.close();
