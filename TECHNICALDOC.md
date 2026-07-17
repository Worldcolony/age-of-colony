# Age of Colony — Technical Documentation

*TxODDS × Superteam World Cup Hackathon — "Consumer & Fan Experiences" submission*

## Core Idea

**Age of Colony** turns TxODDS's live World Cup feed into a game you play *with*, not just watch.
We subscribe to the TXLine oracle on Solana and stream normalized match events — corners, cards,
subs, penalties, goals — into a live ant-colony simulation. Each fixture opens micro-markets in
real time ("next corner", "goal in the next 10 min", "penalty scored or missed"), and a colony of
AI ants — each with its own personality, memory, and risk appetite — votes on them via individual
LLM calls.

The twist: **the colony does the predicting; you're the gaffer.** You don't call the markets
yourself — you steer your ants' temperament, thresholds, and orders as the feed comes in, and let
them work. So playing against your friends is less about who's the sharpest tipster and more about
who best *orchestrates* their colony through the incoming data to collect the most **Sugar**.

## Business Highlights

- **A new engagement surface for live sports data** — in-play events become a second-screen game
  that keeps fans active even when the scoreline is quiet.
- **Free-to-play, wallet-native, no gambling primitive.** Sugar is a score, not a stake. Wallet
  login is a signature only — no transaction, no payment, no SOL spent.
- **Two viral loops off one feed:** a shared public room per fixture (global leaderboard) and
  six-digit invite codes for private friend lobbies.
- **Provably-fair settlement** — every finished live match is validated against the TxLINE Solana
  Merkle root before its final state is saved.
- **Tuned economy** — reward tables and market cadence were calibrated on 8 real finalized matches
  (~1,100 events each) so temperaments stay distinct but fair.

## Architecture

```
Phantom wallet ──(sign-in signature)──▶ FastAPI backend ──▶ Supabase (rooms + journal)
                                            │
   TxLINE REST + SSE ──────────────────────▶  normalize → market engine → per-ant LLM votes
   (fixtures, scores, live stream)          │        │
                                            │        └▶ SSE ──▶ Next.js web (3D colony, HUD)
   TxLINE stat proof ──▶ Solana             │
   validateStatV2 (read-only sim) ◀─────────┘  final-score validation before persist
```

- **Backend:** Python **FastAPI**, `httpx` async, Server-Sent Events for the live feed and the
  browser stream. Single replica (rooms and live tasks are process-owned).
- **Frontend:** **Next.js / React / TypeScript** with a **Three.js** 3D colony
  (`web/public/dinasty/`), match cockpit, lobby, and admin console.
- **AI layer:** each active ant makes its own **OpenRouter** call (`per_ant`) with its personality
  and memory, returning one discrete vote. No local fallback — if the model is down, the game
  errors rather than faking the AI.
- **On-chain:** Solana **mainnet**. Oracle access is an on-chain subscription; final-match
  integrity is checked by running `validateStatV2` as a read-only simulation against the on-chain
  daily Merkle root (no tx, no SOL spent).
- **Persistence:** **Supabase** (`aoc_games`, `aoc_game_events`), with graceful in-memory fallback.
- **Deploy:** committed `Dockerfile` + `railway.toml`.

## Game Loop

```
TXLine event → normalize → market moment?
  → open market (≤3 open, ~1 new / 5 match-min; penalty is immediate)
  → each active ant votes via its own LLM call
  → colony enters if the top vote clears its threshold (cautious 70% / balanced 60% / aggressive 51%)
  → reserve 2 Sugar → settle on the real event → win (+reward) / loss (−2) / void (release)
```

Every colony starts with **20 ants** and **20 Sugar**. Any entry reserves **2 Sugar** (max 5 open
positions); a win adds a fixed reward, a loss burns the 2, a void releases it. Sample rewards:
penalty scored `+1` / missed `+5`, goal in next 10 min `+4`, next corner `+2`, next yellow `+3`.

## TxLINE Endpoints Used

All calls authenticate with **`Authorization: Bearer <TXLINE_JWT>`** *plus*
**`X-Api-Token: <TXLINE_API_TOKEN>`** against `https://txline.txodds.com` (see `app/txline.py`).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/fixtures/snapshot?startEpochDay=&competitionId=` | Discover World Cup fixtures for the lobby and replay list. |
| `GET /api/scores/snapshot/{fixtureId}` | Latest per-action snapshot. |
| `GET /api/scores/updates/{fixtureId}` | Current 5-minute block of updates. |
| `GET /api/scores/historical/{fixtureId}` | Full event history (replay + timeline). |
| `GET /api/scores/updates/{epochDay}/{hour}/{interval}` | One historical 5-minute interval. |
| `GET /api/scores/stream` *(SSE)* | **Live** in-play event stream — the real-time heartbeat driving markets. |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKeys=` | V2 stat proof for on-chain `validateStatV2` verification. |

**On-chain (Solana mainnet):** the TxLINE oracle subscription grants feed access; `validateStatV2`
runs as a read-only Merkle check of the final score before persistence.

## Configuration

```bash
TXLINE_JWT=...            # TxLINE JWT
TXLINE_API_TOKEN=...      # X-Api-Token header
OPENROUTER_API_KEY=...    # required to start a game
WALLET_SESSION_SECRET=... # >= 32 bytes in production
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Optional: `TXLINE_BASE_URL`, `TXLINE_COMPETITION_ID`, `TXLINE_SOLANA_RPC_URL`, `OPENROUTER_MODEL`,
and the `COLONY_AGENT_*` tuning knobs. See `README.md` for the full list.

## Repository Map

| Path | What it is |
| --- | --- |
| `app/main.py` | FastAPI routes: fixtures/scores/live, rooms, colonies, admin, SSE. |
| `app/txline.py` | TxLINE client (REST + SSE) and event normalization. |
| `app/txline_validation.py` | On-chain `validateStatV2` Merkle verification. |
| `app/wallet_auth.py` | Phantom wallet sign-in and sessions. |
| `app/persistence.py` | Supabase room snapshots and replay journal. |
| `app/game/harness.py` | Market engine, colony/ant state, Sugar settlement. |
| `app/game/agents.py` | Per-ant OpenRouter decision agent. |
| `web/` | Next.js frontend + Three.js 3D colony (`web/public/dinasty/`). |

*Reproducible economy check (no network / no LLM):*
`python3 tools/playtest_sugar.py --runs 300 --policies all --seed 20260712`
