// Orbio CREDIT Desk — serves the designed page and live market data.
// All figures are real: model prices from the public catalogue, CREDIT price
// and depth from the Exchange contract on Robinhood Chain. No key, no funds.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getQuote, feeBps } from "./src/chain.js";
import { loadModels } from "./src/pricing.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8792;

let _mkt = { at: 0, data: null };
async function market() {
  if (Date.now() - _mkt.at < 12_000 && _mkt.data) return _mkt.data;
  const sizes = [1, 10, 100, 1000, 5000];
  const ladder = [];
  for (const s of sizes) { try { ladder.push(await getQuote(s)); } catch {} }
  let fee = 200; try { fee = await feeBps(); } catch {}
  const spot = ladder[0];
  // depth = largest tested size whose price stays within 1% of spot
  let depthUsd = 0;
  if (spot) for (const q of ladder)
    if (q.pricePerCredit <= spot.pricePerCredit * 1.01) depthUsd = q.budgetUsd;
  _mkt = { at: Date.now(), data: {
    pricePerCredit: spot?.pricePerCredit ?? null,
    discount: spot?.discountVsFace ?? null,
    feeBps: fee, depthUsd,
    ladder: ladder.map((q) => ({
      usd: q.budgetUsd, price: +q.pricePerCredit.toFixed(4),
      discount: +q.discountVsFace.toFixed(4), reason: q.reason })),
    at: new Date().toISOString(),
  } };
  return _mkt.data;
}

async function models() {
  const m = await loadModels();
  return [...m.values()]
    .filter((x) => x.blendedUsdPerTok > 0 && (x.outputModalities ?? ["text"]).includes("text"))
    .map((x) => ({ id: x.id, name: x.name, prompt: x.promptUsdPerTok, completion: x.completionUsdPerTok }))
    .sort((a, b) => (a.prompt + a.completion) - (b.prompt + b.completion));
}

http.createServer(async (req, res) => {
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(join(__dir, "desk.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html" }); return res.end(html);
    }
    if (req.url === "/api/market") return json(await market());
    if (req.url === "/api/models") return json(await models());
    res.writeHead(404); res.end("not found");
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, () => console.error(`\n  Orbio CREDIT Desk -> http://localhost:${PORT}\n`));
