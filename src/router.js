// Cost-aware model router with auto-downgrade.
//
// The proxy's budget check has two possible answers: run it, or reject it.
// A reject is a bad outcome for an agent mid-task. The router adds a third:
// if the requested model won't fit the remaining budget, drop to the cheapest
// model that (a) still meets the caller's quality FLOOR and (b) does fit — so
// the request SUCCEEDS on a cheaper model instead of failing.
//
// Tiers are derived from the live price distribution (terciles), so they track
// the real catalogue rather than a hand-maintained list. Honest limitation:
// price is a PROXY for capability. The caller controls how far down it may go
// via `minTier`, so downgrade never silently drops below acceptable quality.

import { loadModels, estimateMaxCost } from "./pricing.js";

export const TIERS = ["economy", "standard", "frontier"]; // low -> high
const rank = (t) => TIERS.indexOf(t);

export class Router {
  static async create() {
    const models = await loadModels();
    // chat-capable = emits text
    const chat = [...models.values()].filter((m) =>
      m.blendedUsdPerTok > 0 && (m.outputModalities ?? ["text"]).includes("text"));
    const prices = chat.map((m) => m.blendedUsdPerTok).sort((a, b) => a - b);
    const t1 = prices[Math.floor(prices.length / 3)];
    const t2 = prices[Math.floor((2 * prices.length) / 3)];
    const tierOf = (p) => (p <= t1 ? "economy" : p <= t2 ? "standard" : "frontier");
    for (const m of chat) m.tier = tierOf(m.blendedUsdPerTok);
    return new Router(chat, { t1, t2 });
  }

  constructor(models, cuts) {
    this.models = models;                       // chat models, with .tier set
    this.byId = new Map(models.map((m) => [m.id, m]));
    this.cuts = cuts;
  }

  tierOf(id) { return this.byId.get(id)?.tier ?? "standard"; }

  // Choose a model that fits `budgetRemaining`, not below `minTier`.
  // Returns { model, tier, downgradedFrom?, estUsd } or { error }.
  async choose({ requested, minTier = "economy", budgetRemaining, promptTokens, maxTokens }) {
    const want = this.byId.get(requested);
    const floor = rank(minTier);
    const fits = async (id) => {
      const est = await estimateMaxCost({ model: id, promptTokens, maxTokens });
      return est <= budgetRemaining ? est : null;
    };

    // 1) preferred model, if known and it fits
    if (want) {
      const est = await fits(requested);
      if (est != null) return { model: requested, tier: want.tier, estUsd: est };
    }

    // 2) search from the preferred tier down to the floor, cheapest-first
    const startRank = want ? rank(want.tier) : rank("frontier");
    const candidates = this.models
      .filter((m) => rank(m.tier) <= startRank && rank(m.tier) >= floor)
      .sort((a, b) => a.blendedUsdPerTok - b.blendedUsdPerTok);
    for (const m of candidates) {
      const est = await fits(m.id);
      if (est != null)
        return { model: m.id, tier: m.tier, downgradedFrom: requested, estUsd: est };
    }
    return { error: "no model within budget at or above minTier" };
  }
}
