# Superteam × TxODDS World Cup Hackathon — Fit & Top Ideas
*2026-06-25 · compiled from the listings + our existing WorldColony stack*
*Companion: `notes/2026-06-25-txline-documentation.md` (the TxLINE API findings).*

## The hackathon at a glance
- **Host / sponsor:** Superteam Earn × **TxODDS** (data provider). **Chain: Solana.**
- **Core ask:** build on Solana using **TxODDS' live football API (TxLINE)** — a real-time,
  Merkle-verifiable feed of fixtures, odds, and scores.
- **Timeline:** submissions **Jun 24 → Jul 19 2026**; winners announced **Jul 29**.
- **Prize pool: $50,000 USDT across 3 tracks:**

| Track | 1st | 2nd | 3rd | Total |
|---|---|---|---|---|
| **Prediction Markets & Settlement** | 12,000 | 4,000 | 2,000 | **18,000** |
| **Trading Tools & Agents** | 10,000 | 4,000 | 2,000 | **16,000** |
| **Consumer & Fan Experiences** | 10,000 | 4,000 | 2,000 | **16,000** |

(Listings are thin on written requirements — themes only. Multi-track entry appears
allowed per the FAQ. Questions go to Telegram `@TxLINEChat`.)

## Why we're unusually well-positioned
We just spent a full ETHGlobal build on **exactly this domain**: AI agents that forecast
World Cup matches, place **real on-chain prediction-market bets** (12 live PolyGun/Polymarket
trades), settle against **UMA**, meter a **knowledge-plane oracle** (ClickHouse + x402), and
visualize it as a living **3D colony**. Our stack maps onto all three tracks — and TxLINE
fixes our single biggest pain (slow scores → lost in-play arbitrage; "we had the read, lost
it to speed + venue" — see 2026-06-20-worldcupFE.md).

**Assets we already have (reusable IP):**
- `colony/` — genome-based forecasting **agent swarm** (debate → consensus → bet), evolution.
- Execution rails — PolyGun userbot + direct-CLOB stack + `bet_*` one-command scripts.
- `clickhouse_api/` — metered, timestamp-gated **data oracle** (x402; gate is real, payment
  stub — see 2026-06-20-clickhouseapiexposurebug.txt).
- UMA settlement study (`uma_oo_v2_events_decoded`) — we understand oracle resolution deeply.
- 3D **WorldColony** viz + **World Cup predictions page** + **Solana/Phantom** multiplayer
  colonies (SOLANA/, frontend wallet.js, Supabase).
- `marketwatch/` — live score + countdown + price dashboard (currently ESPN-scraped → swap to
  TxLINE real-time).

**The honest lift (don't gloss over it):** our economy/contracts are **EVM** (Arc/Polygon/
Ethereum). This hackathon is **Solana**. The chain-agnostic parts (the Python colony brain,
the forecasting logic, the viz, the data plumbing) port cleanly; the **market + settlement
contracts must be rewritten as Solana/Anchor programs**, and the data feed becomes TxLINE
(which is itself Solana + Anchor). That Anchor work is the main new build. Our 12 EVM trades
are credibility/prior-art, not reusable code.

---

## TOP 3 IDEAS

### 🥇 Idea 1 — "FullTime": trustless World Cup prediction market settled by Merkle-proven scores
**Track: Prediction Markets & Settlement (18k — biggest prize, best fit).**
A Solana prediction market on World Cup matches where **settlement is automatic and trustless**
via TxLINE's on-chain Merkle proofs. When a match ends, an Anchor program calls
`validateStat()` against the `daily_scores_roots` PDA to **cryptographically prove the final
score**, then pays out — **no oracle committee, no UMA dispute window, no human**.
- **Why us:** we've executed real prediction-market trades, studied UMA's propose→dispute→
  settle cycle, and felt its latency. TxLINE's Merkle settlement is the clean upgrade we can
  speak to credibly. We already understand market mechanics (neg-risk, AMM/CLOB, the
  liquidity-wall trap at the close).
- **Demo money-shot:** place a bet on a live match; the instant the whistle blows, the
  contract verifies the score on-chain and settles in the same block. "No oracle. The score
  *is* the proof."
- **Scope:** Anchor market program (binary + 3-way) + TxLINE Merkle verification + a thin UI
  (reuse our worldcup page styling). The settlement-verification path is the wow; keep the
  market mechanics minimal.

### 🥈 Idea 2 — "The Colony, on Solana": evolutionary forecasting agents on a real-time feed
**Track: Trading Tools & Agents (16k).**
Port our agent-colony brain to Solana and feed it **TxLINE's real-time SSE scores + odds**.
The ants now make **in-play** decisions on a feed fast enough to capture the edge we kept
losing, trade the Idea-1 market (or a TxLINE-fed AMM), and evolve by P&L.
- **Why us:** this *is* our thesis ("forecasting is the labor, the market is the judge"), and
  it directly solves our #1 documented failure — slow data. Genome ants + debate + consensus
  is built; we re-point the data adapter at TxLINE and the execution at a Solana venue.
- **Trading tools angle:** ship the **agent + the human tools** together — `marketwatch`
  (live score/countdown/price, now TxLINE-real-time) + a one-command Solana auto-bet executor
  (the reliable fast path PolyGun never gave us).
- **Demo:** ants react to a goal within seconds (TxLINE real-time) and reprice/trade before
  the market does — the in-play arbitrage we couldn't execute on EVM.

### 🥉 Idea 3 — "WorldColony Live": watch an AI swarm bet your match in real time
**Track: Consumer & Fan Experiences (16k).**
The fan-facing layer: our **3D colony viz + Phantom-wallet multiplayer** driven by TxLINE
live scores. A fan connects Phantom, "founds" a colony, picks a match, and **watches their
ants forage, debate, and stake live as the game unfolds** — goals/cards from TxLINE ripple
through the swarm in real time (the matchwatch countdown + score, but as the immersive 3D
world we already built).
- **Why us:** the 3D WorldColony, the Solana wallet onboarding, and the multiplayer Supabase
  layer **already exist** — this is the most "already-built" of the three. Swap the data
  source to TxLINE and theme it to a single live match.
- **Demo:** a goal happens → within seconds the colony erupts, stakes shift, the leading
  side's ants surge — fans see "the swarm felt the goal."

---

## Recommendation
- **Lead with Idea 1 (Prediction Markets & Settlement).** Biggest prize (18k), tightest fit
  with our execution+settlement experience, and TxLINE's Merkle settlement gives a genuinely
  novel, clean, judge-legible demo. The new Anchor work is contained (a settlement-verifier +
  a minimal market).
- **These three compose into ONE system** (a colony of agents trading a trustlessly-settled
  market, watched live) — so we can submit Idea 1 as the flagship and, if time allows, enter
  Ideas 2/3 as the agent layer and the fan layer of the same demo (multi-track is allowed).
- **Money:** per the TxLINE doc, **use the FREE real-time World Cup tier (Service Level 12)** —
  **do not spend $500** (that only buys *delayed* non-World-Cup leagues; it does nothing for
  World Cup latency).
- **First spike (de-risk early, like last time):** run the Solana `subscribe(12,4)` + activate
  flow and stream one live World Cup match's scores end-to-end, and stand up a "hello,
  `validateStat()` proves a score on devnet" program. If those two work, all three ideas are
  unblocked. (Mirror our ETHGlobal lesson: prove the sponsor plumbing on day one.)

## Open questions to confirm
- Exact written track requirements / judging criteria (listings are sparse — ask `@TxLINEChat`).
- 2026 World Cup competition/league ID inside TxLINE (need a data token to list `/api/leagues`).
- Whether the tournament is far enough along by Jul 19 to demo live knockout matches, or if we
  again lean on a replay of resolved fixtures (we have that engine).
