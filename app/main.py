import asyncio
import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import os

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .game import GameManager
from .game.agents import OpenRouterColonyAgent, OpenRouterSettings
from .game.demo import demo_events, demo_fixtures
from .game.harness import GameRoom, PlayerState
from .persistence import SupabaseGameStore, SupabasePersistenceError
from .txline import (
    TxLineClient,
    TxLineConfigError,
    TxLineSettings,
    annotate_possession_changes,
    build_full_match_data,
    build_match_details,
    build_timeline,
    epoch_day_from_date,
    filter_upcoming_fixtures,
    normalize_fixtures,
    normalize_score_record,
    parse_date_to_epoch_day,
)


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Age of Colony TXLine Monitor", version="0.1.0")

# CORS — allow the standalone Next.js frontend (separate origin) to call the API.
# Set WEB_ORIGINS to a comma-separated allowlist in production; defaults to "*" for dev.
_web_origins = os.getenv("WEB_ORIGINS", "*")
_allow_origins = ["*"] if _web_origins.strip() == "*" else [o.strip() for o in _web_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
game_manager = GameManager(decision_agent=OpenRouterColonyAgent.from_env())
supabase_store = SupabaseGameStore()

AUTORUN_COLONIES = (
    ("Red Nest", 10, "cautious", "penalties", "high"),
    ("Amber Swarm", 20, "balanced", "momentum", "medium"),
    ("Black Rush", 50, "aggressive", "chaos", "low"),
)


class CreateGameRequest(BaseModel):
    fixtureId: int | str
    participant1: str | None = None
    participant2: str | None = None
    seed: int | None = None
    anonymousId: str | None = None
    creatorName: str | None = None


class CreateColonyRequest(BaseModel):
    name: str
    size: int
    style: str
    favoriteContext: str
    infoNeed: str


class JoinRoomRequest(BaseModel):
    name: str
    anonymousId: str | None = None


class UpdateColonyStrategyRequest(BaseModel):
    style: str | None = None
    favoriteContext: str | None = None
    infoNeed: str | None = None


class StartGameRequest(BaseModel):
    mode: str = "replay"
    source: str = "historical"


class DemoRunRequest(BaseModel):
    seed: int | None = None


class RunPreviousTxRequest(BaseModel):
    days: int = 14
    limit: int = 40
    competitionId: int | None = None
    search: str | None = None
    seed: int | None = None


@app.exception_handler(TxLineConfigError)
async def txline_config_error_handler(_: Request, exc: TxLineConfigError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "detail": str(exc),
            "hint": "Configure TXLINE_JWT and TXLINE_API_TOKEN before calling TXLine endpoints.",
        },
    )


@app.exception_handler(httpx.HTTPStatusError)
async def txline_status_error_handler(_: Request, exc: httpx.HTTPStatusError) -> JSONResponse:
    response = exc.response
    detail: Any
    try:
        detail = response.json()
    except ValueError:
        detail = response.text
    return JSONResponse(
        status_code=response.status_code,
        content={"detail": detail, "upstream_status": response.status_code},
    )


@app.exception_handler(SupabasePersistenceError)
async def supabase_persistence_error_handler(_: Request, exc: SupabasePersistenceError) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={
            "detail": str(exc),
            "hint": "Run supabase/aoc_bootstrap.sql and configure SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY.",
        },
    )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    settings = TxLineSettings.from_env()
    agent_settings = OpenRouterSettings.from_env()
    return {
        "ok": True,
        "txlineConfigured": settings.configured,
        "baseUrl": settings.base_url,
        "defaultCompetitionId": settings.default_competition_id,
        "openrouterConfigured": agent_settings.configured,
        "colonyAgentMode": agent_settings.mode,
        "colonyAgentModel": agent_settings.model if agent_settings.configured else None,
        "colonyAgentMaxCallsPerGame": agent_settings.max_calls_per_game,
        "colonyAgentCallMode": agent_settings.call_mode,
        "colonyAgentAntBatchSize": agent_settings.ant_batch_size,
        "colonyAgentMaxParallelAntCalls": agent_settings.max_parallel_ant_calls,
        "colonyAgentMaxRetries": agent_settings.max_retries,
        "colonyAgentRetryDelaySeconds": agent_settings.retry_delay_seconds,
        "colonyAgentPricing": {
            "inputPerMillionUsd": agent_settings.input_price_per_million_usd,
            "outputPerMillionUsd": agent_settings.output_price_per_million_usd,
        },
        "supabase": supabase_store.public_status(),
    }


