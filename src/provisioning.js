// The provisioning engine: given the live CREDIT market and a treasury's
// low-water state, decide whether to top up now and how big each tranche
// should be. This is the piece Orbio's own stack does not provide.
//
// Economic facts it reasons over (all verifiable on-chain):
//  - Each CREDIT activates exactly $1 of inference (face value).
//  - CREDIT trades below/above $1; activation is a PERMANENT burn.
//  - Bigger buys climb the order book, so marginal price rises with size.
// => Buy in small tranches while price < $1; never activate above face value.

import { getQuote } from "./chain.js";

// Find the tranche size (from a candidate ladder) with the best all-in price,
// then decide. `needUsd` is how much spendable balance the treasury is short.
export async function planTopUp({ needUsd, ladder = [1, 5, 10, 25, 50, 100], maxPremium = 0 }) {
  const quotes = [];
  for (const size of ladder) {
    if (size > needUsd * 2 && size > ladder[0]) continue; // don't overshoot wildly
    try { quotes.push(await getQuote(size)); } catch { /* skip on RPC hiccup */ }
  }
  if (!quotes.length) return { action: "HOLD", reason: "no quotes available" };

  // Cheapest marginal price per CREDIT.
  quotes.sort((a, b) => a.pricePerCredit - b.pricePerCredit);
  const best = quotes[0];

  // Rule: never burn CREDIT for more than $1 + maxPremium of face value.
  if (best.pricePerCredit > 1 + maxPremium) {
    return {
      action: "DO_NOT_ACTIVATE",
      reason: `cheapest CREDIT is $${best.pricePerCredit.toFixed(4)} > $1 face; ` +
              `activating would overpay. Spend deposited USD or wait.`,
      market: best,
    };
  }

  // How many tranches of the best size to cover the shortfall.
  const tranches = Math.max(1, Math.ceil(needUsd / best.creditOut));
  return {
    action: "BUY_AND_ACTIVATE",
    trancheUsd: best.budgetUsd,
    tranches,
    pricePerCredit: best.pricePerCredit,
    discountVsFace: best.discountVsFace,
    reason: `buy+activate ${tranches}× $${best.budgetUsd} tranche(s) at ` +
            `$${best.pricePerCredit.toFixed(4)}/CREDIT ` +
            `(${(best.discountVsFace * 100).toFixed(1)}% under face).`,
    market: best,
    ladder: quotes,
  };
}
