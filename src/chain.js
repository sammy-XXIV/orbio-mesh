// Read-only access to the Orbio CREDIT market on Robinhood Chain (chain 4663).
// No keys, no signing — every call here is an eth_call against public contracts.

export const CONTRACTS = {
  exchange: "0x6951ffd32630b05e06f50062aea801625a58ebc0",
  credit:   "0xe33322da1380e61e5ae5dfb21e7f62924c73004c",
  usdg:     "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
};

export const RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
];

// 4-byte selectors (keccak256 of the signature, first 4 bytes).
const SEL = {
  getQuote: "758af3ab", // getQuote(uint256 usdgIn, uint256 maxFills)
  feeBps:   "24a9d853", // feeBps()
  maxFills: "2f779805", // MAX_FILLS()
};

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

async function ethCall(to, data) {
  let lastErr;
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "orbio-mesh" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to, data: "0x" + data }, "latest"],
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`all RPCs failed: ${lastErr?.message}`);
}

const decodeWords = (hex) => {
  const h = hex.replace(/^0x/, "");
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
};

const QUOTE_REASON = ["BudgetSpent", "LiquidityExhausted", "UnitUnaffordable", "WorkLimit"];

// Quote how much CREDIT `usdgIn` dollars buys. USDG and CREDIT are 6-decimals.
// Returns human-readable numbers plus the all-in price and discount vs $1 face.
export async function getQuote(usdgInDollars, maxFills = 64) {
  const usdgIn = BigInt(Math.round(usdgInDollars * 1e6));
  const raw = await ethCall(CONTRACTS.exchange, SEL.getQuote + word(usdgIn) + word(maxFills));
  const [creditOut, usdgSpent, feeAtoms, fills, reason] = decodeWords(raw);
  const credit = Number(creditOut) / 1e6;
  const spent  = Number(usdgSpent) / 1e6;
  const fee    = Number(feeAtoms) / 1e6;
  const allInUsd = spent + fee;                 // total USDG that leaves the wallet
  const pricePerCredit = credit ? allInUsd / credit : Infinity;
  return {
    budgetUsd: usdgInDollars,
    creditOut: credit,
    usdgSpent: spent,
    feeUsd: fee,
    allInUsd,
    fills: Number(fills),
    reason: QUOTE_REASON[Number(reason)] ?? String(reason),
    pricePerCredit,                             // USDG paid per 1 CREDIT
    // Each CREDIT activates $1 of inference, so face value = creditOut dollars.
    discountVsFace: 1 - pricePerCredit,         // >0 means inference is cheaper than list
  };
}

export async function feeBps() {
  return Number(BigInt(await ethCall(CONTRACTS.exchange, SEL.feeBps)));
}
export async function maxFills() {
  return Number(BigInt(await ethCall(CONTRACTS.exchange, SEL.maxFills)));
}
