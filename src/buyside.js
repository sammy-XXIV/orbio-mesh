// Buy-side transaction construction: builds the real, signable calldata to
// buy CREDIT and activate it, straight from a live quote. This module never
// signs or sends anything — it hands back exactly what a wallet would need
// to execute, with the price already locked to a slippage-protected minimum.
// Executing it is deliberately left to a human/funded signer.

import { CONTRACTS } from "./chain.js";
import { getQuote } from "./chain.js";

const SEL = {
  approve: "095ea7b3",              // approve(address,uint256)
  buyAndActivate: "6ebadb6e",       // buyAndActivate(uint256,uint256,bytes32,uint256)
};

const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addrWord = (addr) => addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

// beneficiary is encoded as bytes32 per the Exchange ABI (a left-padded address).
function beneficiaryBytes32(address) { return "0x" + addrWord(address); }

// Build the two-step calldata (approve, then buyAndActivate) for a given
// USDG spend, with minCreditOut derived from the live quote minus a
// slippage tolerance. Nothing here touches a wallet or a key.
export async function prepareBuyAndActivate({ usdgInDollars, beneficiary, slippageBps = 100, maxFills = 64 }) {
  const quote = await getQuote(usdgInDollars, maxFills);
  if (quote.reason === "LiquidityExhausted" || quote.reason === "UnitUnaffordable")
    return { ok: false, reason: `book can't fill this size: ${quote.reason}`, quote };

  const usdgIn = BigInt(Math.round(usdgInDollars * 1e6));
  // minCreditOut = quoted output minus slippage tolerance, floor-rounded, 6dp.
  const minCreditOutRaw = BigInt(Math.floor(quote.creditOut * 1e6));
  const minCreditOut = minCreditOutRaw - (minCreditOutRaw * BigInt(slippageBps)) / 10000n;

  const approveTx = {
    step: "approve",
    to: CONTRACTS.usdg,
    data: "0x" + SEL.approve + addrWord(CONTRACTS.exchange) + word(usdgIn),
    valueUsdg: 0,
    note: `approve Exchange to pull ${usdgInDollars} USDG`,
  };
  const buyTx = {
    step: "buyAndActivate",
    to: CONTRACTS.exchange,
    data: "0x" + SEL.buyAndActivate + word(usdgIn) + word(minCreditOut)
          + beneficiaryBytes32(beneficiary).slice(2) + word(maxFills),
    valueUsdg: 0,
    note: `buy >=${(Number(minCreditOut) / 1e6).toFixed(4)} CREDIT for ${usdgInDollars} USDG, activate to ${beneficiary}`,
  };

  return {
    ok: true,
    usdgInDollars,
    expectedCreditOut: quote.creditOut,
    minCreditOut: Number(minCreditOut) / 1e6,
    pricePerCredit: quote.pricePerCredit,
    discountVsFace: quote.discountVsFace,
    slippageBps,
    txs: [approveTx, buyTx],
    quote,
  };
}
