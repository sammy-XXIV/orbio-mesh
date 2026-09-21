# Mesh

**Live: [mesh.sammyxxiv.xyz](https://mesh.sammyxxiv.xyz)**

Budgeted, metered inference for a swarm of agents on one Orbio key. Built for
Orbio Build Week.

Orbio gives every account **one API key that spends the entire balance**, and
reports a single lifetime `used` number. Fine for one agent — useless the
moment a team, a product, or a swarm of agents needs to share it. Mesh sits in
front of that one key and turns it into something safe to hand out: budgeted
virtual keys, real per-request attribution, and routing that degrades
gracefully instead of failing outright.

## What it does

- **Per-agent virtual keys, real budgets.** Mint a `mesh_…` key with a dollar
  cap, a rate limit, and an optional model allow-list. Reservation accounting
  (*reserve worst-case → settle actual*) keeps it overdraw-safe under
  concurrent requests. (`src/ledger.js`)
- **Bring your own Orbio key.** Anyone can connect their own account — by
  signing one message with a wallet (Orbio's own documented key-derivation
  flow, no dashboard visit) or by pasting a key — and gets a fully isolated
  treasury. One tenant's traffic can never see or spend another's balance,
  including the operator's own. Keys are AES-256-GCM encrypted at rest and
  never appear in any response after validation. (`src/crypto.js`,
  `POST /mesh/accounts`)
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

See `.env.example`. Two standalone scripts if you just want the read-only
pieces, no key or funds required:

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
