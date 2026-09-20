// The treasury proxy: an OpenAI-compatible endpoint that fronts the ONE real
// Orbio key. Agents call it with a virtual key (mesh-<id>); the proxy enforces
// per-agent budgets/rate, reserves worst-case cost, forwards upstream, then
// settles to the real cost from the response usage block.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { estimateMaxCost, actualCost, loadModels } from "./pricing.js";
import { Router } from "./router.js";
import { getQuote } from "./chain.js";
import { planTopUp } from "./provisioning.js";
import { Governor } from "./governor.js";
import { Alerter } from "./alerts.js";

const roughPromptTokens = (messages) => {
  const chars = (messages ?? []).reduce((n, m) =>
    n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
  return Math.max(1, Math.ceil(chars / 4)); // ~4 chars/token heuristic
};

export function createProxy({ ledger, upstreamUrl, upstreamKey, defaultMaxTokens = 256, router = null,
                               governor = null, treasuryOwner = null, alerter = null }) {
  let _router = router;
  const getRouter = async () => (_router ??= await Router.create());
  const __dir = dirname(fileURLToPath(import.meta.url));
  const gov = governor || new Governor();
  const alerts = alerter || new Alerter();
  // Runs independent of anyone watching the dashboard — the whole point of
  // an alert is that it doesn't require a human to be looking at the time.
  const alertTimer = setInterval(() => { alerts.check(ledger, gov).catch(() => {}); }, 5000);
  let _sig = { at: 0, data: null };

  // Ground truth: the ledger's totals are Mesh's own bookkeeping, which is
  // reset by a restart. In live mode we also poll Orbio's real key balance
  // so the dashboard can show actual account state, not just what this
  // process has seen — and so drift between the two is visible, not silent.
  let _gw = { at: 0, data: null };
  async function gatewayTruth() {
    if (ledger.mode !== "live") return null;
    if (Date.now() - _gw.at < 8_000 && _gw.data) return _gw.data;
    try {
      const res = await fetch(`${upstreamUrl}/v1/key`, { headers: { authorization: `Bearer ${upstreamKey}` } });
      const j = await res.json();
      _gw.data = { available: Number(j.balance?.available), used: Number(j.balance?.used) };
      _gw.at = Date.now();
    } catch (e) { /* keep last known value on a transient failure */ }
    return _gw.data;
  }
  async function marketSignal() {
    if (Date.now() - _sig.at < 10_000 && _sig.data) return _sig.data;
    const ladder = [];
    for (const s of [1, 5, 25]) { try { ladder.push(await getQuote(s)); } catch {} }
    let plan = null;
    try { plan = await planTopUp({ needUsd: Math.max(1, ledger.treasuryUsd - ledger.totalSpent()) }); } catch {}
    _sig = { at: Date.now(), data: { ladder, plan } };
    return _sig.data;
  }
  const readBody = (req) => new Promise((res, rej) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); req.on("error", rej);
  });

  return http.createServer(async (req, res) => {
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        try {
          const html = await readFile(join(__dir, "..", "landing.html"), "utf8");
          res.writeHead(200, { "content-type": "text/html" }); return res.end(html);
        } catch (e) { return send(500, { error: { message: "landing.html not found" } }); }
      }
      if (req.method === "GET" && (req.url === "/app" || req.url === "/dashboard.html")) {
        try {
          const html = await readFile(join(__dir, "..", "dashboard.html"), "utf8");
          res.writeHead(200, { "content-type": "text/html" }); return res.end(html);
        } catch (e) { return send(500, { error: { message: "dashboard.html not found" } }); }
      }
      if (req.method === "GET" && req.url === "/mesh/report") {
        const rep = ledger.report();
        rep.gateway = await gatewayTruth(); // null in mock mode; real balance in live mode
        return send(200, rep);
      }
      if (req.method === "GET" && req.url === "/mesh/signal") return send(200, await marketSignal());

      if (req.method === "GET" && req.url === "/mesh/governor") return send(200, gov.status(ledger));
      if (req.method === "GET" && req.url === "/mesh/alerts") return send(200, { log: alerts.log });

      if (req.method === "GET" && req.url.startsWith("/mesh/topup/prepare")) {
        if (!treasuryOwner) return send(400, { error: { message: "no treasuryOwner address configured" } });
        const url = new URL(req.url, "http://x");
        const needUsd = Number(url.searchParams.get("needUsd")) || 1;
        const decision = await gov.decide({ ledger, needUsd, beneficiary: treasuryOwner });
        return send(200, decision);
      }
      // Not a spend: only records that a prepared buy was actually taken to a
      // signer, so the auto-buy ceiling reflects reality. Executing/signing
      // the transaction itself is never done here.
      if (req.method === "POST" && req.url === "/mesh/topup/confirm") {
        const b = JSON.parse((await readBody(req)) || "{}");
        if (!(Number(b.usdgInDollars) > 0)) return send(400, { error: { message: "usdgInDollars required" } });
        gov.recordAutoBuy(Number(b.usdgInDollars));
        return send(200, { recorded: true, autoBoughtInWindow: gov.autoBoughtInWindow() });
      }

      // --- admin: provision agents / virtual keys ---
      if (req.method === "POST" && req.url === "/mesh/agents") {
        if (process.env.MESH_ADMIN_TOKEN && req.headers["x-mesh-admin"] !== process.env.MESH_ADMIN_TOKEN)
          return send(403, { error: { message: "admin token required" } });
        const b = JSON.parse((await readBody(req)) || "{}");
        if (!b.id || !(Number(b.budgetUsd) > 0))
          return send(400, { error: { message: "id and a positive budgetUsd are required" } });
        if (ledger.agents.has(b.id))
          return send(409, { error: { message: `agent already exists: ${b.id}` } });
        const allowedModels = Array.isArray(b.allowedModels) && b.allowedModels.length
          ? b.allowedModels.map(String) : null;
        const created = ledger.addAgent(String(b.id), {
          budgetUsd: Number(b.budgetUsd), rpm: Number(b.rpm) || 60,
          minTier: b.minTier || "economy", allowedModels });
        return send(200, { ...created, allowedModels, note: "store this key now — it is shown only once" });
      }
      if (req.method === "POST" && req.url === "/mesh/topup") {
        if (process.env.MESH_ADMIN_TOKEN && req.headers["x-mesh-admin"] !== process.env.MESH_ADMIN_TOKEN)
          return send(403, { error: { message: "admin token required" } });
        const b = JSON.parse((await readBody(req)) || "{}");
        if (!ledger.agents.has(b.id)) return send(404, { error: { message: "unknown agent" } });
        return send(200, { id: b.id, budgetUsd: ledger.topUp(b.id, Number(b.addUsd) || 0) });
      }
      if (!(req.method === "POST" && req.url === "/v1/chat/completions"))
        return send(404, { error: { message: "not found" } });

      const token = (req.headers.authorization || "").replace(/^Bearer\s+/, "").trim();
      const agentId = ledger.agentByKey(token);
      if (!agentId)
        return send(401, { error: { message: "invalid mesh virtual key" } });

      const body = JSON.parse(await readBody(req));
      const requested = body.model;
      const maxTokens = body.max_tokens ?? defaultMaxTokens;
      const promptTokens = roughPromptTokens(body.messages);
      const minTier = body.mesh_min_tier || req.headers["x-mesh-min-tier"]
        || ledger.agent(agentId).minTier || "economy";

      // Cost-aware routing: pick a model that fits the remaining budget,
      // downgrading (no lower than minTier) instead of rejecting outright.
      const a0 = ledger.agent(agentId);
      const budgetRemaining = a0.budgetUsd - a0.spentUsd - a0.reservedUsd;
      let choice;
      try {
        choice = await (await getRouter()).choose({
          requested, minTier, budgetRemaining, promptTokens, maxTokens });
      } catch (e) { return send(400, { error: { message: e.message } }); }
      if (choice.error)
        return send(402, { error: { message: choice.error, type: "budget_exceeded" } },
          { "x-mesh-reason": "budget_exceeded" });

      const model = choice.model;
      const estUsd = choice.estUsd;
      const r = ledger.reserve(agentId, estUsd, model);
      if (!r.ok) {
        // "Top up instead of dying": on a treasury-wide shortfall, ask the
        // governor whether refilling from the book is safe right now, and
        // hand back exactly what that would take — still just a 402, but
        // one that carries the next move instead of a dead end.
        let suggestedTopUp = null;
        if (r.code === "treasury_exhausted" && treasuryOwner) {
          try { suggestedTopUp = await gov.decide({ ledger, needUsd: estUsd, beneficiary: treasuryOwner }); }
          catch (e) { suggestedTopUp = { action: "ERROR", reason: e.message }; }
        }
        return send(r.code === "rate_limited" ? 429 : 402,
          { error: { message: r.reason, type: r.code }, suggestedTopUp },
          { "x-mesh-reason": r.code });
      }

      // Forward upstream with the REAL key. (Mock or live Orbio gateway.)
      let up, upJson;
      try {
        up = await fetch(`${upstreamUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify({ ...body, model, max_tokens: maxTokens }),
        });
        upJson = await up.json();
      } catch (e) {
        ledger.release(agentId, r.resId, estUsd);
        return send(502, { error: { message: `upstream failed: ${e.message}` } });
      }

      if (!up.ok) {                                  // upstream refused (e.g. 402): no charge
        ledger.release(agentId, r.resId, estUsd);
        return send(up.status, upJson, { "x-mesh-reason": "upstream_error" });
      }

      const u = upJson.usage ?? {};
      // Orbio's real gateway reports exact cost in usage.cost; trust it when
      // present (it accounts for real provider pricing) and only estimate
      // from token counts against the mock gateway, which has no cost field.
      const cost = (typeof u.cost === "number")
        ? u.cost
        : await actualCost({
            model,
            promptTokens: u.prompt_tokens ?? promptTokens,
            completionTokens: u.completion_tokens ?? maxTokens,
          });
      ledger.settle(agentId, r.resId, estUsd, cost, {
        model, tier: choice.tier,
        downgradedFrom: (choice.downgradedFrom && choice.downgradedFrom !== model)
          ? choice.downgradedFrom : null,
        promptTokens: u.prompt_tokens ?? promptTokens,
        completionTokens: u.completion_tokens ?? maxTokens,
      });

      const a = ledger.agent(agentId);
      send(200, upJson, {
        "x-mesh-cost-usd": cost.toFixed(6),
        "x-mesh-model-used": model,
        "x-mesh-tier": choice.tier,
        ...(choice.downgradedFrom && choice.downgradedFrom !== model
            ? { "x-mesh-downgraded-from": choice.downgradedFrom } : {}),
        "x-mesh-agent-remaining-usd": (a.budgetUsd - a.spentUsd).toFixed(6),
        "x-mesh-treasury-remaining-usd": (ledger.treasuryUsd - ledger.totalSpent()).toFixed(6),
      });
    } catch (e) {
      send(500, { error: { message: e.message } });
    }
  });
}
