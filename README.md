# Orbio Mesh

A treasury + provisioning layer that lets a **swarm of agents share one Orbio key
safely** — with per-agent budgets, real spend attribution, and market-aware
credit activation. Built for Orbio Build Week.

## The gap it fills

Orbio gives an account **one key that spends the entire balance**, and reports a
single lifetime `used` number. That's fine for one agent, but a team or product
can't:
- cap each agent's spend,
- see who spent what,
- or decide *when* turning CREDIT into inference is actually a good deal.

Mesh adds exactly those three, without changing anything upstream.

## What it does

1. **Virtual keys with budgets** — each agent gets `mesh-<id>` with a dollar cap,
   rate limit, and optional model allow-list. Overdraw-safe under concurrency via
   *reserve-worst-case → settle-actual* accounting (`src/ledger.js`).
2. **Metering proxy** — an OpenAI-compatible endpoint fronting the one real key.
   Enforces budgets, forwards upstream, and attributes real cost per request from
   the response `usage` block (`src/proxy.js`).
3. **Market-aware provisioning** — reads the live CREDIT order book on Robinhood
   Chain and decides *activate now / which tranche / don't overpay*, because
   activation is a permanent burn (`src/provisioning.js`, `src/chain.js`).

## Live findings (read-only, no key or funds needed)

`node signal.js` queries the real Exchange contract:
- Exchange fee is a flat **2%** of spend.
- CREDIT trades **~$0.68–0.77** but each activates **$1** of inference →
  a **~23–31% discount**, with small tranches cheapest (order-book slippage).
- The engine turns that into a concrete `BUY_AND_ACTIVATE` / `DO_NOT_ACTIVATE` call.

## Run it

```bash
# 1) live market signal (no key, no funds)
node signal.js 20

# 2) full metering demo against a mock gateway
node mock-gateway.js &      # fake Orbio gateway with a real usage block
node demo.js                # 2 workers, tight budget on one -> it gets capped
node router-demo.js         # tight budget -> request downgrades instead of failing
```

Demo output shows one worker capped (`budget_exceeded`) while the other runs, plus
a per-agent ledger report.

## Go live

The demo runs on a mock so it needs no balance. To use the real gateway, set
`ORBIO_UPSTREAM=https://api.orbio.so/api` and `ORBIO_KEY=<your key>` (see
`.env.example`) — the proxy code is unchanged. Requires the account's accrued
balance to be spendable at the gateway.

## Layout

```
signal.js          live provisioning signal (runnable)
demo.js            2-worker metering demo (runnable)
router-demo.js     cost-aware routing / auto-downgrade demo (runnable)
mock-gateway.js    stand-in Orbio gateway for offline demo
src/chain.js       Exchange getQuote/feeBps read + decode
src/pricing.js     public /api/v1/models cost estimation
src/provisioning.js activate-vs-buy decision engine
src/router.js      cost-aware model routing + auto-downgrade
src/ledger.js      budgets + reservation accounting + attribution
src/proxy.js       OpenAI-compatible metering proxy
```