@app.post("/api/games")
async def create_game(payload: CreateGameRequest) -> dict[str, Any]:
    room = game_manager.create_room(
        fixture_id=payload.fixtureId,
        participant1=payload.participant1,
        participant2=payload.participant2,
        seed=payload.seed,
        owner_anonymous_id=payload.anonymousId,
        owner_name=payload.creatorName,
    )
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/colonies")
async def create_colony(game_id: str, payload: CreateColonyRequest) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    try:
        game_manager.harness(game_id).add_colony(
            name=payload.name,
            size=payload.size,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/players")
async def join_game_room(game_id: str, payload: JoinRoomRequest) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    game_manager.harness(game_id).join_player(payload.name, anonymous_id=payload.anonymousId)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.patch("/api/games/{game_id}/colonies/{colony_id}/strategy")
async def update_colony_strategy(game_id: str, colony_id: str, payload: UpdateColonyStrategyRequest) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    try:
        game_manager.harness(game_id).update_colony_strategy(
            colony_id,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/start")
async def start_game(game_id: str, payload: StartGameRequest) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    _ensure_deepseek_agent()
    mode = payload.mode.strip().casefold()
    if mode not in {"replay", "live"}:
        raise HTTPException(status_code=422, detail="mode must be replay or live")
    if not room.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before starting the match.")
    if room.status in {"running_replay", "running_live"}:
        raise HTTPException(status_code=409, detail="The game is already running.")

    room.mode = mode
    if mode == "replay":
        return await _start_replay_room(room, payload)

    if game_id not in game_manager.live_tasks:
        game_manager.live_tasks[game_id] = asyncio.create_task(_run_live_game(game_id))
    room.status = "running_live"
    room.add_log("game_started", "Live game connected to the TXLine stream.", {"mode": "live"})
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/rerun")
async def rerun_game(game_id: str, payload: StartGameRequest) -> dict[str, Any]:
    _ensure_deepseek_agent()
    old_room = _get_game_or_404(game_id)
    if old_room.status in {"running_replay", "running_live"}:
        raise HTTPException(status_code=409, detail="Wait for the simulation to finish before rerunning.")
    if not old_room.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before rerunning.")
    if payload.mode.strip().casefold() != "replay":
        raise HTTPException(status_code=422, detail="Rerun supports replay mode only.")

    room = game_manager.create_room(
        fixture_id=old_room.fixture_id,
        participant1=old_room.participant1,
        participant2=old_room.participant2,
        seed=old_room.seed,
        owner_anonymous_id=old_room.owner_anonymous_id,
        owner_name=old_room.owner_name,
    )
    harness = game_manager.harness(room.game_id)
    for player in old_room.players:
        harness.join_player(player.name, anonymous_id=player.anonymous_id)
    for colony in old_room.colonies.values():
        harness.add_colony(
            colony.name,
            colony.size,
            colony.style,
            colony.favorite_context,
            colony.info_need,
        )
    room.mode = "replay"
    return await _start_replay_room(room, payload)


@app.get("/api/fixtures/recent")
async def recent_fixtures(
    days: int = Query(default=14, ge=1, le=90),
    limit: int = Query(default=50, ge=1, le=200),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    fixtures = await _recent_past_fixtures(client, days=days, limit=limit, competition_id=competition_id, search=search)
    return {"mode": "recent", "days": days, "limit": limit, "count": len(fixtures), "fixtures": fixtures}


@app.post("/api/games/run-previous")
async def run_previous_tx_game(payload: RunPreviousTxRequest) -> dict[str, Any]:
    _ensure_deepseek_agent()
    client = TxLineClient()
    fixtures = await _recent_past_fixtures(
        client,
        days=max(1, min(payload.days, 90)),
        limit=max(1, min(payload.limit, 200)),
        competition_id=payload.competitionId,
        search=payload.search,
    )
    if not fixtures:
        raise HTTPException(status_code=404, detail="No previous TXLine fixtures found for this search/window.")

    inspected: list[dict[str, Any]] = []
    for fixture in fixtures:
        fixture_id = fixture.get("fixtureId")
        if fixture_id is None:
            continue
        try:
            source_records = await _fetch_score_sources(client, int(fixture_id))
        except (TypeError, ValueError):
            continue
        chosen_source, records = _choose_best_source(source_records)
        inspected.append(
            {
                "fixtureId": fixture_id,
                "sourceCounts": {name: len(items) for name, items in source_records.items()},
            }
        )
        if not records:
            continue

        room = game_manager.create_room(
            fixture_id=fixture_id,
            participant1=fixture.get("participant1"),
            participant2=fixture.get("participant2"),
            seed=payload.seed,
        )
        harness = game_manager.harness(room.game_id)
        _add_autorun_colonies(harness)
        room.mode = "replay"
        timeline = build_timeline(
            records,
            fixture={
                "fixtureId": fixture_id,
                "participant1": fixture.get("participant1"),
                "participant2": fixture.get("participant2"),
            },
            important_only=False,
            include_possession_changes=True,
            limit=None,
        )
        room.add_log(
            "game_started",
            f"TXLine replay started on {fixture.get('participant1') or 'Participant 1'} - {fixture.get('participant2') or 'Participant 2'} with {len(timeline['events'])} events.",
            {
                "mode": "replay",
                "source": chosen_source,
                "rawCount": timeline["rawCount"],
                "fixture": fixture,
                "sourceCounts": {name: len(items) for name, items in source_records.items()},
            },
        )
        harness.process_events(timeline["events"])
        await _sync_room_to_supabase_async(room)
        return room.public_state()

    raise HTTPException(
        status_code=404,
        detail={
            "message": "Previous TXLine fixtures were found, but none had score data in historical/updates/snapshot.",
            "inspected": inspected,
        },
    )


@app.get("/api/demo/matches")
async def demo_matches() -> dict[str, Any]:
    fixtures = demo_fixtures()
    return {"count": len(fixtures), "fixtures": fixtures}


@app.post("/api/demo/run")
async def demo_run(payload: DemoRunRequest) -> dict[str, Any]:
    _ensure_deepseek_agent()
    fixture = demo_fixtures()[0]
    room = game_manager.create_room(
        fixture_id=fixture["fixtureId"],
        participant1=fixture["participant1"],
        participant2=fixture["participant2"],
        seed=payload.seed,
    )
    harness = game_manager.harness(room.game_id)
    _add_autorun_colonies(harness)
    room.mode = "replay"
    events = demo_events(room.fixture_id)
    room.add_log(
        "game_started",
        f"Demo run started on {fixture['participant1']} - {fixture['participant2']} with {len(events)} events.",
        {"mode": "replay", "source": "demo", "rawCount": len(events)},
    )
    harness.process_events(events)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.get("/api/admin/games")
async def admin_games(limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    if not supabase_store.configured:
        games = [room.public_state() for room in game_manager.rooms.values()]
        games.sort(key=lambda item: item.get("eventIndex", 0), reverse=True)
        return {
            "source": "memory",
            "configured": False,
            "count": len(games[:limit]),
            "games": games[:limit],
            "hint": "Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist admin games.",
        }
    return await asyncio.to_thread(supabase_store.list_games, limit=limit)


@app.get("/api/games/active")
async def active_game(fixture_id: str = Query(...)) -> dict[str, Any]:
    room = _latest_memory_room_for_fixture(fixture_id)
    if room:
        return {"source": "memory", "game": room.public_state()}
    stored = await _latest_stored_game_for_fixture(fixture_id)
    if stored:
        restored = _restore_room_from_stored_row(stored)
        return {"source": "supabase", "game": restored.public_state()}
    return {"source": "none", "game": None}


@app.get("/api/games/{game_id}")
async def game_state(game_id: str) -> dict[str, Any]:
    room = game_manager.get_room(game_id)
    if room:
        return room.public_state()
    replay = await _stored_replay_or_none(game_id)
    if replay:
        return replay["game"]
    raise HTTPException(status_code=404, detail="Game not found.")


@app.get("/api/games/{game_id}/replay")
async def game_replay(game_id: str) -> dict[str, Any]:
    room = game_manager.get_room(game_id)
    if not room:
        replay = await _stored_replay_or_none(game_id)
        if replay:
            return replay
        raise HTTPException(status_code=404, detail="Game not found.")
    return {
        "game": room.public_state(),
        "events": [event.public_state() for event in room.log],
    }


@app.get("/api/games/{game_id}/events")
async def game_events(game_id: str) -> StreamingResponse:
    room = _get_game_or_404(game_id)

    async def generate() -> AsyncIterator[str]:
        cursor = 0
        try:
            while True:
                while cursor < len(room.log):
                    event = room.log[cursor]
                    cursor += 1
                    yield _sse("game_event", event.public_state(), event_id=str(event.index))
                yield _sse("game_state", room.public_state())
                await asyncio.sleep(0.75)
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/fixtures")
async def fixtures(
    date_: date | None = Query(default=None, alias="date"),
    start_epoch_day: int | None = Query(default=None),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    if date_ is not None:
        start_epoch_day = epoch_day_from_date(date_)
    client = TxLineClient()
    raw = await client.fixture_snapshot(start_epoch_day=start_epoch_day, competition_id=competition_id)
    normalized = normalize_fixtures(raw, search=search)
    return {"count": len(normalized), "fixtures": normalized}


@app.get("/api/fixtures/upcoming")
async def upcoming_fixtures(
    date_: date | None = Query(default=None, alias="date"),
    days: int = Query(default=14, ge=1, le=90),
    limit: int = Query(default=100, ge=1, le=500),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    start_date = date_ or datetime.now(timezone.utc).date()
    start_datetime = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
    now = max(datetime.now(timezone.utc), start_datetime)
    until = start_datetime + timedelta(days=days)
    client = TxLineClient()
    raw = await client.fixture_snapshot(
        start_epoch_day=epoch_day_from_date(start_date),
        competition_id=competition_id,
    )
    normalized = normalize_fixtures(raw, search=search)
    upcoming = filter_upcoming_fixtures(normalized, now=now, until=until, limit=limit)
    return {
        "mode": "upcoming",
        "fromDate": start_date.isoformat(),
        "days": days,
        "limit": limit,
        "count": len(upcoming),
        "fixtures": upcoming,
    }


@app.get("/api/fixtures/live-target")
async def live_target_fixture(
    days: int = Query(default=14, ge=1, le=90),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    now = datetime.now(timezone.utc)
    fixtures = await _live_target_candidates(client, now=now, days=days, competition_id=competition_id, search=search)
    target, target_kind = _pick_live_target_fixture(fixtures, now=now)
    return {
        "mode": "live_target",
        "status": target_kind or "empty",
        "count": 1 if target else 0,
        "candidateCount": len(fixtures),
        "fixture": target,
        "fixtures": [target] if target else [],
    }


@app.get("/api/scores/{fixture_id}/snapshot")
async def score_snapshot(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_snapshot(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/updates")
async def score_updates(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_updates(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/historical")
async def score_historical(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_historical(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/timeline")
async def score_timeline(
    fixture_id: int,
    source: str = Query(default="historical", pattern="^(historical|snapshot|updates)$"),
    important_only: bool = Query(default=True),
    include_possession: bool = Query(default=True),
    limit: int = Query(default=300, ge=1, le=2000),
    participant1: str | None = Query(default=None),
    participant2: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    if source == "snapshot":
        records = await client.score_snapshot(fixture_id)
        resolved_source = "snapshot"
    elif source == "updates":
        records = await client.score_updates(fixture_id)
        resolved_source = "updates"
    else:
        records = await client.score_historical(fixture_id)
        resolved_source = "historical"
        if not records:
            records = await client.score_updates(fixture_id)
            resolved_source = "updates"
        if not records:
            records = await client.score_snapshot(fixture_id)
            resolved_source = "snapshot"

    fixture = {
        "fixtureId": fixture_id,
        "participant1": participant1,
        "participant2": participant2,
    }
    timeline = build_timeline(
        records,
        fixture=fixture,
        important_only=important_only,
        include_possession_changes=include_possession,
        limit=limit,
    )
    timeline["source"] = source
    timeline["resolvedSource"] = resolved_source
    timeline["includePossession"] = include_possession
    return timeline


@app.get("/api/scores/{fixture_id}/details")
async def score_details(
    fixture_id: int,
    participant1: str | None = Query(default=None),
    participant2: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_historical(fixture_id)
    resolved_source = "historical"
    if not records:
        records = await client.score_updates(fixture_id)
        resolved_source = "updates"
    if not records:
        records = await client.score_snapshot(fixture_id)
        resolved_source = "snapshot"

    fixture = {
        "fixtureId": fixture_id,
        "participant1": participant1,
        "participant2": participant2,
    }
    details = build_match_details(records, fixture=fixture)
    details["source"] = resolved_source
    return details


@app.get("/api/scores/{fixture_id}/full")
async def score_full(
    fixture_id: int,
    include_raw: bool = Query(default=True),
    include_source_records: bool = Query(default=False),
    participant1: str | None = Query(default=None),
    participant2: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    source_records = await _fetch_score_sources(client, fixture_id)
    chosen_source, records = _choose_best_source(source_records)
    fixture = {
        "fixtureId": fixture_id,
        "participant1": participant1,
        "participant2": participant2,
    }
    data = build_full_match_data(records, fixture=fixture, include_raw=include_raw)
    data["source"] = chosen_source
    data["sourceCounts"] = {name: len(items) for name, items in source_records.items()}
    if include_source_records:
        data["sourceRecords"] = source_records
    return data


@app.get("/api/scores/interval")
async def score_interval(
    epoch_day: int | None = Query(default=None),
    date_: str | None = Query(default=None, alias="date"),
    hour: int = Query(ge=0, le=23),
    interval: int = Query(ge=0, le=11),
    important_only: bool = Query(default=True),
    include_possession: bool = Query(default=True),
    limit: int = Query(default=300, ge=1, le=2000),
) -> dict[str, Any]:
    if epoch_day is None:
        if not date_:
            raise HTTPException(status_code=422, detail="Provide either epoch_day or date=YYYY-MM-DD.")
        epoch_day = parse_date_to_epoch_day(date_)

    client = TxLineClient()
    records = await client.score_interval(epoch_day, hour, interval)
    timeline = build_timeline(
        records,
        important_only=important_only,
        include_possession_changes=include_possession,
        limit=limit,
    )
    timeline.update({"epochDay": epoch_day, "hour": hour, "interval": interval, "includePossession": include_possession})
    return timeline


@app.get("/api/live/events")
async def live_events(
    fixture_id: int | None = Query(default=None),
    important_only: bool = Query(default=False),
    include_possession: bool = Query(default=True),
) -> StreamingResponse:
    async def generate() -> AsyncIterator[str]:
        client = TxLineClient()
        possession_state: dict[Any, dict[str, Any]] = {}
        try:
            async for event in client.stream_score_events():
                event_name = event.get("event") or "score"
                if event_name == "heartbeat":
                    yield _sse("heartbeat", event.get("data") or {})
                    continue

                data = event.get("data")
                if not isinstance(data, dict):
                    yield _sse("raw", event)
                    continue

                normalized = normalize_score_record(data)
                if include_possession:
                    annotate_possession_changes([normalized], possession_state)
                if fixture_id is not None and str(normalized.get("fixtureId")) != str(fixture_id):
                    continue
                if important_only and not normalized["isHighlight"]:
                    continue

                yield _sse("score", normalized, event_id=event.get("id"))
        except TxLineConfigError as exc:
            yield _sse("txline_error", {"detail": str(exc)})
        except httpx.HTTPStatusError as exc:
            yield _sse("txline_error", {"detail": "TXLine stream refused the request.", "status": exc.response.status_code})
        except asyncio.CancelledError:
            return
        except Exception as exc:  # Keeps EventSource clients informed instead of silently closing.
            yield _sse("txline_error", {"detail": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _fetch_score_sources(client: TxLineClient, fixture_id: int) -> dict[str, list[dict[str, Any]]]:
    historical, updates, snapshot = await asyncio.gather(
        client.score_historical(fixture_id),
        client.score_updates(fixture_id),
        client.score_snapshot(fixture_id),
    )
    return {
        "historical": historical,
        "updates": updates,
        "snapshot": snapshot,
    }


def _choose_best_source(source_records: dict[str, list[dict[str, Any]]]) -> tuple[str, list[dict[str, Any]]]:
    for source in ("historical", "updates", "snapshot"):
        records = source_records.get(source) or []
        if records:
            return source, records
    return "historical", []


async def _recent_past_fixtures(
    client: TxLineClient,
    *,
    days: int,
    limit: int,
    competition_id: int | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    today = datetime.now(timezone.utc).date()
    now_ts = datetime.now(timezone.utc).timestamp()
    fixtures: list[dict[str, Any]] = []
    seen: set[Any] = set()

    for offset in range(days):
        day = today - timedelta(days=offset)
        raw = await client.fixture_snapshot(
            start_epoch_day=epoch_day_from_date(day),
            competition_id=competition_id,
        )
        normalized = normalize_fixtures(raw, search=search)
        for fixture in normalized:
            fixture_id = fixture.get("fixtureId")
            key = fixture_id if fixture_id is not None else (fixture.get("participant1"), fixture.get("participant2"), fixture.get("startTime"))
            if key in seen:
                continue
            seen.add(key)
            start_ts = _fixture_start_timestamp(fixture)
            if start_ts is None or start_ts >= now_ts:
                continue
            fixtures.append(fixture)
        if len(fixtures) >= limit:
            break

    fixtures.sort(key=lambda item: (_fixture_start_timestamp(item) or 0, str(item.get("fixtureId") or "")), reverse=True)
    return fixtures[:limit]


async def _live_target_candidates(
    client: TxLineClient,
    *,
    now: datetime,
    days: int,
    competition_id: int | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []
    seen: set[Any] = set()
    start_day = now.date() - timedelta(days=1)

    for offset in range(days + 1):
        day = start_day + timedelta(days=offset)
        raw = await client.fixture_snapshot(
            start_epoch_day=epoch_day_from_date(day),
            competition_id=competition_id,
        )
        normalized = normalize_fixtures(raw, search=search)
        for fixture in normalized:
            fixture_id = fixture.get("fixtureId")
            key = fixture_id if fixture_id is not None else (fixture.get("participant1"), fixture.get("participant2"), fixture.get("startTime"))
            if key in seen:
                continue
            seen.add(key)
            if _fixture_start_timestamp(fixture) is None:
                continue
            fixtures.append(fixture)

    fixtures.sort(key=lambda item: (_fixture_start_timestamp(item) or float("inf"), str(item.get("fixtureId") or "")))
    return fixtures


def _pick_live_target_fixture(
    fixtures: list[dict[str, Any]],
    *,
    now: datetime,
    live_window: timedelta = timedelta(minutes=150),
) -> tuple[dict[str, Any] | None, str | None]:
    now_ts = now.timestamp()
    live_window_seconds = live_window.total_seconds()
    current: list[dict[str, Any]] = []
    upcoming: list[dict[str, Any]] = []

    for fixture in fixtures:
        start_ts = _fixture_start_timestamp(fixture)
        if start_ts is None:
            continue
        if start_ts <= now_ts <= start_ts + live_window_seconds:
            current.append(fixture)
        elif start_ts > now_ts:
            upcoming.append(fixture)

    if current:
        current.sort(key=lambda item: (_fixture_start_timestamp(item) or 0, str(item.get("fixtureId") or "")), reverse=True)
        return current[0], "current"
    if upcoming:
        upcoming.sort(key=lambda item: (_fixture_start_timestamp(item) or float("inf"), str(item.get("fixtureId") or "")))
        return upcoming[0], "next"
    return None, None


def _fixture_start_timestamp(fixture: dict[str, Any]) -> float | None:
    value = fixture.get("startTime")
    if value is None:
        return None
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return None
    if timestamp > 10_000_000_000:
        timestamp /= 1000
    return timestamp


def _latest_memory_room_for_fixture(fixture_id: str | int):
    active_rooms = [
        room
        for room in game_manager.rooms.values()
        if str(room.fixture_id) == str(fixture_id) and room.status not in {"finished", "error", "stopped"}
    ]
    if not active_rooms:
        return None
    active_rooms.sort(key=lambda room: room.log[-1].created_at if room.log else 0, reverse=True)
    return active_rooms[0]


async def _latest_stored_game_for_fixture(fixture_id: str | int) -> dict[str, Any] | None:
    if not supabase_store.configured:
        return None
    return await asyncio.to_thread(supabase_store.latest_game_for_fixture, fixture_id)


def _get_game_or_404(game_id: str):
    room = game_manager.get_room(game_id)
    if not room:
        raise HTTPException(status_code=404, detail="Game not found.")
    return room


async def _get_game_or_restore_404(game_id: str):
    room = game_manager.get_room(game_id)
    if room:
        return room
    replay = await _stored_replay_or_none(game_id)
    if replay:
        stored_row = (replay.get("stored") or {}).get("game") or {}
        return _restore_room_from_stored_row({**stored_row, "public_state": replay.get("game") or stored_row.get("public_state")})
    raise HTTPException(status_code=404, detail="Game not found.")


def _restore_room_from_stored_row(row: dict[str, Any]):
    public_state = row.get("public_state") or row
    game_id = public_state.get("gameId") or row.get("game_id")
    if not game_id:
        raise HTTPException(status_code=404, detail="Game not found.")
    existing = game_manager.get_room(str(game_id))
    if existing:
        return existing

    owner = public_state.get("owner") or {}
    seed = row.get("seed")
    try:
        clean_seed = int(seed) if seed is not None else 7
    except (TypeError, ValueError):
        clean_seed = 7

    room = GameRoom(
        game_id=str(game_id),
        fixture_id=public_state.get("fixtureId") or row.get("fixture_id"),
        participant1=public_state.get("participant1") or row.get("participant1"),
        participant2=public_state.get("participant2") or row.get("participant2"),
        owner_anonymous_id=owner.get("anonymousId") if isinstance(owner, dict) else None,
        owner_name=owner.get("name") if isinstance(owner, dict) else None,
        seed=clean_seed,
    )
    room.status = public_state.get("status") or row.get("status") or "created"
    room.mode = public_state.get("mode") or row.get("mode")
    room.event_index = int(public_state.get("eventIndex") or row.get("event_index") or 0)
    for player in public_state.get("players") or []:
        if not isinstance(player, dict):
            continue
        room.players.append(
            PlayerState(
                player_id=str(player.get("playerId") or f"player_{len(room.players) + 1}"),
                name=str(player.get("name") or f"Player {len(room.players) + 1}")[:32],
                anonymous_id=str(player.get("anonymousId"))[:80] if player.get("anonymousId") else None,
            )
        )
    game_manager.rooms[room.game_id] = room
    return room


def _add_autorun_colonies(harness: Any) -> None:
    for name, size, style, favorite_context, info_need in AUTORUN_COLONIES:
        harness.add_colony(name, size, style, favorite_context, info_need)


def _ensure_deepseek_agent() -> None:
    if not callable(getattr(game_manager.decision_agent, "decide_ants", None)):
        raise HTTPException(
            status_code=503,
            detail="DeepSeek/OpenRouter agent required. Configure OPENROUTER_API_KEY and keep COLONY_AGENT_MODE enabled.",
        )


async def _start_replay_room(room, payload: StartGameRequest) -> dict[str, Any]:
    if payload.source == "demo":
        events = demo_events(room.fixture_id)
        if not events:
            raise HTTPException(status_code=422, detail="No demo replay is available for this fixture.")
        room.add_log(
            "game_started",
            f"Demo replay started with {len(events)} normalized events.",
            {"mode": "replay", "source": "demo", "rawCount": len(events)},
        )
        room.status = "running_replay"
        game_manager.replay_tasks[room.game_id] = asyncio.create_task(_run_replay_game(room.game_id, events))
        await _sync_room_to_supabase_async(room)
        return room.public_state()

    try:
        fixture_id = int(room.fixture_id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Replay mode requires a numeric fixture id.") from exc
    client = TxLineClient()
    source_records = await _fetch_score_sources(client, fixture_id)
    if payload.source not in source_records:
        raise HTTPException(status_code=422, detail="source must be historical, updates or snapshot")
    records = source_records[payload.source] or _choose_best_source(source_records)[1]
    timeline = build_timeline(
        records,
        fixture={
            "fixtureId": room.fixture_id,
            "participant1": room.participant1,
            "participant2": room.participant2,
        },
        important_only=False,
        include_possession_changes=True,
        limit=None,
    )
    if not timeline["events"]:
        raise HTTPException(
            status_code=422,
            detail="No TXLine replay event for this match. Use a completed match, Run Previous TX, or Live mode when the match starts.",
        )
    room.add_log(
        "game_started",
        f"Replay started with {len(timeline['events'])} normalized events.",
        {"mode": "replay", "source": payload.source, "rawCount": timeline["rawCount"]},
    )
    room.status = "running_replay"
    game_manager.replay_tasks[room.game_id] = asyncio.create_task(_run_replay_game(room.game_id, timeline["events"]))
    await _sync_room_to_supabase_async(room)
    return room.public_state()


async def _run_replay_game(game_id: str, events: list[dict[str, Any]]) -> None:
    room = game_manager.get_room(game_id)
    if not room:
        return
    try:
        await asyncio.to_thread(game_manager.harness(game_id).process_events, events)
    except asyncio.CancelledError:
        room.status = "stopped"
        raise
    except Exception as exc:
        _sync_room_agent_usage(game_id)
        room.status = "error"
        room.add_log("game_error", f"Replay interrupted: {exc}", _error_log_data(exc))
    finally:
        await _sync_room_to_supabase_async(room)
        game_manager.replay_tasks.pop(game_id, None)


async def _run_live_game(game_id: str) -> None:
    room = game_manager.get_room(game_id)
    if not room:
        return
    client = TxLineClient()
    possession_state: dict[Any, dict[str, Any]] = {}
    harness = game_manager.harness(game_id)
    fixture = {
        "fixtureId": room.fixture_id,
        "participant1": room.participant1,
        "participant2": room.participant2,
    }
    try:
        async for event in client.stream_score_events():
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            normalized = normalize_score_record(data, fixture=fixture)
            annotate_possession_changes([normalized], possession_state)
            if str(normalized.get("fixtureId")) != str(room.fixture_id):
                continue
            harness.process_event(normalized)
    except asyncio.CancelledError:
        room.status = "stopped"
    except Exception as exc:
        _sync_room_agent_usage(game_id)
        room.status = "error"
        room.add_log("game_error", f"Live stream interrupted: {exc}", _error_log_data(exc))
    finally:
        await _sync_room_to_supabase_async(room)
        game_manager.live_tasks.pop(game_id, None)


def _sync_room_agent_usage(game_id: str) -> None:
    try:
        game_manager.harness(game_id)._sync_agent_usage()
    except Exception:
        return


async def _sync_room_to_supabase_async(room: Any) -> dict[str, Any]:
    return await asyncio.to_thread(_sync_room_to_supabase, room)


def _sync_room_to_supabase(room: Any) -> dict[str, Any]:
    try:
        return supabase_store.sync_room(room)
    except SupabasePersistenceError as exc:
        return {"stored": False, "reason": "supabase_error", "detail": str(exc)}


async def _stored_replay_or_none(game_id: str) -> dict[str, Any] | None:
    if not supabase_store.configured:
        return None
    return await asyncio.to_thread(supabase_store.game_replay, game_id)


def _error_log_data(exc: Exception) -> dict[str, Any]:
    data: dict[str, Any] = {"detail": str(exc)}
    details = getattr(exc, "details", None)
    if isinstance(details, list) and details:
        data["details"] = details
    return data


def _sse(event: str, data: Any, event_id: str | None = None) -> str:
    lines = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for line in payload.splitlines() or ["{}"]:
        lines.append(f"data: {line}")
    return "\n".join(lines) + "\n\n"
