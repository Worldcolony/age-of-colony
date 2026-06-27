# TxLINE / TxODDS — Technical Documentation & Live Probe
*2026-06-25 · researched for the Superteam × TxODDS World Cup hackathon*
*(filename note: requested as "txlinedocuemntation"; saved clean as `txline-documentation.md`)*

## TL;DR
TxLINE is **TxODDS' football data feed delivered as a Solana-native, cryptographically
verifiable oracle**. It serves **fixtures, odds, and live scores**, each update backed by
**Merkle proofs you can verify on-chain** (Solana). Access is gated by an **on-chain
subscription** (an Anchor program), not a plain API key. For the World Cup it has a
**FREE real-time tier**. Docs: https://txline-docs.txodds.com · API base:
`https://txline.txodds.com` · OpenAPI: `https://txline.txodds.com/docs/docs.yaml`.

This is the single biggest gap-filler for our project: we kept losing in-play arbitrage to
**slow score data + no executable venue** (see notes/2026-06-20-worldcupFE.md, the
Qatar/Switzerland counterfactuals). TxLINE is a **real-time, on-chain-verifiable score+odds
feed** — it closes the data half of that gap, and on the right chain for a Solana hackathon.

---

## 1. Architecture / auth flow (probed live 2026-06-25)
Hybrid off-chain API + on-chain entitlement:

1. **Guest JWT** — `POST https://txline.txodds.com/auth/guest/start` → `{ "token": "<JWT>" }`.
   ✅ Confirmed live (returns an ES256 JWT, `role: guest`). Used only for the purchase/quote
   and token-activation steps — **NOT enough to read data**.
2. **Subscribe on-chain (Solana)** — call the TxLINE Anchor program:
   `program.methods.subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)` with `SELECTED_LEAGUES=[]`
   for a standard bundle. Free tiers cost 0; paid tiers spend TxL tokens (buy via
   `POST /api/guest/purchase/quote` with `buyerPubkey` + `txlineAmount`).
3. **Activate → API token** — build a message of (tx signature + selected leagues + JWT),
   sign it with the wallet (NaCl detached sig), `POST /api/token/activate` → returns the
   **API token**.
4. **Read data** — `Authorization: Bearer <API_TOKEN>` on the `/api/*` data endpoints.

**Live probe result:** the guest JWT hits the data endpoints but returns
`"Missing API token"` — i.e. **even the FREE World Cup tier requires the on-chain
subscribe + activate** to mint a data token. Endpoints exist (401/`Missing API token`
without it): `/api/leagues`, `/api/fixtures`, `/api/scores`, `/api/odds`, `/api/bundles`,
`/api/health`. (Root `/` is 404; there is no unauthenticated data path.)

> Action for us: to actually pull World Cup data we must run the Solana subscribe(12,4)
> + activate flow from a funded devnet/mainnet wallet (we already have Phantom + a Solana
> wallet in the stack — see SOLANA/). Program addresses + IDL:
> https://txline-docs.txodds.com/documentation/programs/addresses.md (mainnet/devnet).

---

## 2. Data API (from the docs index / llms.txt)
REST + **Server-Sent Events (SSE) streaming**. All under `https://txline.txodds.com/api/...`.

**Fixtures**
- Latest snapshot (optionally from/within 30 days of an epoch day)
- All updates for a single fixture on a given day
- Merkle proof for a single fixture update; Merkle proof for a whole hourly batch

**Odds** (the "StablePrice" feed)
- Live current odds for a fixture · latest snapshots · historical 5-min interval array
- **Real-time SSE stream of odds updates** · Merkle proof for a specific odds update

**Scores**
- **Real-time SSE stream of score updates** · historical 5-min interval · full sequence for
  a fixture · current 5-min window · latest score-event snapshots
- **3-stage Merkle proof for a single score statistic** (the settlement primitive)

**Soccer scores data model** (`documentation/scores/soccer-feed.md`)
- Stats per participant: **goals, yellow cards, red cards, corners** — full game and per period.
- **Period addressing:** `key = period*1000 + base_key` (1H +1000, 2H +2000, ET +3000/4000,
  pens +5000). So you can read "2nd-half goals", "1st-half corners", etc.
- **Match state = 19 phases** (1 = Not started → in-play halves/ET/pens → 16 Cancelled,
  17 TX Coverage Cancelled). Gives live period/state; minute/stoppage representation not
  fully spelled out in the excerpt (full soccer-feed PDF linked in docs).
