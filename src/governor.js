// The governor: decides whether an agent that just hit its budget should be
// topped up from the CREDIT book instead of simply failing — and bounds that
// decision so "auto-buy" can never become "unattended, unlimited spend."
//
// Three guardrails, each answering a different way this could go wrong:
//  1. Burn-rate kill switch  — a spend spike (bug, prompt injection, runaway
//     loop) freezes auto-topup instead of chasing it with more money.
//  2. Rolling auto-buy ceiling — caps how much CAN be auto-purchased in a
//     window, independent of how much the treasury "needs".
//  3. Price circuit breaker — inherited from provisioning.planTopUp: never
//     activate CREDIT priced above its $1 face value.
//
// Account-scoped: every connected account (the operator's own, or any
// tenant who connected their own wallet) gets its own independent burn-rate
// tracking, ceiling, and buy history — one account's traffic or top-ups can
// never affect another's guardrails, same isolation as the ledger itself.
//
// This module only DECIDES and CONSTRUCTS (via buyside.js). It never signs
// or sends a transaction — that stays a human/funded-signer action.

import { DEFAULT_ACCOUNT } from "./ledger.js";
import { planTopUp } from "./provisioning.js";
import { prepareBuyAndActivate } from "./buyside.js";

export class Governor {
  constructor({
    ceilingUsdPerWindow = 5,      // max auto-buy USDG spend per window
    windowMs = 10 * 60 * 1000,    // 10 minutes
    burnRateKillUsdPerMin = 1,    // freeze auto-topup above this real spend rate
    maxPremium = 0,               // never buy CREDIT priced above $1 + this
  } = {}) {
    this.ceilingUsdPerWindow = ceilingUsdPerWindow;
    this.windowMs = windowMs;
    this.burnRateKillUsdPerMin = burnRateKillUsdPerMin;
    this.maxPremium = maxPremium;
    this.autoBuys = new Map(); // accountId -> [{ ts, usdgInDollars }]
  }

  _windowStart() { return Date.now() - this.windowMs; }

  autoBoughtInWindow(accountId = DEFAULT_ACCOUNT) {
    const since = this._windowStart();
    const buys = this.autoBuys.get(accountId) || [];
    return buys.filter((b) => b.ts >= since).reduce((s, b) => s + b.usdgInDollars, 0);
  }

  // Real spend rate from the ledger's own request log, scoped to ONE
  // account — this is what "burn rate" means: actual dollars charged for
  // that account, not reservations or estimates, and never another
  // account's traffic bleeding into this one's guardrails.
  burnRateUsdPerMin(ledger, accountId = DEFAULT_ACCOUNT, windowMs = 5 * 60 * 1000) {
    const since = Date.now() - windowMs;
    const spent = ledger.requests
      .filter((r) => r.ts >= since && (r.accountId || DEFAULT_ACCOUNT) === accountId)
      .reduce((s, r) => s + (r.actualUsd || 0), 0);
    return spent / (windowMs / 60000);
  }

  recordAutoBuy(accountId, usdgInDollars) {
    if (!this.autoBuys.has(accountId)) this.autoBuys.set(accountId, []);
    this.autoBuys.get(accountId).push({ ts: Date.now(), usdgInDollars });
  }

  // The full decision: given a shortfall, should we top up, and if so, what
  // exact transaction would do it? Every rejection carries the reason a
  // human can read on the dashboard — nothing fails silently. `beneficiary`
  // is that account's OWN wallet (the operator's, or a tenant's connected
  // one) — a top-up never targets anyone else's address.
  async decide({ ledger, accountId = DEFAULT_ACCOUNT, needUsd, beneficiary }) {
    const rate = this.burnRateUsdPerMin(ledger, accountId);
    if (rate > this.burnRateKillUsdPerMin)
      return { action: "FROZEN", reason:
        `burn rate $${rate.toFixed(4)}/min exceeds kill-switch threshold ` +
        `$${this.burnRateKillUsdPerMin}/min — auto-topup paused, this needs a human look` };

    const boughtSoFar = this.autoBoughtInWindow(accountId);
    const headroom = this.ceilingUsdPerWindow - boughtSoFar;
    if (headroom <= 0)
      return { action: "CEILING_HIT", reason:
        `already auto-bought $${boughtSoFar.toFixed(2)} of $${this.ceilingUsdPerWindow} ` +
        `allowed in this ${(this.windowMs / 60000).toFixed(0)}-minute window` };

    if (!beneficiary)
      return { action: "NO_WALLET", reason:
        `this account has no connected wallet address to activate CREDIT to` };

    const buyUsd = Math.min(needUsd, headroom);
    const plan = await planTopUp({ needUsd: buyUsd, maxPremium: this.maxPremium });
    if (plan.action !== "BUY_AND_ACTIVATE")
      return { action: plan.action, reason: plan.reason, market: plan.market };

    const prep = await prepareBuyAndActivate({ usdgInDollars: buyUsd, beneficiary });
    if (!prep.ok) return { action: "BOOK_UNAVAILABLE", reason: prep.reason };

    return {
      action: "PREPARED",
      reason: `ready to buy $${buyUsd} of CREDIT at $${prep.pricePerCredit.toFixed(4)}/CREDIT ` +
              `(${(prep.discountVsFace * 100).toFixed(1)}% under face); awaiting a signature`,
      buyUsd, burnRateUsdPerMin: rate, autoBuyHeadroomUsd: headroom, prepared: prep,
    };
  }

  status(ledger, accountId = DEFAULT_ACCOUNT) {
    const rate = this.burnRateUsdPerMin(ledger, accountId);
    return {
      ceilingUsdPerWindow: this.ceilingUsdPerWindow,
      windowMinutes: this.windowMs / 60000,
      autoBoughtInWindow: +this.autoBoughtInWindow(accountId).toFixed(4),
      burnRateUsdPerMin: +rate.toFixed(6),
      burnRateKillUsdPerMin: this.burnRateKillUsdPerMin,
      frozen: rate > this.burnRateKillUsdPerMin,
    };
  }
}
