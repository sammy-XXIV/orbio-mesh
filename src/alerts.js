// Fires alerts on governance state TRANSITIONS — kill switch trips, the
// auto-buy ceiling is reached, an agent runs low — so an operator finds out
// without staring at the dashboard. Each condition alerts once when it
// starts and once when it clears; it never repeats on every poll.
//
// Account-scoped: every connected account is checked independently, and
// every alert is tagged with the account it belongs to — the operator's
// own state and a tenant's state are never mixed, same isolation as the
// ledger and governor.
//
// Delivery: POSTs to a webhook if MESH_ALERT_WEBHOOK (or an explicit
// webhookUrl) is set; otherwise logs to stderr. Either way, every alert is
// kept in an in-memory log so the dashboard can show history without needing
// a real webhook configured.

export class Alerter {
  constructor({ webhookUrl = null, maxLog = 50, lowBudgetFrac = 0.1 } = {}) {
    this.webhookUrl = webhookUrl || process.env.MESH_ALERT_WEBHOOK || null;
    this.maxLog = maxLog;
    this.lowBudgetFrac = lowBudgetFrac;
    this.log = [];
    // per-account transition state
    this._frozen = new Map();     // accountId -> bool
    this._ceilingHit = new Map(); // accountId -> bool
    this._lowBudget = new Set();  // agent ids currently low (agents already carry their own accountId)
  }

  async fire(accountId, type, message, data = {}) {
    const evt = { type, message, ts: Date.now(), accountId, ...data };
    this.log.unshift(evt);
    if (this.log.length > this.maxLog) this.log.length = this.maxLog;
    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `[Orbio Mesh] ${message}`, ...evt }),
        });
      } catch (e) { console.error("[alerts] webhook delivery failed:", e.message); }
    } else {
      console.error(`[alerts] ${type}: ${message}`);
    }
    return evt;
  }

  // Call periodically with the live ledger + governor. Checks every known
  // account independently. Only fires on a state CHANGE, so a steady
  // "frozen" or "low budget" condition alerts once, not every tick.
  async check(ledger, gov) {
    for (const accountId of ledger.accounts.keys()) {
      const st = gov.status(ledger, accountId);

      const wasFrozen = this._frozen.get(accountId) || false;
      if (st.frozen && !wasFrozen) {
        await this.fire(accountId, "kill_switch_tripped",
          `Auto-topup frozen: burn rate $${st.burnRateUsdPerMin.toFixed(4)}/min exceeds ` +
          `the $${st.burnRateKillUsdPerMin}/min threshold.`);
      } else if (!st.frozen && wasFrozen) {
        await this.fire(accountId, "kill_switch_cleared", "Burn rate is back under threshold; auto-topup re-armed.");
      }
      this._frozen.set(accountId, st.frozen);

      const ceilingHit = st.ceilingUsdPerWindow > 0 && st.autoBoughtInWindow >= st.ceilingUsdPerWindow;
      const wasCeilingHit = this._ceilingHit.get(accountId) || false;
      if (ceilingHit && !wasCeilingHit) {
        await this.fire(accountId, "ceiling_hit",
          `Auto-buy ceiling reached: $${st.autoBoughtInWindow.toFixed(2)} of ` +
          `$${st.ceilingUsdPerWindow.toFixed(2)} used this ${st.windowMinutes}-minute window.`);
      } else if (!ceilingHit && wasCeilingHit) {
        await this.fire(accountId, "ceiling_cleared", "Auto-buy ceiling has headroom again.");
      }
      this._ceilingHit.set(accountId, ceilingHit);
    }

    for (const [id, a] of ledger.agents) {
      const remaining = a.budgetUsd - a.spentUsd;
      const frac = a.budgetUsd > 0 ? remaining / a.budgetUsd : 1;
      const low = frac <= this.lowBudgetFrac;
      const wasLow = this._lowBudget.has(id);
      if (low && !wasLow) {
        this._lowBudget.add(id);
        await this.fire(a.accountId, "agent_low_budget",
          `Agent "${id}" has ${(frac * 100).toFixed(1)}% of its budget left ` +
          `($${remaining.toFixed(4)} of $${a.budgetUsd.toFixed(4)}).`, { agent: id });
      } else if (!low && wasLow) {
        this._lowBudget.delete(id);
      }
    }
  }
}
