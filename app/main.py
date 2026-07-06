import asyncio
import hashlib
import hmac
import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import os

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .game import GameManager
from .game.agents import OpenRouterColonyAgent, OpenRouterSettings
from .game.demo import demo_events, demo_fixtures
from .game.harness import (
    STARTING_COLONY_ANTS,
    STARTING_COLONY_FOOD,
    ColonyState,
    GameLogEvent,
    GameRoom,
    PlayerState,
    generate_ants,
    normalize_room_code,
)
from .persistence import SupabaseGameStore, SupabasePersistenceError
from .queen_auth import require_wallet_owner
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
LIVE_SCORE_POLL_SECONDS = 2.5
LIVE_FINAL_STATUS_IDS = {13, 14, 15, 16, 17}
LIVE_FINAL_GAME_STATES = {
    "finished",
    "complete",
    "completed",
    "full_time",
    "fulltime",
    "final",
    "final_whistle",
    "match_finished",
    "game_finished",
    "fixture_finished",
    "match_ended",
    "game_ended",
    "ended",
    "after_penalties",
    "post_match",
    "postmatch",
    "cancelled",
    "canceled",
    "abandoned",
    "coverage_cancelled",
    "coverage_canceled",
}
LIVE_WAITING_GAME_STATES = {"scheduled", "pre_match", "prematch", "not_started", "notstarted", "pre_game", "pregame"}
LIVE_WAITING_STATUS_IDS = {1}
REPLAY_MAX_DELAY_SECONDS = 8.0
ADMIN_TOKEN_HEADER = "x-aoc-admin-token"
ADMIN_SESSION_COOKIE = "aoc_admin_session"
ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


LIVE_AUTO_FINISH_AFTER_SECONDS = max(0.0, _env_float("LIVE_AUTO_FINISH_AFTER_SECONDS", 9000.0))


def _admin_token() -> str | None:
    return (os.getenv("AOC_ADMIN_TOKEN") or "").strip() or None


def _admin_session_value(expected: str) -> str:
    return hmac.new(expected.encode("utf-8"), b"age-of-colony-admin-session-v1", hashlib.sha256).hexdigest()


def _request_has_admin_session(request: Request, expected: str) -> bool:
    supplied = (request.headers.get(ADMIN_TOKEN_HEADER) or "").strip()
    if supplied and hmac.compare_digest(supplied, expected):
        return True
    cookie = (request.cookies.get(ADMIN_SESSION_COOKIE) or "").strip()
    return bool(cookie and hmac.compare_digest(cookie, _admin_session_value(expected)))


def _is_secure_request(request: Request) -> bool:
    return request.url.scheme == "https" or (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip() == "https"


def require_admin_tool(request: Request) -> None:
    expected = _admin_token()
    if not expected:
        return
    if not _request_has_admin_session(request, expected):
        raise HTTPException(status_code=403, detail="Admin token required for replay/debug tools.")


class CreateGameRequest(BaseModel):
    fixtureId: int | str
    participant1: str | None = None
    participant2: str | None = None
    competition: str | None = None
    startTime: int | float | str | None = None
    startTimeIso: str | None = None
    seed: int | None = None
    anonymousId: str | None = None
    creatorName: str | None = None


class CreateColonyRequest(BaseModel):
    name: str
    size: int
    style: str
    favoriteContext: str
    infoNeed: str
    anonymousId: str | None = None


class JoinRoomRequest(BaseModel):
    name: str
    anonymousId: str | None = None


class QueenUpsertRequest(BaseModel):
    name: str
    motto: str | None = None
    emblem: str | None = None


class UpdateColonyStrategyRequest(BaseModel):
    style: str | None = None
    favoriteContext: str | None = None
    infoNeed: str | None = None
    anonymousId: str | None = None


class StartGameRequest(BaseModel):
    mode: str = "replay"
    source: str = "historical"
    anonymousId: str | None = None
    replayDelaySeconds: float = Field(default=0.0, ge=0.0, le=30.0)
    replayTimeScale: float | None = Field(default=None, gt=0.0, le=3600.0)


class FinishGameRequest(BaseModel):
    anonymousId: str | None = None


class DemoRunRequest(BaseModel):
    seed: int | None = None


class AdminSessionRequest(BaseModel):
    token: str


class RunPreviousTxRequest(BaseModel):
    days: int = 14
    limit: int = 40
    competitionId: int | None = None
    search: str | None = None
    seed: int | None = None
    stream: bool = False
    replayDelaySeconds: float = Field(default=0.75, ge=0.0, le=30.0)
    replayTimeScale: float | None = Field(default=None, gt=0.0, le=3600.0)
    colonies: list[CreateColonyRequest] | None = None


class AdminRoomRequest(BaseModel):
    fixtureId: int | str
    participant1: str | None = None
    participant2: str | None = None
    competition: str | None = None
    startTime: int | float | str | None = None
    startTimeIso: str | None = None
    seed: int | None = None
    colonies: list[CreateColonyRequest] = Field(default_factory=list)


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
async def health(request: Request) -> dict[str, Any]:
    settings = TxLineSettings.from_env()
    agent_settings = OpenRouterSettings.from_env()
    admin_token = _admin_token()
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
        "adminToolsProtected": bool(admin_token),
        "adminAuthenticated": bool(admin_token and _request_has_admin_session(request, admin_token)),
        "supabase": supabase_store.public_status(),
    }


@app.post("/api/admin/session")
async def create_admin_session(payload: AdminSessionRequest, request: Request) -> JSONResponse:
    expected = _admin_token()
    if not expected:
        return JSONResponse({"ok": True, "protected": False, "adminAuthenticated": True})
    supplied = payload.token.strip()
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=403, detail="Admin token required for replay/debug tools.")
    response = JSONResponse({"ok": True, "protected": True, "adminAuthenticated": True})
    response.set_cookie(
        ADMIN_SESSION_COOKIE,
        _admin_session_value(expected),
        max_age=ADMIN_SESSION_MAX_AGE_SECONDS,
        httponly=True,
        secure=_is_secure_request(request),
        samesite="lax",
        path="/",
    )
    return response


