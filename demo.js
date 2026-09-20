import { Ledger } from "./src/ledger.js";
import { createProxy } from "./src/proxy.js";
import { loadModels } from "./src/pricing.js";

const UPSTREAM = process.env.ORBIO_UPSTREAM || "http://127.0.0.1:8788"; // mock by default
const UPKEY = process.env.ORBIO_KEY || "mock-key";
const models = await loadModels();
// pick a mid-priced real model id from the live catalogue
const MODEL = [...models.values()].sort((a,b)=>
  (a.promptUsdPerTok+a.completionUsdPerTok)-(b.promptUsdPerTok+b.completionUsdPerTok))[300].id;

const ledger = new Ledger({ treasuryUsd: 0.50 });     // pretend $0.50 has settled
const K={}; K.researcher=ledger.addAgent("researcher", { budgetUsd: 0.30, rpm: 120 }).key;
K.summarizer=ledger.addAgent("summarizer", { budgetUsd: 0.0006, rpm: 120 }).key; // tiny: will cap mid-run

const server = createProxy({ ledger, upstreamUrl: UPSTREAM, upstreamKey: UPKEY });
await new Promise((r) => server.listen(8789, r));
const PROXY = "http://127.0.0.1:8789";

async function ask(agent, text) {
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${K[agent]}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 200,
      messages: [{ role: "user", content: text }] }),
  });
  return { status: res.status,
    cost: res.headers.get("x-mesh-cost-usd"),
    remaining: res.headers.get("x-mesh-agent-remaining-usd"),
    reason: res.headers.get("x-mesh-reason") };
}

console.log(`model under test: ${MODEL}`);
console.log("firing 20 requests per worker...\n");
const work = [];
for (let i = 0; i < 20; i++) {
  work.push(ask("researcher", "Summarize the CREDIT protocol in one line. #" + i));
  work.push(ask("summarizer", "One-line status. #" + i));
}
const results = await Promise.all(work);
const byAgent = { researcher: { ok:0, blocked:0 }, summarizer: { ok:0, blocked:0 } };
results.forEach((r, i) => {
  const agent = i % 2 === 0 ? "researcher" : "summarizer";
  if (r.status === 200) byAgent[agent].ok++;
  else { byAgent[agent].blocked++; byAgent[agent].why = r.reason; }
});
console.log("outcome by worker:", JSON.stringify(byAgent, null, 0));
console.log("\nledger report:");
console.log(JSON.stringify(ledger.report(), null, 2));
server.close();
