# Age of Colony - TXLine Match Monitor

Small Python/FastAPI app for reading TXLine fixtures and score data, following live matches, inspecting historical highlights, and running a first playable **Age of Colony** loop.

Age of Colony V0 lets players create a private room for a fixture, add colonies, then let ants automatically predict hot moments during a replay or live match. Each active ant gets its own personality and memory, then DeepSeek returns an individual vote. If the DeepSeek/OpenRouter agent is unavailable, the game stops with an explicit error; no local policy replaces AI ants.

See also: [available TXLine data](docs/txline-data.md).

## Configuration

Keep TXLine credentials in environment variables:

```bash
export TXLINE_JWT="..."
export TXLINE_API_TOKEN="..."
```

Optional:

```bash
export TXLINE_BASE_URL="https://txline.txodds.com"
export TXLINE_COMPETITION_ID="123"
```

OpenRouter colony agent:

```bash
export OPENROUTER_API_KEY="..."
export OPENROUTER_MODEL="openai/gpt-4o-mini"
export OPENROUTER_TIMEOUT_SECONDS="30"
export OPENROUTER_MAX_TOKENS="1200"
export OPENROUTER_MAX_RETRIES="2"
export OPENROUTER_RETRY_DELAY_SECONDS="0.5"
export OPENROUTER_INPUT_PRICE_PER_MILLION_USD="0.09"
export OPENROUTER_OUTPUT_PRICE_PER_MILLION_USD="0.18"
export COLONY_AGENT_MODE="auto"
export COLONY_AGENT_CALL_MODE="per_ant"
export COLONY_AGENT_MAX_CALLS_PER_GAME="20000"
export COLONY_AGENT_MAX_PARALLEL_ANT_CALLS="12"
export COLONY_AGENT_ANT_BATCH_SIZE="50"
```

`OPENROUTER_API_KEY` is required to start a game. In `per_ant` mode, each AI ant makes its own OpenRouter call with its personality, objective, and memory. The active agent output is intentionally discrete: each ant only votes `yes`, `no`, or `abstain` on the open market, without confidence scores. Concrete paid info types are reserved for a later iteration.

`COLONY_AGENT_MAX_PARALLEL_ANT_CALLS` controls how many ant calls can run at the same time. `OPENROUTER_MAX_RETRIES` retries transient DeepSeek/OpenRouter failures and malformed ant JSON, but it never replaces a vote with a local policy. `COLONY_AGENT_ANT_BATCH_SIZE` is only used when `COLONY_AGENT_CALL_MODE=batch` is selected for faster replay debugging. At the end of a run, the journal shows AI cost calculated from OpenRouter `usage` tokens and `OPENROUTER_INPUT_PRICE_PER_MILLION_USD` / `OPENROUTER_OUTPUT_PRICE_PER_MILLION_USD`.

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Then open http://127.0.0.1:8000.

## Useful Endpoints

- `GET /api/fixtures`: TXLine fixtures with `date`, `start_epoch_day`, `competition_id`, and `search` filters
- `GET /api/fixtures/upcoming`: upcoming matches with `date`, `days`, `limit`, `competition_id`, and `search` filters
- `GET /api/scores/{fixture_id}/snapshot`: latest action snapshots
- `GET /api/scores/{fixture_id}/updates`: current 5-minute block updates
- `GET /api/scores/{fixture_id}/historical`: full fixture history
- `GET /api/scores/{fixture_id}/timeline?source=historical&include_possession=true`: normalized timeline with highlights and possession changes
- `GET /api/scores/{fixture_id}/details`: extracted match info, lineups, context, and stats
- `GET /api/scores/{fixture_id}/full?include_raw=true`: full package with raw TXLine records, timeline, inventory, and latest known state
- `GET /api/scores/interval?date=YYYY-MM-DD&hour=12&interval=0`: historical updates for one 5-minute interval
- `GET /api/live/events`: SSE proxy for the live TXLine score stream

## Age of Colony Endpoints

- `POST /api/games`: create a room for a fixture
- `POST /api/games/{game_id}/colonies`: add a colony with size, style, favorite ground, and info need
- `POST /api/games/{game_id}/start`: start the game in `replay` or `live` mode
- `POST /api/games/{game_id}/rerun`: clone the room and rerun the replay with the same colonies
- `GET /api/games/{game_id}`: current room state
- `GET /api/games/{game_id}/events`: SSE stream of votes, predictions, settlements, and leaderboard updates
- `GET /api/games/{game_id}/replay`: full journal for debugging and replayability
- `GET /api/fixtures/recent`: recent completed fixtures, filterable by competition/search
- `POST /api/games/run-previous`: find the latest completed fixture with TXLine data and run Age of Colony on it
- `GET /api/demo/matches`: list demo matches available without TXLine credentials
- `POST /api/demo/run`: run a full demo match with three colonies

The V0 decision loop:

```text
TXLine event
-> V0 opportunity
-> clear yes/no market
-> individual yes/no/abstain ant votes via DeepSeek/OpenRouter
-> explicit error if DeepSeek/OpenRouter is unavailable
-> ant commitment
-> settlement + food/larvae/losses/memory
```

V0 markets exposed to agents:

- pressure event: `{involved team} scores in the next 5 minutes?`
- penalty: `is the penalty scored?`
- each ant votes `yes`, `no`, or `abstain`
- concrete paid info is disabled for now

V0 colony resources:

- alive ants
- wounded ants
- food
- larvae

Starting configuration:

- size: `10`, `20`, `50`
- dominant style: `cautious`, `balanced`, `aggressive`
- favorite ground: `penalties`, `corners`, `momentum`, `chaos`, `balanced`
- info need: `low`, `medium`, `high`

In the interface:

- **Run previous TX** finds a real completed TXLine match with score/historical/updates/snapshot data and runs Age of Colony on it. If `TXLINE_COMPETITION_ID` targets the World Cup, the button stays inside that scope.
- **Run local demo** runs a fictional but normalized match, useful for testing the game loop without TXLine credentials, but still with DeepSeek/OpenRouter required.
- **Run match** starts the active room simulation in the background; the journal fills while the replay runs.
- **Rerun sim** creates a new room with the same colonies and restarts the replay.