@app.post("/api/games")
async def create_game(payload: CreateGameRequest) -> dict[str, Any]:
    room = await _get_or_create_public_match_room(payload)
    if payload.creatorName:
        game_manager.harness(room.game_id).join_player(payload.creatorName or "Host", anonymous_id=payload.anonymousId)
    await _ensure_public_match_room_armed(room)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/colonies")
async def create_colony(game_id: str, payload: CreateColonyRequest, request: Request) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    if not (payload.anonymousId or "").strip():
        require_admin_tool(request)
    try:
        game_manager.harness(game_id).add_colony(
            name=payload.name,
            size=payload.size,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
            anonymous_id=payload.anonymousId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _ensure_public_match_room_armed(room)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/players")
async def join_game_room(game_id: str, payload: JoinRoomRequest) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    try:
        game_manager.harness(game_id).join_player(payload.name, anonymous_id=payload.anonymousId)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.get("/api/rooms/{room_code}")
async def room_state_by_code(room_code: str) -> dict[str, Any]:
    room = await _get_room_by_code_or_restore_404(room_code)
    await _ensure_room_progress(room)
    return room.public_state()


@app.post("/api/rooms/{room_code}/players")
async def join_room_by_code(room_code: str, payload: JoinRoomRequest) -> dict[str, Any]:
    room = await _get_room_by_code_or_restore_404(room_code)
    try:
        game_manager.harness(room.game_id).join_player(payload.name, anonymous_id=payload.anonymousId)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


async def _get_or_create_public_match_room(payload: CreateGameRequest) -> GameRoom:
    room = _active_public_room_for_fixture(payload.fixtureId)
    if not room:
        stored = await _stored_public_room_for_fixture_or_none(payload.fixtureId)
        if stored:
            room = _restore_room_from_stored_row(stored)
    if room:
        _merge_public_fixture_metadata(room, payload)
        await _ensure_room_progress(room)
        return room

    room = game_manager.create_room(
        fixture_id=payload.fixtureId,
        participant1=payload.participant1,
        participant2=payload.participant2,
        competition=payload.competition,
        start_time=payload.startTime,
        start_time_iso=payload.startTimeIso,
        seed=payload.seed,
        owner_anonymous_id=payload.anonymousId,
        owner_name=payload.creatorName,
    )
    room.mode = "live"
    return room


def _active_public_room_for_fixture(fixture_id: int | str) -> GameRoom | None:
    for room in game_manager.rooms.values():
        if str(room.fixture_id) != str(fixture_id):
            continue
        if room.status in {"finished", "error", "stopped"}:
            continue
        if room.mode == "live":
            return room
        if room.mode is not None:
            continue
        if not (room.owner_anonymous_id or room.owner_name):
            continue
        return room
    return None


async def _stored_public_room_for_fixture_or_none(fixture_id: int | str) -> dict[str, Any] | None:
    if not supabase_store.configured:
        return None
    return await asyncio.to_thread(supabase_store.latest_game_for_fixture, fixture_id, mode="live")


def _merge_public_fixture_metadata(room: GameRoom, payload: CreateGameRequest) -> None:
    if payload.participant1 and not room.participant1:
        room.participant1 = payload.participant1
    if payload.participant2 and not room.participant2:
        room.participant2 = payload.participant2
    if payload.competition and not room.competition:
        room.competition = payload.competition
    if payload.startTime is not None and room.start_time is None:
        room.start_time = payload.startTime
    if payload.startTimeIso and not room.start_time_iso:
        room.start_time_iso = payload.startTimeIso
    if room.mode is None:
        room.mode = "live"
    if room.match_state:
        if room.participant1 and not room.match_state.participant1:
            room.match_state.participant1 = room.participant1
        if room.participant2 and not room.match_state.participant2:
            room.match_state.participant2 = room.participant2


async def _ensure_public_match_room_armed(room: GameRoom) -> None:
    if room.mode != "live" or not room.colonies:
        return
    if room.status in {"waiting_kickoff", "running_live"}:
        await _ensure_room_progress(room)
        return
    if room.status != "created":
        return

    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at and kickoff_at > datetime.now(timezone.utc):
        room.status = "waiting_kickoff"
        room.add_log(
            "game_locked",
            "Match room ready. Live game will start at kickoff.",
            {"mode": "live", "kickoffAt": kickoff_at.isoformat(), "autoStart": True},
        )
        _schedule_kickoff_start(room)
        return
    if kickoff_at:
        await _start_live_room_now(room)


# ---------------------------------------------------------------------------
# Queens — one royal profile per wallet (DB primary key enforces uniqueness).
# ---------------------------------------------------------------------------
def _clean_wallet_or_422(wallet: str) -> str:
    cleaned = (wallet or "").strip()[:80]
    if not cleaned:
        raise HTTPException(status_code=422, detail="wallet is required")
    return cleaned


def _queen_store_or_503() -> None:
    if not supabase_store.configured:
        raise HTTPException(
            status_code=503,
            detail="queen_store_not_configured",
        )


@app.get("/api/queens/{wallet}")
async def get_queen(wallet: str) -> dict[str, Any]:
    _queen_store_or_503()
    queen = await asyncio.to_thread(supabase_store.get_queen, _clean_wallet_or_422(wallet))
    if queen is None:
        raise HTTPException(status_code=404, detail="This wallet has not crowned a queen yet.")
    return queen


@app.put("/api/queens/{wallet}")
async def upsert_queen(
    wallet: str,
    payload: QueenUpsertRequest,
    _owner: str = Depends(require_wallet_owner),
) -> dict[str, Any]:
    _queen_store_or_503()
    name = (payload.name or "").strip()[:24]
    if not name:
        raise HTTPException(status_code=422, detail="Your queen needs a name.")
    motto = (payload.motto or "").strip()[:48]
    emblem = (payload.emblem or "👑").strip()[:8] or "👑"
    return await asyncio.to_thread(
        supabase_store.upsert_queen,
        _clean_wallet_or_422(wallet),
        name=name,
        motto=motto,
        emblem=emblem,
    )


@app.delete("/api/queens/{wallet}")
async def delete_queen(
    wallet: str,
    _owner: str = Depends(require_wallet_owner),
) -> dict[str, Any]:
    _queen_store_or_503()
    await asyncio.to_thread(supabase_store.delete_queen, _clean_wallet_or_422(wallet))
    return {"deleted": True, "wallet": _clean_wallet_or_422(wallet)}


@app.patch("/api/games/{game_id}/colonies/{colony_id}/strategy")
async def update_colony_strategy(game_id: str, colony_id: str, payload: UpdateColonyStrategyRequest) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    _ensure_colony_owner(room, colony_id, payload.anonymousId, action="update this colony")
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
async def start_game(game_id: str, payload: StartGameRequest, request: Request) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    _ensure_deepseek_agent()
    mode = payload.mode.strip().casefold()
    if mode not in {"replay", "live"}:
        raise HTTPException(status_code=422, detail="mode must be replay or live")
    if mode == "replay":
        require_admin_tool(request)
    if not room.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before starting the match.")
    if room.status in {"running_replay", "running_live"}:
        raise HTTPException(status_code=409, detail="The game is already running.")
    if room.status == "waiting_kickoff":
        await _ensure_waiting_room_progress(room)
        return room.public_state()

    room.mode = mode
    if mode == "replay":
        return await _start_replay_room(room, payload)

    _ensure_live_host(room, payload.anonymousId)
    _ensure_live_room_ready(room)
    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at and kickoff_at > datetime.now(timezone.utc):
        room.status = "waiting_kickoff"
        room.add_log(
            "game_locked",
            "Room locked. Live game will start at kickoff.",
            {"mode": "live", "kickoffAt": kickoff_at.isoformat()},
        )
        _schedule_kickoff_start(room)
        await _sync_room_to_supabase_async(room)
        return room.public_state()

    await _start_live_room_now(room)
    return room.public_state()


@app.post("/api/games/{game_id}/finish")
async def finish_game(game_id: str, payload: FinishGameRequest) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    _ensure_live_host(room, payload.anonymousId, action="finish the game")
    if room.status == "finished":
        return room.public_state()
    if room.status not in {"waiting_kickoff", "running_live"}:
        raise HTTPException(status_code=409, detail="Only a live room can be manually finished.")
    game_manager.harness(room.game_id).finish_game(mode="live")
    await _sync_room_to_supabase_async(room)
    return room.public_state()


def _ensure_live_host(room: GameRoom, anonymous_id: str | None, *, action: str = "start the game") -> None:
    if room.owner_anonymous_id and (anonymous_id or "").strip() != room.owner_anonymous_id:
        raise HTTPException(status_code=403, detail=f"Only the room host can {action}.")


def _ensure_colony_owner(room: GameRoom, colony_id: str, anonymous_id: str | None, *, action: str) -> None:
    colony = room.colonies.get(colony_id)
    if not colony:
        return
    if not colony.player_id and not colony.player_anonymous_id:
        return
    clean_anonymous_id = (anonymous_id or "").strip()
    if clean_anonymous_id and clean_anonymous_id == colony.player_anonymous_id:
        return
    raise HTTPException(status_code=403, detail=f"Only the colony owner can {action}.")


def _ensure_live_room_ready(room: GameRoom) -> None:
    if not room.players:
        return
    ready_player_ids = {colony.player_id for colony in room.colonies.values() if colony.player_id}
    ready_anonymous_ids = {colony.player_anonymous_id for colony in room.colonies.values() if colony.player_anonymous_id}
    missing = [
        player.name
        for player in room.players
        if player.player_id not in ready_player_ids and (not player.anonymous_id or player.anonymous_id not in ready_anonymous_ids)
    ]
    if missing:
        names = ", ".join(missing[:3])
        raise HTTPException(status_code=422, detail=f"Every player needs a colony before start. Missing: {names}.")


def _room_kickoff_datetime(room: GameRoom) -> datetime | None:
    return _parse_kickoff_datetime(room.start_time_iso) or _parse_kickoff_datetime(room.start_time)


def _parse_kickoff_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return _parse_kickoff_datetime(int(text))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _schedule_kickoff_start(room: GameRoom) -> None:
    task = getattr(game_manager, "kickoff_tasks", {}).get(room.game_id)
    if task and not task.done():
        return
    game_manager.kickoff_tasks[room.game_id] = asyncio.create_task(_wait_for_kickoff_and_start(room.game_id))


async def _wait_for_kickoff_and_start(game_id: str) -> None:
    room = game_manager.get_room(game_id)
    if not room:
        return
    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at:
        delay = max(0.0, (kickoff_at - datetime.now(timezone.utc)).total_seconds())
        if delay:
            await asyncio.sleep(delay)
    room = game_manager.get_room(game_id)
    if not room or room.status != "waiting_kickoff":
        return
    try:
        await _start_live_room_now(room)
    finally:
        game_manager.kickoff_tasks.pop(game_id, None)


async def _ensure_waiting_room_progress(room: GameRoom) -> None:
    if room.status != "waiting_kickoff":
        return
    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at and kickoff_at <= datetime.now(timezone.utc):
        await _start_live_room_now(room)
        return
    _schedule_kickoff_start(room)


async def _ensure_room_progress(room: GameRoom) -> None:
    await _ensure_waiting_room_progress(room)
    if room.status == "error" and room.mode == "live":
        room.status = "running_live"
        room.add_log("live_sync", "Live stream recovered and polling resumed.", {"mode": "live", "recovered": True})
        await _sync_room_to_supabase_async(room)
    if room.status == "running_live":
        _ensure_live_task(room)


def _ensure_live_task(room: GameRoom) -> None:
    task = game_manager.live_tasks.get(room.game_id)
    if task and not task.done():
        return
    game_manager.live_tasks[room.game_id] = asyncio.create_task(_run_live_game(room.game_id))


async def _start_live_room_now(room: GameRoom) -> None:
    room.status = "running_live"
    room.add_log("game_started", "Live game connected to TXLine updates.", {"mode": "live"})
    _ensure_live_task(room)
    await _sync_room_to_supabase_async(room)


@app.post("/api/games/{game_id}/rerun")
async def rerun_game(game_id: str, payload: StartGameRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
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


@app.post("/api/admin/rooms")
async def create_admin_room(payload: AdminRoomRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
    if not payload.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before creating an admin room.")

    room = game_manager.create_room(
        fixture_id=payload.fixtureId,
        participant1=payload.participant1,
        participant2=payload.participant2,
        competition=payload.competition,
        start_time=payload.startTime,
        start_time_iso=payload.startTimeIso,
        seed=payload.seed,
    )
    harness = game_manager.harness(room.game_id)
    try:
        for colony in payload.colonies:
            harness.add_colony(
                colony.name,
                colony.size,
                colony.style,
                colony.favoriteContext,
                colony.infoNeed,
            )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.get("/api/fixtures/recent")
async def recent_fixtures(
    request: Request,
    days: int = Query(default=14, ge=1, le=90),
    limit: int = Query(default=50, ge=1, le=200),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    require_admin_tool(request)
    client = TxLineClient()
    fixtures = await _recent_past_fixtures(client, days=days, limit=limit, competition_id=competition_id, search=search)
    return {"mode": "recent", "days": days, "limit": limit, "count": len(fixtures), "fixtures": fixtures}


@app.get("/api/admin/replay-fixtures")
async def admin_replay_fixtures(
    request: Request,
    days: int = Query(default=90, ge=1, le=90),
    limit: int = Query(default=24, ge=1, le=80),
    scan_limit: int = Query(default=120, ge=1, le=200),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    require_admin_tool(request)
    client = TxLineClient()
    fixtures = await _recent_past_fixtures(
        client,
        days=days,
        limit=scan_limit,
        competition_id=competition_id,
        search=search,
    )
    playable: list[dict[str, Any]] = []
    inspected = 0

    for fixture in fixtures:
        if len(playable) >= limit:
            break
        fixture_id = fixture.get("fixtureId")
        if fixture_id is None:
            continue
        try:
            source_records = await _fetch_score_sources(client, int(fixture_id))
        except (TypeError, ValueError):
            continue
        inspected += 1
        chosen_source, records = _choose_best_source(source_records)
        if not records:
            continue
        enriched = dict(fixture)
        enriched.update(
            {
                "playable": True,
                "source": chosen_source,
                "eventCount": len(records),
                "sourceCounts": {name: len(items) for name, items in source_records.items()},
            }
        )
        playable.append(enriched)

    return {
        "mode": "replay-fixtures",
        "days": days,
        "limit": limit,
        "scanLimit": scan_limit,
        "scanned": len(fixtures),
        "inspected": inspected,
        "count": len(playable),
        "fixtures": playable,
    }


@app.post("/api/games/run-previous")
async def run_previous_tx_game(payload: RunPreviousTxRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
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
        _add_run_previous_colonies(harness, payload.colonies)
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
                "stream": payload.stream,
                "replayDelaySeconds": payload.replayDelaySeconds,
                "replayTimeScale": payload.replayTimeScale,
            },
        )
        if payload.stream:
            room.status = "running_replay"
            _schedule_replay_task(
                room,
                timeline["events"],
                delay_seconds=payload.replayDelaySeconds,
                time_scale=payload.replayTimeScale,
            )
            await _sync_room_to_supabase_async(room)
            return room.public_state()

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
async def demo_matches(request: Request) -> dict[str, Any]:
    require_admin_tool(request)
    fixtures = demo_fixtures()
    return {"count": len(fixtures), "fixtures": fixtures}


@app.post("/api/demo/run")
async def demo_run(payload: DemoRunRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
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
async def admin_games(request: Request, limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    require_admin_tool(request)
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


def _stored_game_can_resume_live(stored_game: dict[str, Any]) -> bool:
    status = stored_game.get("status")
    if status in {"waiting_kickoff", "running_live"}:
        return True
    return status == "error" and stored_game.get("mode") == "live"


@app.get("/api/games/{game_id}")
async def game_state(game_id: str) -> dict[str, Any]:
    room = game_manager.get_room(game_id)
    if room:
        await _ensure_room_progress(room)
        return room.public_state()
    replay = await _stored_replay_or_none(game_id)
    if replay:
        stored_game = replay["game"]
        stored_status = stored_game.get("status")
        can_restore = stored_status not in {"finished", "stopped"} and (
            stored_status != "error" or _stored_game_can_resume_live(stored_game)
        )
        if can_restore:
            room = _restore_room_from_stored_row(
                {**((replay.get("stored") or {}).get("game") or {}), "public_state": stored_game},
                events=replay.get("events") or [],
            )
            await _ensure_room_progress(room)
            return room.public_state()
        return stored_game
    raise HTTPException(status_code=404, detail="Game not found.")


@app.get("/api/games/{game_id}/replay")
async def game_replay(game_id: str) -> dict[str, Any]:
    room = game_manager.get_room(game_id)
    if not room:
        replay = await _stored_replay_or_none(game_id)
        if replay:
            return replay
        raise HTTPException(status_code=404, detail="Game not found.")
    await _ensure_room_log_hydrated(room)
    return {
        "game": room.public_state(),
        "events": [event.public_state() for event in room.log],
    }


@app.get("/api/games/{game_id}/events")
async def game_events(game_id: str) -> StreamingResponse:
    room = game_manager.get_room(game_id)
    if not room:
        replay = await _stored_replay_or_none(game_id)
        if not replay:
            raise HTTPException(status_code=404, detail="Game not found.")
        stored_game = replay["game"]
        if not _stored_game_can_resume_live(stored_game):
            raise HTTPException(status_code=404, detail="Live event stream not available for stored replay.")
        room = _restore_room_from_stored_row(
            {**((replay.get("stored") or {}).get("game") or {}), "public_state": stored_game},
            events=replay.get("events") or [],
        )
    await _ensure_room_log_hydrated(room)
    await _ensure_room_progress(room)

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


def _get_game_or_404(game_id: str):
    room = game_manager.get_room(game_id)
    if not room:
        raise HTTPException(status_code=404, detail="Game not found.")
    return room


async def _get_room_by_code_or_restore_404(room_code: str):
    clean_room_code = normalize_room_code(room_code)
    if len(clean_room_code) != 6:
        raise HTTPException(status_code=422, detail="Room code must contain 6 digits.")
    room = game_manager.get_room_by_code(clean_room_code)
    if room:
        return room
    stored = await _stored_room_by_code_or_none(clean_room_code)
    if stored:
        return _restore_room_from_stored_row(stored)
    raise HTTPException(status_code=404, detail="Room code not found.")


async def _get_game_or_restore_404(game_id: str):
    room = game_manager.get_room(game_id)
    if room:
        return room
    replay = await _stored_replay_or_none(game_id)
    if replay:
        stored_row = (replay.get("stored") or {}).get("game") or {}
        return _restore_room_from_stored_row(
            {**stored_row, "public_state": replay.get("game") or stored_row.get("public_state")},
            events=replay.get("events") or [],
        )
    raise HTTPException(status_code=404, detail="Game not found.")


def _restore_room_from_stored_row(row: dict[str, Any], *, events: list[dict[str, Any]] | None = None):
    public_state = row.get("public_state") or row
    game_id = public_state.get("gameId") or row.get("game_id")
    if not game_id:
        raise HTTPException(status_code=404, detail="Game not found.")
    existing = game_manager.get_room(str(game_id))
    if existing:
        _merge_restored_events(existing, events or [])
        if events is not None:
            setattr(existing, "_aoc_log_hydrated", True)
        return existing

    owner = public_state.get("owner") or {}
    seed = row.get("seed")
    try:
        clean_seed = int(seed) if seed is not None else 7
    except (TypeError, ValueError):
        clean_seed = 7

    restored_room_code = normalize_room_code(public_state.get("roomCode") or row.get("room_code")) or _fallback_room_code_from_game_id(
        str(game_id)
    )
    room = GameRoom(
        game_id=str(game_id),
        room_code=restored_room_code,
        fixture_id=public_state.get("fixtureId") or row.get("fixture_id"),
        participant1=public_state.get("participant1") or row.get("participant1"),
        participant2=public_state.get("participant2") or row.get("participant2"),
        competition=public_state.get("competition") or row.get("competition"),
        start_time=public_state.get("startTime") or row.get("start_time"),
        start_time_iso=public_state.get("startTimeIso") or row.get("start_time_iso"),
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
    for colony_state in public_state.get("colonies") or []:
        if not isinstance(colony_state, dict):
            continue
        colony_id = str(colony_state.get("colonyId") or f"col_{len(room.colonies) + 1}")
        try:
            food = int(colony_state["food"]) if colony_state.get("food") is not None else STARTING_COLONY_FOOD
        except (TypeError, ValueError):
            food = STARTING_COLONY_FOOD
        colony = ColonyState(
            colony_id=colony_id,
            name=str(colony_state.get("name") or f"Colony {len(room.colonies) + 1}")[:40],
            size=STARTING_COLONY_ANTS,
            style=str(colony_state.get("style") or "balanced"),
            favorite_context=str(colony_state.get("favoriteContext") or "balanced"),
            info_need=str(colony_state.get("infoNeed") or "medium"),
            seed=clean_seed,
            player_id=str(colony_state.get("playerId"))[:80] if colony_state.get("playerId") else None,
            player_anonymous_id=str(colony_state.get("playerAnonymousId"))[:80] if colony_state.get("playerAnonymousId") else None,
            food=food,
        )
        colony.ants = generate_ants(colony)
        room.colonies[colony.colony_id] = colony
    _merge_restored_events(room, events or [])
    if events is not None:
        setattr(room, "_aoc_log_hydrated", True)
    return game_manager.register_room(room)


async def _ensure_room_log_hydrated(room: GameRoom) -> None:
    if getattr(room, "_aoc_log_hydrated", False):
        return
    if not supabase_store.configured:
        setattr(room, "_aoc_log_hydrated", True)
        return
    replay = await _stored_replay_or_none(room.game_id)
    if replay:
        _merge_restored_events(room, replay.get("events") or [])
    setattr(room, "_aoc_log_hydrated", True)


def _merge_restored_events(room: GameRoom, events: list[dict[str, Any]]) -> None:
    if not events:
        return
    existing_indexes = {event.index for event in room.log}
    restored: list[GameLogEvent] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        try:
            clean_index = int(event.get("index"))
        except (TypeError, ValueError):
            continue
        if clean_index in existing_indexes:
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        kwargs: dict[str, Any] = {}
        try:
            created_at = event.get("createdAt")
            if created_at is not None:
                kwargs["created_at"] = float(created_at)
        except (TypeError, ValueError):
            pass
        restored.append(
            GameLogEvent(
                clean_index,
                str(event.get("kind") or "event"),
                str(event.get("message") or ""),
                data,
                **kwargs,
            )
        )
        existing_indexes.add(clean_index)
    if not restored:
        return
    room.log = sorted([*room.log, *restored], key=lambda event: event.index)


async def _stored_room_by_code_or_none(room_code: str) -> dict[str, Any] | None:
    if not supabase_store.configured:
        return None
    return await asyncio.to_thread(supabase_store.latest_game_for_room_code, room_code)


def _fallback_room_code_from_game_id(game_id: str) -> str:
    digits = "".join(character for character in game_id if character.isdigit())
    if digits:
        return digits[-6:].rjust(6, "0")
    digest = hashlib.sha1(game_id.encode("utf-8")).hexdigest()
    return str(int(digest[:8], 16) % 1_000_000).zfill(6)


def _add_autorun_colonies(harness: Any) -> None:
    for name, size, style, favorite_context, info_need in AUTORUN_COLONIES:
        harness.add_colony(name, size, style, favorite_context, info_need)


def _add_run_previous_colonies(harness: Any, colonies: list[CreateColonyRequest] | None) -> None:
    if not colonies:
        _add_autorun_colonies(harness)
        return
    for colony in colonies:
        harness.add_colony(
            colony.name,
            colony.size,
            colony.style,
            colony.favoriteContext,
            colony.infoNeed,
        )


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
        _schedule_replay_task(
            room,
            events,
            delay_seconds=payload.replayDelaySeconds,
            time_scale=payload.replayTimeScale,
        )
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
        {
            "mode": "replay",
            "source": payload.source,
            "rawCount": timeline["rawCount"],
            "replayDelaySeconds": payload.replayDelaySeconds,
            "replayTimeScale": payload.replayTimeScale,
        },
    )
    room.status = "running_replay"
    _schedule_replay_task(
        room,
        timeline["events"],
        delay_seconds=payload.replayDelaySeconds,
        time_scale=payload.replayTimeScale,
    )
    await _sync_room_to_supabase_async(room)
    return room.public_state()


def _schedule_replay_task(
    room: Any,
    events: list[dict[str, Any]],
    *,
    delay_seconds: float = 0.0,
    time_scale: float | None = None,
) -> None:
    task = game_manager.replay_tasks.get(room.game_id)
    if task and not task.done():
        return
    game_manager.replay_tasks[room.game_id] = asyncio.create_task(
        _run_replay_game(
            room.game_id,
            events,
            delay_seconds=delay_seconds,
            time_scale=time_scale,
        )
    )


async def _run_replay_game(
    game_id: str,
    events: list[dict[str, Any]],
    *,
    delay_seconds: float = 0.0,
    time_scale: float | None = None,
) -> None:
    room = game_manager.get_room(game_id)
    if not room:
        return
    try:
        harness = game_manager.harness(game_id)
        if delay_seconds <= 0 and not time_scale:
            await asyncio.to_thread(harness.process_events, events)
            return

        for index, event in enumerate(events):
            room = game_manager.get_room(game_id)
            if not room or room.status != "running_replay":
                break
            await asyncio.to_thread(harness.process_event, event)
            _sync_room_agent_usage(game_id)
            await _sync_room_to_supabase_async(room)
            delay = _replay_delay_after_event(
                events,
                index,
                delay_seconds=delay_seconds,
                time_scale=time_scale,
            )
            if delay:
                await asyncio.sleep(delay)

        room = game_manager.get_room(game_id)
        if room and room.status == "running_replay":
            await asyncio.to_thread(harness.finish_game, mode="replay")
    except asyncio.CancelledError:
        room.status = "stopped"
        raise
    except Exception as exc:
        _sync_room_agent_usage(game_id)
        room.status = "error"
        room.add_log("game_error", f"Replay interrupted: {exc}", _error_log_data(exc))
    finally:
        final_room = game_manager.get_room(game_id) or room
        if final_room:
            await _sync_room_to_supabase_async(final_room)
        game_manager.replay_tasks.pop(game_id, None)


def _replay_delay_after_event(
    events: list[dict[str, Any]],
    index: int,
    *,
    delay_seconds: float = 0.0,
    time_scale: float | None = None,
) -> float:
    if index >= len(events) - 1:
        return 0.0
    if time_scale:
        current_clock = _event_clock_seconds(events[index])
        next_clock = _event_clock_seconds(events[index + 1])
        if current_clock is not None and next_clock is not None and next_clock >= current_clock:
            return min(REPLAY_MAX_DELAY_SECONDS, max(0.0, (next_clock - current_clock) / time_scale))
    return min(REPLAY_MAX_DELAY_SECONDS, max(0.0, delay_seconds))


def _event_clock_seconds(event: dict[str, Any]) -> float | None:
    value = event.get("clockSeconds")
    if value is None and isinstance(event.get("clock"), dict):
        value = event["clock"].get("seconds")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def _run_live_game(game_id: str) -> None:
    room = game_manager.get_room(game_id)
    if not room:
        return
    client = TxLineClient()
    harness = game_manager.harness(game_id)
    seen_event_keys: set[tuple[Any, ...]] = set()
    first_batch = True
    baseline_opened = False
    waiting_logged = False
    poll_failures = 0
    try:
        while True:
            room = game_manager.get_room(game_id)
            if not room or room.status != "running_live":
                break
            try:
                timeline = await _live_score_timeline(client, room)
                poll_failures = 0
            except Exception as exc:
                poll_failures += 1
                if poll_failures == 1 or poll_failures % 5 == 0:
                    room.add_log("game_error", f"Live polling retrying: {exc}", {**_error_log_data(exc), "retryCount": poll_failures})
                    await _sync_room_to_supabase_async(room)
                await asyncio.sleep(LIVE_SCORE_POLL_SECONDS)
                continue
            timeline_events = timeline["events"]
            if first_batch:
                catchup_count = _prime_live_catchup(room, seen_event_keys, timeline_events, timeline)
                if _live_timeline_finished(timeline) or _live_auto_finish_reached(room):
                    if catchup_count:
                        await _sync_room_to_supabase_async(room)
                    await asyncio.to_thread(_finish_live_game, harness)
                    await _sync_room_to_supabase_async(room)
                    break
                baseline_count = 0
                if _live_timeline_active(timeline):
                    baseline_count = await asyncio.to_thread(_open_live_baseline_markets, harness, timeline_events)
                    baseline_opened = baseline_opened or bool(baseline_count)
                elif not waiting_logged:
                    _log_live_waiting_for_kickoff(room, timeline)
                    waiting_logged = True
                if catchup_count or baseline_count:
                    await _sync_room_to_supabase_async(room)
                first_batch = False
                await asyncio.sleep(LIVE_SCORE_POLL_SECONDS)
                continue
            new_events = [
                event
                for event in timeline_events
                if str(event.get("fixtureId")) == str(room.fixture_id) and _remember_live_event(seen_event_keys, event)
            ]
            if new_events:
                await asyncio.to_thread(_process_live_events, harness, new_events, resilient=True)
                _sync_room_agent_usage(game_id)
                await _sync_room_to_supabase_async(room)
            if _live_timeline_finished(timeline) or _live_auto_finish_reached(room):
                await asyncio.to_thread(_finish_live_game, harness)
                await _sync_room_to_supabase_async(room)
                break
            if not baseline_opened and _live_timeline_active(timeline):
                baseline_count = await asyncio.to_thread(_open_live_baseline_markets, harness, timeline_events)
                baseline_opened = baseline_opened or bool(baseline_count)
                if baseline_count:
                    await _sync_room_to_supabase_async(room)
            first_batch = False
            await asyncio.sleep(LIVE_SCORE_POLL_SECONDS)
    except asyncio.CancelledError:
        room.status = "stopped"
    except Exception as exc:
        _sync_room_agent_usage(game_id)
        room.status = "error"
        room.add_log("game_error", f"Live stream interrupted: {exc}", _error_log_data(exc))
    finally:
        await _sync_room_to_supabase_async(room)
        game_manager.live_tasks.pop(game_id, None)


async def _live_score_timeline(client: TxLineClient, room: GameRoom) -> dict[str, Any]:
    try:
        fixture_id = int(room.fixture_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("Live mode requires a numeric fixture id.") from exc

    records = await client.score_updates(fixture_id)
    resolved_source = "updates"
    if not records:
        records = await client.score_snapshot(fixture_id)
        resolved_source = "snapshot"

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
    timeline["resolvedSource"] = resolved_source
    return timeline


def _remember_live_event(seen_event_keys: set[tuple[Any, ...]], event: dict[str, Any]) -> bool:
    key = _live_event_key(event)
    if key in seen_event_keys:
        return False
    seen_event_keys.add(key)
    return True


def _prime_live_catchup(
    room: GameRoom,
    seen_event_keys: set[tuple[Any, ...]],
    timeline_events: list[dict[str, Any]],
    timeline: dict[str, Any] | None = None,
) -> int:
    catchup_events = [
        event
        for event in timeline_events
        if str(event.get("fixtureId")) == str(room.fixture_id)
    ]
    for event in catchup_events:
        seen_event_keys.add(_live_event_key(event))
        if room.match_state:
            room.match_state.update(event)
    if catchup_events and room.match_state:
        room.match_state.score = _timeline_score_or_zero(timeline)
    if catchup_events:
        room.add_log(
            "live_sync",
            f"Live catch-up synced {len(catchup_events)} TXLine updates. Future updates will open markets.",
            {
                "source": (timeline or {}).get("resolvedSource"),
                "rawCount": (timeline or {}).get("rawCount"),
                "fixtureId": room.fixture_id,
                "processedAsMarkets": False,
            },
        )
    return len(catchup_events)


def _live_timeline_active(timeline: dict[str, Any] | None) -> bool:
    status = _live_timeline_status(timeline)
    if _live_status_finished(status):
        return False
    state = _normalize_live_game_state(status.get("gameState"))
    if state in LIVE_WAITING_GAME_STATES:
        return False
    status_id = _safe_int(status.get("statusId"))
    if status_id in LIVE_WAITING_STATUS_IDS:
        return False
    if state:
        return True
    return status_id is not None and status_id not in LIVE_FINAL_STATUS_IDS


def _log_live_waiting_for_kickoff(room: GameRoom, timeline: dict[str, Any] | None) -> None:
    status = _live_timeline_status(timeline)
    state = status.get("gameState") or "scheduled"
    room.add_log(
        "live_sync",
        f"TXLine still reports the fixture as {state}; waiting before opening markets.",
        {
            "fixtureId": room.fixture_id,
            "processedAsMarkets": False,
            "source": (timeline or {}).get("resolvedSource"),
            "gameState": status.get("gameState"),
            "statusId": status.get("statusId"),
        },
    )


def _live_timeline_status(timeline: dict[str, Any] | None) -> dict[str, Any]:
    top_level_status = _live_status_from_candidate((timeline or {}).get("latestState"))
    if _live_status_has_state(top_level_status) or _live_status_finished(top_level_status):
        return top_level_status
    top_level_status = _live_status_from_candidate(timeline)
    if _live_status_has_state(top_level_status) or _live_status_finished(top_level_status):
        return top_level_status
    for event in reversed((timeline or {}).get("events") or []):
        if not isinstance(event, dict):
            continue
        event_status = _live_status_from_candidate(event)
        if _live_status_has_state(event_status) or _live_status_finished(event_status):
            return event_status
    return {}


def _live_status_from_candidate(candidate: Any) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        return {}
    raw = candidate.get("raw") if isinstance(candidate.get("raw"), dict) else {}
    game_state = _first_status_value(candidate.get("gameState"), candidate.get("GameState"), raw.get("GameState"), raw.get("gameState"))
    status_id = _first_status_value(candidate.get("statusId"), candidate.get("StatusId"), raw.get("StatusId"), raw.get("statusId"))
    status = _first_status_value(candidate.get("status"), candidate.get("Status"), raw.get("Status"), raw.get("status"))
    action = _first_status_value(candidate.get("action"), candidate.get("Action"), raw.get("Action"), raw.get("action"))
    event_type = _first_status_value(candidate.get("type"), candidate.get("Type"), raw.get("Type"), raw.get("type"))
    description = _first_status_value(
        candidate.get("description"),
        candidate.get("Description"),
        raw.get("Description"),
        raw.get("description"),
    )
    if game_state is None and status_id is None and status is None and action is None and event_type is None and description is None:
        return {}
    return {
        "gameState": game_state,
        "statusId": status_id,
        "status": status,
        "action": action,
        "type": event_type,
        "description": description,
    }


def _first_status_value(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _live_status_has_state(status: dict[str, Any] | None) -> bool:
    return bool(status and (status.get("gameState") is not None or status.get("statusId") is not None or status.get("status") is not None))


def _normalize_live_game_state(value: Any) -> str:
    return str(value or "").strip().casefold().replace("-", "_").replace(" ", "_")


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _open_live_baseline_markets(harness: Any, timeline_events: list[dict[str, Any]] | None = None) -> int:
    room = harness.room
    if any(not prediction.resolved for prediction in room.predictions.values()):
        return 0
    latest_event = _latest_fixture_event(room, timeline_events or [])
    try:
        opened = harness.open_baseline_markets(latest_event, reason="live_baseline")
    except Exception as exc:
        room.add_log("game_error", f"Live baseline markets skipped: {exc}", _error_log_data(exc))
        return 0
    if opened:
        room.add_log(
            "live_sync",
            f"Opened {opened} live market(s) from the current match state.",
            {"fixtureId": room.fixture_id, "processedAsMarkets": True, "source": "baseline"},
        )
    return opened


def _latest_fixture_event(room: GameRoom, events: list[dict[str, Any]]) -> dict[str, Any] | None:
    for event in reversed(events):
        if str(event.get("fixtureId")) == str(room.fixture_id):
            return event
    return None


def _timeline_score_or_zero(timeline: dict[str, Any] | None) -> dict[str, Any]:
    score = (timeline or {}).get("score")
    if not isinstance(score, dict):
        return {"participant1": 0, "participant2": 0}
    return {
        "participant1": score.get("participant1") if score.get("participant1") is not None else 0,
        "participant2": score.get("participant2") if score.get("participant2") is not None else 0,
    }


def _live_event_key(event: dict[str, Any]) -> tuple[Any, ...]:
    fixture_id = event.get("fixtureId")
    seq = event.get("seq")
    if seq is not None:
        return ("seq", fixture_id, seq)
    return (
        "event",
        fixture_id,
        event.get("id"),
        event.get("ts"),
        event.get("action"),
        event.get("clockSeconds"),
    )


def _process_live_events(harness: Any, events: list[dict[str, Any]], *, resilient: bool = False) -> int:
    processed = 0
    for event in events:
        if not resilient:
            harness.process_event(event)
            processed += 1
            continue
        try:
            harness.process_event(event)
            processed += 1
        except Exception as exc:
            harness.room.add_log("game_error", f"Live update skipped: {exc}", _live_event_error_data(exc, event))
    return processed


def _live_event_error_data(exc: Exception, event: dict[str, Any]) -> dict[str, Any]:
    data = _error_log_data(exc)
    data["event"] = {
        "fixtureId": event.get("fixtureId"),
        "seq": event.get("seq"),
        "action": event.get("action"),
        "minute": event.get("minute"),
        "clockSeconds": event.get("clockSeconds"),
    }
    return data


def _finish_live_game(harness: Any) -> None:
    harness.finish_game(mode="live")


def _live_auto_finish_reached(room: GameRoom) -> bool:
    if LIVE_AUTO_FINISH_AFTER_SECONDS <= 0:
        return False
    kickoff_at = _room_kickoff_datetime(room)
    if not kickoff_at:
        return False
    return datetime.now(timezone.utc) >= kickoff_at + timedelta(seconds=LIVE_AUTO_FINISH_AFTER_SECONDS)


def _live_timeline_finished(timeline: dict[str, Any]) -> bool:
    if _live_status_finished(_live_timeline_status(timeline)):
        return True
    return any(_live_event_finished(event) for event in timeline.get("events") or [])


def _live_event_finished(event: dict[str, Any]) -> bool:
    if _live_status_finished(_live_status_from_candidate(event)):
        return True
    raw = event.get("raw") if isinstance(event.get("raw"), dict) else {}
    status_id = _status_id_value(
        event.get("statusId")
        or event.get("status")
        or raw.get("StatusId")
        or raw.get("statusId")
        or raw.get("Status")
        or raw.get("status")
    )
    if status_id in LIVE_FINAL_STATUS_IDS:
        return True

    text = " ".join(
        str(value or "")
        for value in (
            event.get("gameState"),
            event.get("action"),
            event.get("type"),
            event.get("description"),
            raw.get("GameState"),
            raw.get("gameState"),
            raw.get("Status"),
            raw.get("status"),
            raw.get("Action"),
            raw.get("action"),
            raw.get("Type"),
            raw.get("type"),
        )
    ).casefold()
    normalized = text.replace("_", " ").replace("-", " ")
    return any(
        marker in normalized
        for marker in (
            "full time",
            "fulltime",
            "final whistle",
            "match finished",
            "game finished",
            "fixture finished",
            "match ended",
            "game ended",
            "after penalties",
            "cancelled",
            "abandoned",
            "coverage cancelled",
        )
    )


def _live_status_finished(status: dict[str, Any] | None) -> bool:
    if not status:
        return False
    status_id = _status_id_value(status.get("statusId") or status.get("status"))
    if status_id in LIVE_FINAL_STATUS_IDS:
        return True
    values = [
        status.get("gameState"),
        status.get("status"),
        status.get("action"),
        status.get("type"),
        status.get("description"),
    ]
    normalized = " ".join(str(value or "") for value in values).casefold().replace("_", " ").replace("-", " ")
    tokens = {_normalize_live_game_state(value) for value in values if value is not None}
    if tokens.intersection(LIVE_FINAL_GAME_STATES):
        return True
    return any(
        marker in normalized
        for marker in (
            "full time",
            "fulltime",
            "final whistle",
            "match finished",
            "game finished",
            "fixture finished",
            "match ended",
            "game ended",
            "after penalties",
            "post match",
            "final score",
            "coverage cancelled",
            "coverage canceled",
        )
    )


def _status_id_value(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
