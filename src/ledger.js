// In-memory treasury ledger with reservation accounting.
// Keeps per-agent budgets safe under concurrency: every request RESERVES its
// worst-case cost before dispatch, then SETTLES to the real cost on response.
// (Swap this for D1/SQLite later; the interface is what the proxy depends on.)

import { randomBytes } from "node:crypto";

export class Ledger {
  constructor({ treasuryUsd, mode = "mock" }) {
    this.treasuryUsd = treasuryUsd;
    this.mode = mode;     // spendable balance backing the whole mesh
    this.agents = new Map();            // id -> {budgetUsd, spentUsd, reservedUsd, rpm, minTier, key, hits}
    this.keyIndex = new Map();          // virtual key -> agent id
    this.requests = [];                 // append-only attribution log
    this._resSeq = 0;
    this.globalReserved = 0;
  }

  // Mint an agent with its own secret virtual key. The key is returned ONCE
  // here (the caller shows it to the operator); it is never rebuilt from state.
  addAgent(id, { budgetUsd, rpm = 60, allowedModels = null, minTier = "economy" }) {
    if (this.agents.has(id)) throw new Error(`agent exists: ${id}`);
    const key = "mesh_" + randomBytes(18).toString("hex");
    this.agents.set(id, { budgetUsd, spentUsd: 0, reservedUsd: 0, rpm, allowedModels, minTier, key, hits: [] });
    this.keyIndex.set(key, id);
    return { id, key, budgetUsd, rpm, minTier, allowedModels };
  }

  agentByKey(key) { return this.keyIndex.get(key); }

  topUp(id, addUsd) { const a = this.agent(id); a.budgetUsd += Math.max(0, addUsd); return a.budgetUsd; }

  agent(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent: ${id}`);
    return a;
  }

  // Try to reserve estUsd for `id`. Returns {ok, resId} or {ok:false, code, reason}.
  reserve(id, estUsd, model) {
    const a = this.agent(id);
    if (a.allowedModels && !a.allowedModels.includes(model))
      return { ok: false, code: "model_not_allowed", reason: `agent ${id} may not use ${model}` };

    // simple sliding-window rate limit
    const now = Date.now();
    a.hits = a.hits.filter((t) => now - t < 60_000);
    if (a.hits.length >= a.rpm)
      return { ok: false, code: "rate_limited", reason: `agent ${id} over ${a.rpm} rpm` };

    if (a.spentUsd + a.reservedUsd + estUsd > a.budgetUsd + 1e-12)
      return { ok: false, code: "budget_exceeded",
        reason: `agent ${id} would exceed $${a.budgetUsd.toFixed(4)} budget ` +
                `(spent $${a.spentUsd.toFixed(4)}, reserved $${a.reservedUsd.toFixed(4)}, need $${estUsd.toFixed(4)})` };

    if (this.globalReserved + this.totalSpent() + estUsd > this.treasuryUsd + 1e-12)
      return { ok: false, code: "treasury_exhausted",
        reason: `mesh treasury $${this.treasuryUsd.toFixed(4)} can't cover this reservation` };

    a.reservedUsd += estUsd;
    this.globalReserved += estUsd;
    a.hits.push(now);
    return { ok: true, resId: ++this._resSeq, estUsd };
  }

  // Replace a reservation with the real cost once the response is known.
  settle(id, resId, estUsd, actualUsd, meta = {}) {
    const a = this.agent(id);
    a.reservedUsd = Math.max(0, a.reservedUsd - estUsd);
    this.globalReserved = Math.max(0, this.globalReserved - estUsd);
    a.spentUsd += actualUsd;
    this.requests.push({ ts: Date.now(), agent: id, resId, estUsd, actualUsd, ...meta });
  }

  // Release a reservation with no charge (upstream failed).
  release(id, resId, estUsd) {
    const a = this.agent(id);
    a.reservedUsd = Math.max(0, a.reservedUsd - estUsd);
    this.globalReserved = Math.max(0, this.globalReserved - estUsd);
  }

  totalSpent() { return [...this.agents.values()].reduce((s, a) => s + a.spentUsd, 0); }

  // Serialize everything needed to resume exactly where we left off,
  // including virtual keys (so agents don't need to be re-provisioned
  // and their existing keys keep working after a restart).
  snapshot() {
    return {
      treasuryUsd: this.treasuryUsd,
      mode: this.mode,
      agents: [...this.agents.entries()],
      requests: this.requests.slice(-500), // cap: this is a log, not the ledger of record
      _resSeq: this._resSeq,
    };
  }

  static restore(data) {
    const l = new Ledger({ treasuryUsd: data.treasuryUsd, mode: data.mode });
    for (const [id, a] of data.agents) {
      a.reservedUsd = 0; // never resume a reservation across a restart
      l.agents.set(id, a);
      l.keyIndex.set(a.key, id);
    }
    l.requests = data.requests || [];
    l._resSeq = data._resSeq || 0;
    return l;
  }

  report() {
    return {
      mode: this.mode,
      treasuryUsd: this.treasuryUsd,
      totalSpent: this.totalSpent(),
      remaining: this.treasuryUsd - this.totalSpent(),
      agents: [...this.agents.entries()].map(([id, a]) => ({
        id, budgetUsd: a.budgetUsd, spentUsd: +a.spentUsd.toFixed(6),
        remaining: +(a.budgetUsd - a.spentUsd).toFixed(6), requests: a.hits.length,
        minTier: a.minTier, keyHint: (a.key || "").slice(0, 12) + "…",
        allowedModels: a.allowedModels || null,
      })),
      requestCount: this.requests.length,
      recent: this.requests.slice(-15).reverse().map((r) => ({
        agent: r.agent, model: r.model, tier: r.tier,
        downgradedFrom: r.downgradedFrom || null,
        cost: +(r.actualUsd ?? 0).toFixed(6), ts: r.ts,
      })),
    };
  }
}
