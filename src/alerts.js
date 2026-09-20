// Fires alerts on governance state TRANSITIONS — kill switch trips, the
// auto-buy ceiling is reached, an agent runs low — so an operator finds out
// without staring at the dashboard. Each condition alerts once when it
// starts and once when it clears; it never repeats on every poll.
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
    this._state = { frozen: false, ceilingHit: false, lowBudget: new Set() };
  }

  async fire(type, message, data = {}) {
    const evt = { type, message, ts: Date.now(), ...data };
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

  // Call periodically with the live ledger + governor. Only fires on a
  // state CHANGE, so a steady "frozen" or "low budget" condition alerts
  // once, not every tick.
  async check(ledger, gov) {
    const st = gov.status(ledger);

    if (st.frozen && !this._state.frozen) {
      await this.fire("kill_switch_tripped",
        `Auto-topup frozen: burn rate $${st.burnRateUsdPerMin.toFixed(4)}/min exceeds ` +
        `the $${st.burnRateKillUsdPerMin}/min threshold.`);
    } else if (!st.frozen && this._state.frozen) {
      await this.fire("kill_switch_cleared", "Burn rate is back under threshold; auto-topup re-armed.");
    }
    this._state.frozen = st.frozen;

    const ceilingHit = st.ceilingUsdPerWindow > 0 && st.autoBoughtInWindow >= st.ceilingUsdPerWindow;
    if (ceilingHit && !this._state.ceilingHit) {
      await this.fire("ceiling_hit",
        `Auto-buy ceiling reached: $${st.autoBoughtInWindow.toFixed(2)} of ` +
        `$${st.ceilingUsdPerWindow.toFixed(2)} used this ${st.windowMinutes}-minute window.`);
    } else if (!ceilingHit && this._state.ceilingHit) {
      await this.fire("ceiling_cleared", "Auto-buy ceiling has headroom again.");
    }
    this._state.ceilingHit = ceilingHit;

    for (const [id, a] of ledger.agents) {
      const remaining = a.budgetUsd - a.spentUsd;
      const frac = a.budgetUsd > 0 ? remaining / a.budgetUsd : 1;
      const low = frac <= this.lowBudgetFrac;
      const wasLow = this._state.lowBudget.has(id);
      if (low && !wasLow) {
        this._state.lowBudget.add(id);
        await this.fire("agent_low_budget",
          `Agent "${id}" has ${(frac * 100).toFixed(1)}% of its budget left ` +
          `($${remaining.toFixed(4)} of $${a.budgetUsd.toFixed(4)}).`, { agent: id });
      } else if (!low && wasLow) {
        this._state.lowBudget.delete(id);
      }
    }
  }
}