- Feeds also exist for basketball + American football.

---

## 3. The on-chain verification model (the killer feature)
`documentation/examples/onchain-validation.md`:
- TxODDS publishes **daily Merkle roots** of all score/odds/fixture updates into a Solana
  **PDA `daily_scores_roots`** (indexed by epoch day).
- Proof hierarchy: stat → event-stats root → **daily root on-chain**. Three-stage proof.
- A consumer program exposes **`validateStat(fixtureSummary, proof, stat, predicate)`** —
  run read-only (view/simulation) or in a tx — to **prove on-chain that "team X scored ≥ N
  goals" (or any stat/threshold) is authentic**, without trusting a live feed.
- PDA derivation: `findProgramAddressSync(["daily_scores_roots", epochDay], programId)`.
- Settlement recipe: fetch validation data (`/api/scores/stat-validation`) → build proof +
  comparison predicate → call `validateStat()` → settle positions on the boolean.

**Why this matters:** this is a *trustless settlement oracle for match outcomes*. It is the
clean alternative to what we studied with UMA's optimistic oracle (propose → dispute window →
settle): here the result is **cryptographically proven against an on-chain root** — no dispute
game, no human. That is a prediction-market settlement primitive, handed to us.

---

## 4. Bundles / tiers / pricing — and the **$500 question, answered**
Free (World Cup + Int Friendlies, `SELECTED_LEAGUES=[]`):
| Service Level | Bundle | Delay | Price / 28d |
|---|---|---|---|
| **1** | World Cup & Int Friendlies | 60 seconds | **Free** |
| **12** | World Cup & Int Friendlies | **Real-time** | **Free** |

Paid (more leagues; "Scores + StablePrice odds" across all tiers):
| ID | Coverage | Delay | Price/28d |
|---|---|---|---|
| 2 | **10 leagues** | 60s | **$500** (500,000 TxL) |
| 3 | 25 leagues | 60s | $750 |
| 4 | 50 leagues | 60s | $1,000 |
| 5 | 100 leagues | 60s | $1,250 |
| 6 | ALL leagues | 60s | $2,500 |
| 7–11 | (real-time equivalents) | real-time | **~10× delayed** ($5k–$25k) |

> **VERDICT on spending $500:** for a **World-Cup-focused** build, **don't.** The free
> **Service Level 12 already gives REAL-TIME World Cup data** — the most we'd ever want for
> this tournament. The $500 tier (ID 2) only adds **10 *other* leagues at a 60-second delay**;
> it does **not** improve World Cup latency or depth. Real-time for non-WC leagues starts at
> ~$5,000 (IDs 7–11). So: **use free SL12 for the hackathon.** Only pay if the product needs
> club leagues (EPL etc.) — and even then $500 buys *delayed* non-WC data, which is the wrong
> trade for anything latency-sensitive.

---

## 5. What TxLINE gives us that we didn't have
- **Real-time scores (free, SL12)** → the fast in-play feed we lacked; replaces our ESPN
  scraping hack in `marketwatch/marketwatch.py` with a first-class, low-latency source.
- **Real-time odds (StablePrice)** → a market benchmark to compute edge against, like we
  used Polymarket implied odds — but now a clean feed.
- **Merkle-proof on-chain verification** → trustless settlement (the UMA-replacement).
- **It's Solana-native** → matches the hackathon ecosystem; we already added Phantom/Solana
  wallet support (SOLANA/, frontend wallet.js).

## 6. Open items before building
- [ ] Run `subscribe(12, 4)` + activate from a Solana wallet (devnet first) → get an API
      token → confirm we can stream live World Cup scores. (Program addrs + IDL in docs.)
- [ ] Read the full soccer-feed PDF for the exact live-minute / stoppage encoding.
- [ ] Pull the OpenAPI (`/docs/docs.yaml`) to codegen a typed client.
- [ ] Find the 2026 World Cup competition/league ID (not in the free-tier doc excerpt; in
      `/api/leagues` once we have a token).

## Sources
- Docs index: https://txline-docs.txodds.com/llms.txt
- Quickstart / World Cup tier / subscription tiers / on-chain validation / soccer feed (all
  under https://txline-docs.txodds.com/documentation/…)
- Live probe of `https://txline.txodds.com` (guest auth + endpoint status), 2026-06-25.
