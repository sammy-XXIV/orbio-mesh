# Mesh

**Live: [mesh.sammyxxiv.xyz](https://mesh.sammyxxiv.xyz)**

The control plane a raw Orbio key doesn't have. Built for Orbio Build Week.

An Orbio key is a single blank check: it spends the entire balance, on
anything, with no cap, and reports back one lifetime `used` number. That's
fine for one person testing prompts. It falls apart the moment the key is
shared — a team, a product, a swarm of agents — because there is no way to
say *this much, to this agent, no further* and no way to tell afterward *who
spent what, on what*.

Mesh sits in front of the real key and turns it into infrastructure: budgeted
virtual keys per agent, real per-request cost attribution, routing that
degrades instead of failing, and a governed path back to more balance —
priced against the live CREDIT market, never auto-signed.

## What it does

- **Per-agent virtual keys, real budgets.** Mint a `mesh_…` key with a dollar
  cap, a rate limit, and an optional model allow-list. Reservation accounting
  (*reserve worst-case → settle actual*) keeps it overdraw-safe under
  concurrent requests. (`src/ledger.js`)
- **Bring your own Orbio key, by wallet signature.** Sign one message —
  Orbio's own documented key-derivation flow, no dashboard visit, no key ever
  typed — and get a fully isolated treasury. One tenant's traffic can never
  see or spend another's balance, including the operator's own. Keys are
  AES-256-GCM encrypted at rest and never appear in any response after
  validation. (`src/crypto.js`, `POST /mesh/accounts`)
- **Cost-aware routing.** If a request would blow an agent's budget, Mesh
  downgrades to the cheapest model that still meets a configurable quality
  floor instead of just rejecting it. (`src/router.js`)
- **Market-aware provisioning.** Reads the live CREDIT order book on
  Robinhood Chain and decides whether activating more balance is actually a
  good deal right now — activation is a permanent burn, and CREDIT trades on
  a real market. (`src/chain.js`, `src/provisioning.js`)
- **Governed buy-side.** On a shortfall, constructs the real, signable
  transaction to top up from the book instead of just failing — gated by a
  burn-rate kill switch, a rolling auto-buy ceiling, and a price circuit
  breaker that never activates CREDIT above its $1 face value. Never signs or
  sends anything; that stays a human decision. (`src/governor.js`,
  `src/buyside.js`)
- **Alerts.** Fires on state *changes* — a kill switch tripping, the ceiling
  being hit, an agent running low — not on every poll, and works whether or
  not anyone's watching the dashboard. (`src/alerts.js`)
- **Restart-safe.** The ledger snapshots to disk continuously; a crash or
  redeploy resumes exactly where it left off instead of losing agents, keys,
  or spend history. (`src/persist.js`)

## Stack

Node.js (ESM), zero runtime dependencies — the HTTP server, the proxy,
AES-256-GCM encryption, and wallet-signature verification are all standard
library. Vanilla HTML/CSS/JS on the frontend, no build step. Robinhood Chain
(4663) read via public RPC for live CREDIT pricing. Disk-backed JSON for
persistence. Deployed on Railway, auto-deploying off `main`.

- A request's cost is reserved against the agent's budget before the
  upstream call ever fires, and settled to the real cost once Orbio
  responds — two concurrent requests from the same agent can't both slip
  through a budget check that was true a moment ago but isn't anymore.
- Wallet connect signs the exact message Orbio's docs define — `Orbio API
  key · chain 4663 · epoch ${epoch}` — via raw `personal_sign`. Nothing is
  generated or stored client-side beyond that.
- Every stateful piece — the ledger, the router's budget check, the
  governor's burn-rate tracking, the alerter's transition state — is keyed
  by `accountId` from the start. A tenant's traffic can't read or perturb
  another account's numbers, including the operator's own.
- The buy-side only ever constructs a transaction, never sends one.
  `buyside.js` builds real `approve` + `buyAndActivate` calldata with a
  slippage-guarded minimum, gated behind a burn-rate kill switch, a rolling
  ceiling, and a price circuit breaker at $1 face — but it always ends at
  unsigned calldata.

## Try it

Open **[mesh.sammyxxiv.xyz](https://mesh.sammyxxiv.xyz)**, click **Connect
wallet**, sign the one message. You'll get a budgeted virtual key and a
ready-to-copy `curl` / OpenAI-SDK snippet to start using it immediately —
against your own Orbio balance, isolated from everyone else's.

## Run it locally

```bash
npm install   # no dependencies to install, but keeps the workflow standard
node serve.js
```

Without `ORBIO_UPSTREAM` set, it runs against a bundled mock gateway so the
whole engine — budgets, routing, metering — works with no key and no funds.
Point it at the real gateway with:

```bash
ORBIO_UPSTREAM=https://api.orbio.so/api
ORBIO_KEY=sk-orbio-...        # or sk-orb-... from a wallet signature
MESH_ENC_SECRET=<random>      # required to store connected accounts
MESH_ADMIN_TOKEN=<random>     # optional: gates minting against the shared account
```

Two standalone scripts if you just want the read-only pieces, no key or
funds required:

```bash
node signal.js 20    # live provisioning decision against the real chain
```

## Layout

```
serve.js             boots the proxy + dashboard + landing page
landing.html          public landing page
dashboard.html        the live dashboard (mint keys, connect wallet, watch spend)
signal.js             standalone live provisioning signal
demo.js / router-demo.js / mock-gateway.js   offline demos against a fake gateway

src/ledger.js          budgets, reservation accounting, multi-account isolation
src/proxy.js            the OpenAI-compatible metering proxy
src/router.js           cost-aware model routing + auto-downgrade
src/chain.js            reads the Exchange contract on Robinhood Chain
src/pricing.js          public /api/v1/models cost estimation
src/provisioning.js     activate-vs-buy decision engine
src/governor.js         burn-rate kill switch, auto-buy ceiling, price breaker
src/buyside.js          constructs the real top-up transaction (never signs)
src/alerts.js           fires on governance state changes
src/crypto.js           AES-256-GCM encryption for connected accounts' keys
src/persist.js          disk snapshot so a restart doesn't lose state
```

## License

MIT — see [LICENSE](LICENSE).
