// Live provisioning signal — runs read-only against Orbio's public market.
// Usage: node signal.js [needUsd]
import { feeBps, maxFills, getQuote } from "./src/chain.js";
import { planTopUp } from "./src/provisioning.js";
import { loadModels } from "./src/pricing.js";

const needUsd = Number(process.argv[2] ?? 20);

const f = (n, d = 4) => (n < 0 ? "" : "+") + (n * 100).toFixed(d - 2) + "%";

console.log("Orbio Mesh — live provisioning signal\n" + "=".repeat(44));
const [bps, mf, models] = await Promise.all([feeBps(), maxFills(), loadModels()]);
console.log(`exchange fee: ${(bps / 100).toFixed(2)}%   max fills: ${mf}   models priced: ${models.size}`);

console.log("\nOrder-book price ladder (all-in, incl. fee):");
for (const size of [1, 5, 25, 100]) {
  const q = await getQuote(size);
  console.log(
    `  $${String(size).padStart(3)} -> ${q.creditOut.toFixed(3)} CREDIT  ` +
    `@ $${q.pricePerCredit.toFixed(4)}/CREDIT  (${f(q.discountVsFace)} vs $1 face)  [${q.reason}]`
  );
}

console.log(`\nTreasury short by $${needUsd} -> decision:`);
const plan = await planTopUp({ needUsd });
console.log(`  action: ${plan.action}`);
console.log(`  ${plan.reason}`);
