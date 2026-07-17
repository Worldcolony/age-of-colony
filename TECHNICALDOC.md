# Age of Colony — Technical Documentation

*TxODDS × Superteam World Cup Hackathon — "Consumer & Fan Experiences" submission*

---

## 1. Core Idea

**Age of Colony** turns TxODDS's live World Cup feed into a game you *play with*, not just
watch. We subscribe to the TXLine oracle on Solana — an on-chain subscription plus an off-chain
token — and stream normalized match events (corners, cards, substitutions, penalties, goals)
straight into a living ant-colony simulation. Fans don't just predict outcomes on a form; they
raise a colony of AI ants, each with its own personality, memory, and risk temperament, and every
active ant makes its *own* live LLM decision on the micro-markets the data opens up in real time —
"next corner," "next card," "goal in the next 10 minutes," "penalty scored or missed" — resolving
against the actual match timeline.

Around this sits a full consumer product: a Next.js frontend with a 3D colony you can watch feed,
grow, and take losses in; a shared public room per fixture plus invite-code private rooms for
playing with friends; Phantom wallet identity; and a **Sugar** economy we deliberately tuned on
eight real finished matches so that cautious, balanced, and aggressive play stay distinct but fair
rather than degenerate. That is why it fits *this* bounty specifically: it isn't a dashboard bolted
onto an odds API — it's a genuine fan experience where TxODDS's low-latency in-play data is the
heartbeat of the gameplay loop, verified end-to-end on live World Cup fixtures, on-chain from
subscription to settlement, and built to make a match more fun minute-by-minute for the people
watching it.

---

## 2. Business Highlights

- **New engagement surface for live sports data.** In-play events become a second-screen game, so
  a broadcaster or book can keep fans active during the parts of a match where nothing is on the
  scoreline yet.
- **Free-to-play, wallet-native, no gambling primitive.** Sugar is an in-game score, not a stake.
  Wallet login is a signature only — it never creates a transaction, never asks for payment, and
  never spends SOL — which keeps the experience broadly shippable.
- **Social by construction.** A single shared public room per fixture drives a global leaderboard,
  while six-digit invite codes create private friend lobbies — two distinct viral loops off the
  same match feed.
- **Provably fair settlement.** Every finished live match is validated against the TxLINE Solana
  Merkle root before its final state is persisted, so results are auditable rather than trust-me.
- **Tuned economy, not a guess.** Reward tables and market cadence were calibrated on 8 real
  finalized matches (~1,100 events each) so all three temperaments finish near their `20 Sugar`
  start on neutral play, and genuine predictive edge is still rewarded without runaway inflation.

---

## 3. Technical Highlights

### Architecture

```
Phantom wallet ──(sign-in signature)──▶ FastAPI backend ──▶ Supabase (rooms + journal)
                                            │
        TxLINE REST + SSE  ───────────────▶ │  normalize → market engine → per-ant LLM votes
        (fixtures, scores, live stream)     │              │
                                            │              └▶ SSE ──▶ Next.js web (3D colony, HUD)
        TxLINE stat proof ──▶ Solana        │
        validateStatV2 (read-only sim) ◀────┘  final-score validation before persist
```

- **Backend:** Python + **FastAPI**, `httpx` async client, Server-Sent Events for the live match
  stream and for pushing votes/predictions/settlements to the browser. Single-replica, one Uvicorn
  worker: active rooms, SSE workers, and TXLine live tasks are process-owned.
- **Frontend:** **Next.js / React / TypeScript**, with a **Three.js** underground 3D colony
  renderer (`web/public/dinasty/`), a match cockpit, lobby, admin console, and an intro sequence.
- **Persistence:** **Supabase** (`aoc_games` snapshots, `aoc_game_events` replay journal); the app
  degrades gracefully to in-memory state if Supabase is absent.
- **AI decision layer:** each active ant makes an individual **OpenRouter** LLM call
  (`per_ant` mode) carrying its personality, objective, and per-context memory, and returns a
  single discrete vote (`yes/no/abstain` or `option_a/b/c/abstain`). If the model is unavailable,
  the game raises an explicit error — there is deliberately **no** local policy fallback, so the
  AI is never silently faked. Token usage and cost are tracked per game.
- **On-chain:** Solana **mainnet**. The TxLINE oracle subscription is on-chain; final-match
  integrity is checked by fetching the V2 stat proof and running `validateStatV2` as a **read-only
  simulation** against the on-chain daily Merkle root (no transaction submitted, no SOL spent).
- **Deploy:** committed `Dockerfile` + `railway.toml` for a one-service Railway deploy.

### Game loop (per TXLine event)

