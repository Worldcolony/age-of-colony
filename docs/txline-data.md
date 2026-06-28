# Data Available Through TXLine

This app fetches the TXLine data needed to follow, replay, and analyze a match.

## Calendar

- Matches by date or upcoming window.
- Competition, fixture ID, teams, and kickoff time.
- Filters by competition or text search.

Endpoints:

- `GET /api/fixtures`
- `GET /api/fixtures/upcoming`

## Scores And Events

- Live score, history, and snapshots.
- Full action sequence for a fixture.
- Chronological event replay.
- Selected source: `historical`, `updates`, or `snapshot`.

Endpoints:

- `GET /api/scores/{fixture_id}/historical`
- `GET /api/scores/{fixture_id}/updates`
- `GET /api/scores/{fixture_id}/snapshot`
- `GET /api/scores/{fixture_id}/timeline`

## Match Actions

The API may expose:

- goals
- shots
- penalties
- free kicks
- corners
- throw-ins
- yellow / red cards
- VAR
- substitutions
- injuries
- added time
- discarded or amended actions

Each action can contain minute, team, possession, action type, outcome, confirmation, involved player, and raw TXLine details.

## Possession And Pressure

The app fetches possession changes and intensity levels provided by TXLine:

- `safe_possession`
- `attack_possession`
- `danger_possession`
- `high_danger_possession`

Important: TXLine does not provide precise ball `x/y` coordinates in the data used here.

## Players And Lineups

When TXLine provides them:

- starters
- substitutes
- numbers
- player names
- players in / out
- scorer or player linked to an action

## Match Context

Depending on the fixture, the app can also fetch:

- weather
- pitch condition
- venue type
- jersey colors
- match status
- clock
- kickoff
- TXLine coverage

## Stats

Available stats depend on the match and TXLine coverage. The app keeps raw fields and extracts the most useful ones:

- goals
- corners
- cards
- score by period when available
- `Stats`, `Parti1State`, `Parti2State`, `PossibleEvent`

## Raw Data And Export

To avoid losing data, the full endpoint returns:

- `rawRecords`: all raw TXLine records
- `timeline`: normalized events
- `details`: match summary
- `inventory`: available field inventory
- `latestState`: latest known state
- `sourceCounts`: volumes by source

Endpoint:

- `GET /api/scores/{fixture_id}/full?include_raw=true`

In the interface, the **Full data** block loads this package and exports it as JSON.
