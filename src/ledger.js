// In-memory treasury ledger with reservation accounting, now multi-account.
// Keeps per-agent budgets safe under concurrency: every request RESERVES its
// worst-case cost before dispatch, then SETTLES to the real cost on response.
//
// An "account" is one real Orbio key (encrypted at rest) plus the treasury
// cap its owner allows Mesh to spend from it. "default" is the operator's
// own shared demo account — everything that worked before multi-tenancy
// still works unchanged by simply not passing an accountId.
// (Swap this for D1/SQLite later; the interface is what the proxy depends on.)

import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "./crypto.js";

export const DEFAULT_ACCOUNT = "default";

export class Ledger {
  constructor({ treasuryUsd, mode = "mock" }) {
    this.mode = mode;
    this.agents = new Map();            // id -> {accountId, budgetUsd, spentUsd, reservedUsd, rpm, minTier, key, hits, allowedModels}
    this.keyIndex = new Map();          // virtual key -> agent id
    this.accounts = new Map();          // accountId -> {label, keyEnc, treasuryUsd, ownerToken, createdAt}
    this.ownerIndex = new Map();        // owner token -> accountId
    this.requests = [];                 // append-only attribution log
    this._resSeq = 0;
    this.globalReserved = 0;            // reserved-but-unsettled, keyed loosely (fine: bounded per-account below)
    // The operator's own account — pre-registered so nothing before
    // multi-tenancy breaks. Its real key lives in env (upstreamKey), not here.
    this.accounts.set(DEFAULT_ACCOUNT, { label: "operator", keyEnc: null, treasuryUsd, createdAt: Date.now() });
  }

  // Register a new tenant's real Orbio key. Callers MUST have already
  // validated the key against Orbio before calling this — this method only
  // stores it, encrypted, and never returns the plaintext again.
  // walletAddress (when the account was connected via a wallet signature)
  // is what lets THIS account get its own governed buy-side, targeting
  // their own wallet — not the operator's.
  addAccount({ label, realOrbioKey, treasuryUsd, walletAddress = null }) {
    const accountId = "acct_" + randomBytes(8).toString("hex");
    const ownerToken = "owner_" + randomBytes(18).toString("hex");
    this.accounts.set(accountId, {
      label: label || accountId, keyEnc: encryptSecret(realOrbioKey),
      treasuryUsd: Math.max(0, treasuryUsd), walletAddress, createdAt: Date.now(),
    });
    this.ownerIndex.set(ownerToken, accountId);
    return { accountId, ownerToken, treasuryUsd };
  }

  accountByOwnerToken(token) { return this.ownerIndex.get(token) || null; }
  setWalletAddress(accountId, address) { this.account(accountId).walletAddress = address; }
  account(accountId) {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error(`unknown account: ${accountId}`);
    return a;
  }
  // Decrypts on demand — the plaintext key never sits in memory longer than
  // one request needs it, and it's never included in any snapshot or log.
  realKeyFor(accountId) {
    const acc = this.account(accountId);
    return acc.keyEnc ? decryptSecret(acc.keyEnc) : null; // null = use the operator's env key
  }

  // Mint an agent with its own secret virtual key, under a given account
  // (defaults to the operator's shared account). The key is returned ONCE
  // here; it is never rebuilt from state.
  addAgent(id, { budgetUsd, rpm = 60, allowedModels = null, minTier = "economy", accountId = DEFAULT_ACCOUNT }) {
    if (this.agents.has(id)) throw new Error(`agent exists: ${id}`);
    if (!this.accounts.has(accountId)) throw new Error(`unknown account: ${accountId}`);
    const key = "mesh_" + randomBytes(18).toString("hex");
    this.agents.set(id, { accountId, budgetUsd, spentUsd: 0, reservedUsd: 0, rpm, allowedModels, minTier, key, hits: [] });
    this.keyIndex.set(key, id);
    return { id, key, budgetUsd, rpm, minTier, allowedModels, accountId };
  }

  agentByKey(key) { return this.keyIndex.get(key); }

  topUp(id, addUsd) { const a = this.agent(id); a.budgetUsd += Math.max(0, addUsd); return a.budgetUsd; }