```
TXLine event → normalize → is this a market moment?
   → open market (max 3 standard markets, ~1 new market / 5 match-minutes; penalty is immediate)
   → each active ant votes via its own LLM call
   → colony enters if top vote clears its temperament threshold (cautious 70% / balanced 60% / aggressive 51%)
   → reserve 2 Sugar → settle on the real event → win (+fixed reward) / loss (−2) / void (release)
```

### Economy (Sugar V0)

Every colony starts with **20 ants** and **20 Sugar**. Entering any market reserves exactly
**2 Sugar** regardless of how many ants back the call; a colony can hold at most 5 open positions
(10 Sugar reserved). A loss burns the 2 Sugar, a void releases it, a win releases it and adds a
fixed integer reward. There is no upkeep, starvation, or ant death in this version — Sugar is the
single resource and the score.

| Market result | Reward |
| --- | ---: |
| Penalty scored | `+1` |
| Penalty missed / saved | `+5` |
| Goal in next 10 min | `+4` |
| No goal in next 10 min | `+1` |
| Team scores next goal | `+4` |
| No goal before full time | `+1` |
| Team wins next corner | `+2` |
| Team wins next free kick | `+2` |
| Team gets next yellow card | `+3` |
| "No event before full time" outcomes | `+1` |

---

## 4. TxLINE Endpoints Used

All upstream calls are authenticated with **`Authorization: Bearer <TXLINE_JWT>`** *plus*
**`X-Api-Token: <TXLINE_API_TOKEN>`** against `https://txline.txodds.com`
(see `app/txline.py`).

| TXLine endpoint | Method | Purpose in Age of Colony |
| --- | --- | --- |
| `/api/fixtures/snapshot?startEpochDay=&competitionId=` | GET | Discover World Cup fixtures (upcoming, recent, and by day) for the lobby and admin replay list. |
| `/api/scores/snapshot/{fixtureId}` | GET | Latest per-action snapshot for a fixture. |
| `/api/scores/updates/{fixtureId}` | GET | Current 5-minute block of score updates for a match in progress. |
| `/api/scores/historical/{fixtureId}` | GET | Full event history for a fixture — powers replay mode and the normalized timeline. |
| `/api/scores/updates/{epochDay}/{hour}/{interval}` | GET | Historical updates for one specific 5-minute interval (debugging / backfill). |
| `/api/scores/stream` | GET (SSE) | **Live** in-play event stream — the real-time heartbeat that drives markets during a live match. |
| `/api/scores/stat-validation?fixtureId=&seq=&statKeys=` | GET | Fetches the V2 stat proof used for on-chain `validateStatV2` Merkle verification of the final score. |

**On-chain touchpoints (Solana mainnet):** the TxLINE oracle subscription (`subscribe()` + off-chain
token activation) grants feed access; `validateStatV2` is then run as a read-only simulation against
the on-chain daily Merkle root to prove the final match state before persistence.

> The backend also re-exposes this data through its own `/api/fixtures`, `/api/scores/...`, and
> `/api/live/events` routes for the web client; those are proxies over the seven upstream TXLine
> endpoints above.

---

## 5. Configuration Summary

Required environment (see `README.md` for the full list):

```bash
TXLINE_JWT=...            # TxLINE guest/API JWT
TXLINE_API_TOKEN=...      # TxLINE API token (X-Api-Token header)
OPENROUTER_API_KEY=...    # required to start a game (per-ant AI votes)
WALLET_SESSION_SECRET=... # >= 32 bytes in production
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Optional: `TXLINE_BASE_URL`, `TXLINE_COMPETITION_ID`, `TXLINE_SOLANA_RPC_URL`,
`OPENROUTER_MODEL`, and the `COLONY_AGENT_*` tuning knobs.

---

## 6. Repository Map

| Path | What it is |
| --- | --- |
| `app/main.py` | FastAPI app: fixtures/scores/live routes, room + colony + admin endpoints, SSE. |
| `app/txline.py` | TxLINE client (REST + SSE) and event normalization. |
| `app/txline_validation.py` | On-chain `validateStatV2` Merkle-proof verification. |
| `app/wallet_auth.py`, `app/queen_auth.py` | Phantom wallet sign-in and session cookies. |
| `app/persistence.py` | Supabase-backed room snapshots and replay journal. |
| `app/game/harness.py` | The market engine, colony/ant state, and Sugar settlement loop. |
| `app/game/agents.py` | Per-ant OpenRouter decision agent. |
| `web/` | Next.js frontend, including the Three.js 3D colony (`web/public/dinasty/`). |
| `tools/playtest_*.py`, `docs/sugar-v0-*.md` | Deterministic economy playtests and their reports. |
```

*Reproducible economy check (no network / no LLM):*
`python3 tools/playtest_sugar.py --runs 300 --policies all --seed 20260712`