  agent(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent: ${id}`);
    return a;
  }

  agentsIn(accountId) { return [...this.agents.entries()].filter(([, a]) => a.accountId === accountId); }

  // Try to reserve estUsd for `id`. Returns {ok, resId} or {ok:false, code, reason}.
  reserve(id, estUsd, model) {
    const a = this.agent(id);
    if (a.allowedModels && !a.allowedModels.includes(model))
      return { ok: false, code: "model_not_allowed", reason: `agent ${id} may not use ${model}` };

    const now = Date.now();
    a.hits = a.hits.filter((t) => now - t < 60_000);
    if (a.hits.length >= a.rpm)
      return { ok: false, code: "rate_limited", reason: `agent ${id} over ${a.rpm} rpm` };

    if (a.spentUsd + a.reservedUsd + estUsd > a.budgetUsd + 1e-12)
      return { ok: false, code: "budget_exceeded",
        reason: `agent ${id} would exceed $${a.budgetUsd.toFixed(4)} budget ` +
                `(spent $${a.spentUsd.toFixed(4)}, reserved $${a.reservedUsd.toFixed(4)}, need $${estUsd.toFixed(4)})` };

    // Treasury check is scoped to THIS agent's account — one tenant's cap
    // can never be exhausted by another tenant's traffic.
    const acc = this.account(a.accountId);
    const accSpent = this.totalSpent(a.accountId);
    const accReserved = this.agentsIn(a.accountId).reduce((s, [, x]) => s + x.reservedUsd, 0);
    if (accReserved + accSpent + estUsd > acc.treasuryUsd + 1e-12)
      return { ok: false, code: "treasury_exhausted",
        reason: `account treasury $${acc.treasuryUsd.toFixed(4)} can't cover this reservation` };

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
    this.requests.push({ ts: Date.now(), agent: id, accountId: a.accountId, resId, estUsd, actualUsd, ...meta });
  }

  // Release a reservation with no charge (upstream failed).
  release(id, resId, estUsd) {
    const a = this.agent(id);
    a.reservedUsd = Math.max(0, a.reservedUsd - estUsd);
    this.globalReserved = Math.max(0, this.globalReserved - estUsd);
  }

  // Total spend, optionally scoped to one account (defaults to all).
  totalSpent(accountId = null) {
    const agents = accountId ? this.agentsIn(accountId).map(([, a]) => a) : [...this.agents.values()];
    return agents.reduce((s, a) => s + a.spentUsd, 0);
  }

  // Serialize everything needed to resume exactly where we left off. Real
  // keys stay encrypted in the snapshot — restoring never touches plaintext.
  snapshot() {
    return {
      mode: this.mode,
      agents: [...this.agents.entries()],
      accounts: [...this.accounts.entries()],
      ownerIndex: [...this.ownerIndex.entries()],
      requests: this.requests.slice(-500), // cap: this is a log, not the ledger of record
      _resSeq: this._resSeq,
    };
  }

  static restore(data) {
    const defaultAcc = data.accounts?.find(([id]) => id === DEFAULT_ACCOUNT);
    // Pre-multi-account snapshots kept treasuryUsd at the top level with no
    // `accounts` array at all — fall back to that so an old on-disk
    // snapshot migrates cleanly instead of silently zeroing the cap.
    const treasuryUsd = defaultAcc?.[1]?.treasuryUsd ?? data.treasuryUsd ?? 0;
    const l = new Ledger({ treasuryUsd, mode: data.mode });
    if (data.accounts) for (const [id, acc] of data.accounts) l.accounts.set(id, acc);
    if (data.ownerIndex) for (const [tok, id] of data.ownerIndex) l.ownerIndex.set(tok, id);
    for (const [id, a] of data.agents) {
      a.reservedUsd = 0; // never resume a reservation across a restart
      if (!a.accountId) a.accountId = DEFAULT_ACCOUNT; // migrate pre-multi-tenant snapshots
      l.agents.set(id, a);
      l.keyIndex.set(a.key, id);
    }
    l.requests = data.requests || [];
    l._resSeq = data._resSeq || 0;
    return l;
  }

  // accountId omitted = the operator's shared "default" view (unchanged
  // behavior). Passed = that tenant's own isolated view only.
  report(accountId = DEFAULT_ACCOUNT) {
    const acc = this.account(accountId);
    const agents = this.agentsIn(accountId);
    const spent = this.totalSpent(accountId);
    const requests = this.requests.filter((r) => (r.accountId || DEFAULT_ACCOUNT) === accountId);
    return {
      mode: this.mode,
      accountId, accountLabel: acc.label,
      treasuryUsd: acc.treasuryUsd,
      totalSpent: spent,
      remaining: acc.treasuryUsd - spent,
      agents: agents.map(([id, a]) => ({
        id, budgetUsd: a.budgetUsd, spentUsd: +a.spentUsd.toFixed(6),
        remaining: +(a.budgetUsd - a.spentUsd).toFixed(6), requests: a.hits.length,
        minTier: a.minTier, keyHint: (a.key || "").slice(0, 12) + "…",
        allowedModels: a.allowedModels || null,
      })),
      requestCount: requests.length,
      recent: requests.slice(-15).reverse().map((r) => ({
        agent: r.agent, model: r.model, tier: r.tier,
        downgradedFrom: r.downgradedFrom || null,
        cost: +(r.actualUsd ?? 0).toFixed(6), ts: r.ts,
      })),
    };
  }
}
