import asyncio
import hashlib
import json
import secrets
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any, AsyncIterator, Literal

import os

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .game import GameManager
from .game.agents import OpenRouterColonyAgent, OpenRouterSettings
from .game.demo import demo_events, demo_fixtures
from .game.harness import (
    MARKET_RISK_SUGAR,
    PRIVATE_SNAPSHOT_KEY,
    STANDARD_MARKET_INTERVAL_SECONDS,
    STARTING_COLONY_ANTS,
    STARTING_COLONY_FOOD,
    ColonyState,
    GameLogEvent,
    GameRoom,
    Opportunity,
    OpportunityOption,
    PlayerState,
    Prediction,
    ant_bet_history,
    ant_public_state,
    ant_strategy_state,
    ant_strategy_history,
    clone_ant_for_new_match,
    find_ant,
    generate_ants,
    normalize_room_code,
    opportunity_options,
    redact_public_identity,
    restore_ant_profile,
    room_kind_from_snapshot,
    room_scope_from_snapshot,
)
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
    epoch_to_iso,
    filter_upcoming_fixtures,
    normalize_fixtures,
    normalize_score_record,
    parse_date_to_epoch_day,
)
from .txline_validation import (
    TxLineOnChainValidationError,
    final_score_from_stats,
    find_finalized_score_record,
    txline_network,
    validate_txline_proof_onchain,
    winner_from_score,
)
from .wallet_auth import WALLET_SESSION_COOKIE, WalletAuthError, WalletAuthManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Age of Colony TXLine Monitor", version="0.1.0")
_txline_validation_cache: dict[str, dict[str, Any]] = {}
_admin_room_request_cache: dict[str, tuple[str, str]] = {}
_admin_room_request_lock = RLock()
ADMIN_ROOM_REQUEST_CACHE_LIMIT = 256

# CORS — allow the standalone Next.js frontend (separate origin) to call the API.
# Set WEB_ORIGINS to a comma-separated allowlist in production; defaults to "*" for dev.
_web_origins = os.getenv("WEB_ORIGINS", "*")
_allow_origins = ["*"] if _web_origins.strip() == "*" else [o.strip() for o in _web_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_origins != ["*"],
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
LIVE_PREMATCH_ACTIONS = {
    "coverage_update",
    "lineups",
    "lineup",
    "weather",
    "venue",
    "comment",
    "connected",
    "clock",
}
LIVE_ACTIVITY_ACTIONS = {
    "attack_possession",
    "safe_possession",
    "possession",
    "danger_possession",
    "high_danger_possession",
    "throw_in",
    "shot",
    "free_kick",
    "corner",
    "goal_kick",
    "goal",
    "penalty",
    "yellow_card",
    "red_card",
    "substitution",
    "injury",
    "possible",
    "var",
}
REPLAY_MAX_DELAY_SECONDS = 8.0


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


LIVE_AUTO_FINISH_AFTER_SECONDS = max(0.0, _env_float("LIVE_AUTO_FINISH_AFTER_SECONDS", 9000.0))
_wallet_session_secret_from_env = (os.getenv("WALLET_SESSION_SECRET") or "").strip()
wallet_auth_manager = WalletAuthManager(
    _wallet_session_secret_from_env or secrets.token_urlsafe(48),
    domain=(os.getenv("WALLET_AUTH_DOMAIN") or "Age of Colony").strip(),
    uri=(os.getenv("WALLET_AUTH_URI") or "https://age-of-colony.app").strip(),
    challenge_ttl_seconds=max(30, int(_env_float("WALLET_CHALLENGE_TTL_SECONDS", 300))),
    session_ttl_seconds=max(60, int(_env_float("WALLET_SESSION_TTL_SECONDS", 3600))),
    max_pending_challenges=max(128, int(_env_float("WALLET_MAX_PENDING_CHALLENGES", 4096))),
)


def require_admin_tool(_: Request) -> None:
    """Admin/debug tools are intentionally open during the current build phase."""
    return


class WalletChallengeRequest(BaseModel):
    wallet: str


class WalletVerifyRequest(BaseModel):
    wallet: str
    nonce: str
    signature: str


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


class RallyRequest(BaseModel):
    colonyId: str
    opportunityId: str
    anonymousId: str | None = None


class RecallRequest(BaseModel):
    colonyId: str
    opportunityId: str
    anonymousId: str | None = None


class SwitchCallRequest(BaseModel):
    colonyId: str
    opportunityId: str
    optionId: str
    anonymousId: str | None = None


class UpdateAntStrategyRequest(BaseModel):
    style: str | None = None
    favoriteContext: str | None = None
    infoNeed: str | None = None
    analysisRole: Literal["reactive", "statistical", "situational"] | None = None
    inheritGlobal: bool = False
    anonymousId: str | None = None


class StartGameRequest(BaseModel):
    mode: str = "replay"
    source: str = "historical"
    anonymousId: str | None = None
    agentCallMode: Literal["per_ant", "batch"] | None = "per_ant"
    replayDelaySeconds: float = Field(default=0.0, ge=0.0, le=30.0)
    replayTimeScale: float | None = Field(default=None, gt=0.0, le=3600.0)


class FinishGameRequest(BaseModel):
    anonymousId: str | None = None


class DemoRunRequest(BaseModel):
    seed: int | None = None


class RunPreviousTxRequest(BaseModel):
    days: int = 14
    limit: int = 40
    competitionId: int | None = None
    search: str | None = None
    seed: int | None = None
    stream: bool = False
    agentCallMode: Literal["per_ant", "batch"] | None = "per_ant"
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
    requestKey: str | None = Field(default=None, min_length=1, max_length=128)
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


@app.exception_handler(httpx.TimeoutException)
async def txline_timeout_error_handler(_: Request, exc: httpx.TimeoutException) -> JSONResponse:
    return JSONResponse(
        status_code=504,
        content={
            "detail": "TXLine did not respond before the timeout.",
            "hint": "Retry shortly. The TXLine connection is forced over IPv4 for Railway compatibility.",
            "error": type(exc).__name__,
        },
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


@app.exception_handler(WalletAuthError)
async def wallet_auth_error_handler(_: Request, exc: WalletAuthError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
    )


def _wallet_cookie_secure(request: Request) -> bool:
    configured = (os.getenv("WALLET_COOKIE_SECURE") or "").strip().casefold()
    if configured in {"1", "true", "yes", "on"}:
        return True
    if configured in {"0", "false", "no", "off"}:
        return False
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip().casefold()
    return request.url.scheme == "https" or forwarded_proto == "https"


def _wallet_from_request(request: Request) -> str | None:
    token = request.cookies.get(WALLET_SESSION_COOKIE)
    if not token:
        return None
    return wallet_auth_manager.wallet_for_token(token)


def _request_player_identity(request: Request, anonymous_id: str | None = None) -> tuple[str | None, str | None]:
    wallet = _wallet_from_request(request)
    clean_anonymous_id = (anonymous_id or "").strip()[:80] or None
    return wallet, clean_anonymous_id


def _require_wallet_for_wallet_room(room: GameRoom, wallet: str | None) -> None:
    if room.owner_wallet and not wallet:
        raise HTTPException(
            status_code=401,
            detail="Connect and sign with Phantom to join this wallet room.",
        )


def _require_player_identity(
    room: GameRoom,
    wallet: str | None,
    anonymous_id: str | None,
    *,
    action: str,
) -> None:
    """Keep ownerless access exclusive to explicit admin simulations.

    The anonymous browser id remains a supported player identity for the
    pre-wallet flow. A room merely lacking owner fields must never acquire
    admin-like mutation rights.
    """

    if room.room_kind == "admin":
        return
    if wallet or (anonymous_id or "").strip():
        return
    raise HTTPException(
        status_code=401,
        detail=f"Connect a wallet or provide a browser identity to {action}.",
    )


@app.post("/api/auth/wallet/challenge")
async def wallet_challenge(payload: WalletChallengeRequest, response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return wallet_auth_manager.create_challenge(payload.wallet).public_state()


@app.post("/api/auth/wallet/verify")
async def wallet_verify(payload: WalletVerifyRequest, request: Request) -> Response:
    session = wallet_auth_manager.verify_challenge(payload.wallet, payload.nonce, payload.signature)
    response = JSONResponse(session.public_state(), headers={"Cache-Control": "no-store"})
    response.set_cookie(
        **wallet_auth_manager.session_cookie_kwargs(
            session,
            secure=_wallet_cookie_secure(request),
        )
    )
    return response


@app.get("/api/auth/wallet/session")
async def wallet_session(request: Request) -> Response:
    token = request.cookies.get(WALLET_SESSION_COOKIE)
    if not token:
        return JSONResponse(
            {"authenticated": False, "wallet": None},
            headers={"Cache-Control": "no-store"},
        )
    try:
        claims = wallet_auth_manager.verify_session(token)
    except WalletAuthError as exc:
        response = JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code, "authenticated": False, "wallet": None},
            headers={"Cache-Control": "no-store"},
        )
        response.delete_cookie(
            **wallet_auth_manager.clear_cookie_kwargs(secure=_wallet_cookie_secure(request))
        )
        return response
    return JSONResponse(
        {
            "authenticated": True,
            "wallet": claims.wallet,
            "issuedAt": claims.issued_at,
            "expiresAt": claims.expires_at,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.delete("/api/auth/wallet/session")
async def wallet_logout(request: Request) -> Response:
    response = JSONResponse(
        {"authenticated": False, "wallet": None},
        headers={"Cache-Control": "no-store"},
    )
    response.delete_cookie(
        **wallet_auth_manager.clear_cookie_kwargs(secure=_wallet_cookie_secure(request))
    )
    return response


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
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
        "adminToolsProtected": False,
        "adminAuthenticated": True,
        "walletAuth": {
            "enabled": True,
            "persistentSecretConfigured": bool(_wallet_session_secret_from_env),
            "sessionTtlSeconds": wallet_auth_manager.session_ttl_seconds,
            "challengeTtlSeconds": wallet_auth_manager.challenge_ttl_seconds,
            "maxPendingChallenges": wallet_auth_manager.max_pending_challenges,
            "transactionRequired": False,
        },
        "supabase": supabase_store.public_status(),
    }


@app.post("/api/games")
async def create_game(payload: CreateGameRequest, request: Request) -> dict[str, Any]:
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    if not wallet and not anonymous_id:
        raise HTTPException(
            status_code=401,
            detail="Connect a wallet or provide a browser identity to create a player room.",
        )
    room = await _get_or_create_public_match_room(payload)
    _require_wallet_for_wallet_room(room, wallet)
    if payload.creatorName:
        try:
            game_manager.harness(room.game_id).join_player(
                payload.creatorName or "Player",
                anonymous_id=None if wallet else anonymous_id,
                wallet=wallet,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _ensure_public_match_room_armed(room)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/rooms")
async def create_private_room(payload: CreateGameRequest, request: Request) -> dict[str, Any]:
    """Create a new invite-only room, even when the fixture already has rooms."""

    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    if not wallet and not anonymous_id:
        raise HTTPException(
            status_code=401,
            detail="Connect a wallet or provide a browser identity to create a private room.",
        )
    room = game_manager.create_room(
        fixture_id=payload.fixtureId,
        participant1=payload.participant1,
        participant2=payload.participant2,
        competition=payload.competition,
        start_time=payload.startTime,
        start_time_iso=payload.startTimeIso,
        seed=payload.seed,
        owner_anonymous_id=None if wallet else anonymous_id,
        owner_wallet=wallet,
        owner_name=payload.creatorName,
        room_kind="player",
        room_scope="private",
    )
    room.mode = "live"
    room.agent_call_mode = "per_ant"
    if payload.creatorName:
        try:
            game_manager.harness(room.game_id).join_player(
                payload.creatorName,
                anonymous_id=None if wallet else anonymous_id,
                wallet=wallet,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/colonies")
async def create_colony(game_id: str, payload: CreateColonyRequest, request: Request) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _require_wallet_for_wallet_room(room, wallet)
    _require_player_identity(room, wallet, anonymous_id, action="create a colony")
    try:
        game_manager.harness(game_id).add_colony(
            name=payload.name,
            size=payload.size,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
            anonymous_id=None if wallet else anonymous_id,
            wallet=wallet,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _ensure_public_match_room_armed(room)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/players")
async def join_game_room(game_id: str, payload: JoinRoomRequest, request: Request) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _require_wallet_for_wallet_room(room, wallet)
    _require_player_identity(room, wallet, anonymous_id, action="join this player room")
    try:
        game_manager.harness(game_id).join_player(
            payload.name,
            anonymous_id=None if wallet else anonymous_id,
            wallet=wallet,
        )
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
async def join_room_by_code(room_code: str, payload: JoinRoomRequest, request: Request) -> dict[str, Any]:
    room = await _get_room_by_code_or_restore_404(room_code)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _require_wallet_for_wallet_room(room, wallet)
    _require_player_identity(room, wallet, anonymous_id, action="join this player room")
    try:
        game_manager.harness(room.game_id).join_player(
            payload.name,
            anonymous_id=None if wallet else anonymous_id,
            wallet=wallet,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


async def _get_or_create_public_match_room(
    payload: CreateGameRequest,
) -> GameRoom:
    room = _active_public_room_for_fixture(payload.fixtureId)
    if not room:
        stored = await _stored_public_room_for_fixture_or_none(payload.fixtureId)
        if stored:
            stored_state = _admin_game_public_state(stored)
            if stored_state and _stored_game_has_orphaned_worker(stored_state):
                await _mark_orphaned_stored_game(stored_state)
                room = None
            else:
                room = _restore_room_from_stored_row(stored)
    if not room:
        # A configured persistence lookup yields control to the event loop.
        # Recheck memory before creating so concurrent joins still converge on
        # one global room for the fixture.
        room = _active_public_room_for_fixture(payload.fixtureId)
    if room:
        _make_global_room_system_owned(room)
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
        room_kind="player",
        room_scope="global",
    )
    room.mode = "live"
    room.agent_call_mode = "per_ant"
    return room


def _active_public_room_for_fixture(fixture_id: int | str) -> GameRoom | None:
    for room in game_manager.rooms.values():
        if room.room_kind != "player":
            continue
        if room.room_scope != "global":
            continue
        if str(room.fixture_id) != str(fixture_id):
            continue
        if room.status in {"finished", "error", "stopped"}:
            continue
        if room.mode == "live":
            return room
        if room.mode is not None:
            continue
        return room
    return None


async def _stored_public_room_for_fixture_or_none(fixture_id: int | str) -> dict[str, Any] | None:
    if not supabase_store.configured:
        return None
    return await asyncio.to_thread(
        supabase_store.latest_game_for_fixture,
        fixture_id,
        mode="live",
        room_kind="player",
        room_scope="global",
    )


def _make_global_room_system_owned(room: GameRoom) -> None:
    room.owner_anonymous_id = None
    room.owner_wallet = None
    room.owner_name = None
    room.room_scope = "global"


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
    if room.mode == "live":
        room.agent_call_mode = "per_ant"
    if room.match_state:
        if room.participant1 and not room.match_state.participant1:
            room.match_state.participant1 = room.participant1
        if room.participant2 and not room.match_state.participant2:
            room.match_state.participant2 = room.participant2


async def _ensure_public_match_room_armed(room: GameRoom) -> None:
    if room.room_scope != "global" or room.mode != "live" or not room.colonies:
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


def _require_session_wallet_owner(request: Request, wallet: str) -> str:
    clean_wallet = _clean_wallet_or_422(wallet)
    session_wallet = _wallet_from_request(request)
    if not session_wallet:
        raise HTTPException(status_code=401, detail="Connect and sign with Phantom first.")
    if session_wallet != clean_wallet:
        raise HTTPException(status_code=403, detail="This wallet session cannot change another wallet's queen.")
    return clean_wallet


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
    request: Request,
) -> dict[str, Any]:
    _queen_store_or_503()
    clean_wallet = _require_session_wallet_owner(request, wallet)
    name = (payload.name or "").strip()[:24]
    if not name:
        raise HTTPException(status_code=422, detail="Your queen needs a name.")
    motto = (payload.motto or "").strip()[:48]
    emblem = (payload.emblem or "👑").strip()[:8] or "👑"
    return await asyncio.to_thread(
        supabase_store.upsert_queen,
        clean_wallet,
        name=name,
        motto=motto,
        emblem=emblem,
    )


@app.delete("/api/queens/{wallet}")
async def delete_queen(
    wallet: str,
    request: Request,
) -> dict[str, Any]:
    _queen_store_or_503()
    clean_wallet = _require_session_wallet_owner(request, wallet)
    await asyncio.to_thread(supabase_store.delete_queen, clean_wallet)
    return {"deleted": True, "wallet": clean_wallet}


@app.patch("/api/games/{game_id}/colonies/{colony_id}/strategy")
async def update_colony_strategy(
    game_id: str,
    colony_id: str,
    payload: UpdateColonyStrategyRequest,
    request: Request,
) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_colony_owner(room, colony_id, anonymous_id, wallet=wallet, action="update this colony")
    try:
        game_manager.harness(room.game_id).update_colony_strategy(
            colony_id,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.post("/api/games/{game_id}/rally")
async def rally(game_id: str, payload: RallyRequest, request: Request) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_colony_owner(room, payload.colonyId, anonymous_id, wallet=wallet, action="rally this colony")
    try:
        game_manager.harness(game_id).rally(payload.colonyId, payload.opportunityId)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    event = room.log[-1].public_state()
    await _sync_room_to_supabase_async(room)
    return {**room.public_state(), "event": event}


@app.post("/api/games/{game_id}/recall")
async def recall(game_id: str, payload: RecallRequest, request: Request) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_colony_owner(
        room,
        payload.colonyId,
        anonymous_id,
        wallet=wallet,
        action="recall this colony's ants",
    )
    try:
        game_manager.harness(game_id).recall(payload.colonyId, payload.opportunityId)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    event = room.log[-1].public_state()
    await _sync_room_to_supabase_async(room)
    return {**room.public_state(), "event": event}


@app.post("/api/games/{game_id}/switch-call")
async def switch_call(game_id: str, payload: SwitchCallRequest, request: Request) -> dict[str, Any]:
    room = _get_game_or_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_colony_owner(
        room,
        payload.colonyId,
        anonymous_id,
        wallet=wallet,
        action="switch this colony's call",
    )
    try:
        game_manager.harness(game_id).switch_call(payload.colonyId, payload.opportunityId, payload.optionId)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    event = room.log[-1].public_state()
    await _sync_room_to_supabase_async(room)
    return {**room.public_state(), "event": event}


@app.get("/api/games/{game_id}/colonies/{colony_id}/ants")
async def list_colony_ants(
    game_id: str,
    colony_id: str,
    request: Request,
    anonymousId: str | None = Query(default=None),
) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, anonymousId)
    _ensure_colony_owner(room, colony_id, anonymous_id, wallet=wallet, action="view these ants")
    colony = room.colonies.get(colony_id)
    if not colony:
        raise HTTPException(status_code=404, detail="Colony not found.")
    return {
        "colonyId": colony.colony_id,
        "strategyRevision": colony.strategy_revision,
        "globalStrategy": {
            "style": colony.style,
            "favoriteContext": colony.favorite_context,
            "infoNeed": colony.info_need,
        },
        "ants": [ant_public_state(ant, colony, room.event_index) for ant in colony.ants],
    }


@app.get("/api/games/{game_id}/colonies/{colony_id}/ants/{ant_id}")
async def get_ant_detail(
    game_id: str,
    colony_id: str,
    ant_id: str,
    request: Request,
    anonymousId: str | None = Query(default=None),
) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, anonymousId)
    _ensure_colony_owner(room, colony_id, anonymous_id, wallet=wallet, action="view this ant")
    await _ensure_room_log_hydrated(room)
    colony = room.colonies.get(colony_id)
    if not colony:
        raise HTTPException(status_code=404, detail="Colony not found.")
    ant = find_ant(colony, ant_id)
    if not ant:
        raise HTTPException(status_code=404, detail="Ant not found.")
    bets = ant_bet_history(room, colony.colony_id, ant.ant_id)
    return {
        "colonyId": colony.colony_id,
        "strategyRevision": colony.strategy_revision,
        "ant": ant_public_state(ant, colony, room.event_index),
        "bets": bets,
        "strategyHistory": ant_strategy_history(room, colony.colony_id, ant.ant_id),
        "summary": {
            "total": len(bets),
            "open": len([bet for bet in bets if bet["status"] == "open"]),
            "won": len([bet for bet in bets if bet["status"] == "won"]),
            "lost": len([bet for bet in bets if bet["status"] == "lost"]),
            "void": len([bet for bet in bets if bet["status"] == "void"]),
            "recalled": len([bet for bet in bets if bet["status"] == "recalled"]),
        },
    }


@app.patch("/api/games/{game_id}/colonies/{colony_id}/ants/{ant_id}/strategy")
async def update_ant_strategy(
    game_id: str,
    colony_id: str,
    ant_id: str,
    payload: UpdateAntStrategyRequest,
    request: Request,
) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_colony_owner(room, colony_id, anonymous_id, wallet=wallet, action="update this ant")
    try:
        ant = game_manager.harness(room.game_id).update_ant_strategy(
            colony_id,
            ant_id,
            style=payload.style,
            favorite_context=payload.favoriteContext,
            info_need=payload.infoNeed,
            analysis_role=payload.analysisRole,
            inherit_global=payload.inheritGlobal,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    colony = room.colonies[colony_id]
    await _sync_room_to_supabase_async(room)
    return {
        "colonyId": colony.colony_id,
        "strategyRevision": colony.strategy_revision,
        "ant": ant_public_state(ant, colony, room.event_index),
    }


@app.post("/api/games/{game_id}/start")
async def start_game(game_id: str, payload: StartGameRequest, request: Request) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    if room.room_kind == "player" and room.room_scope == "global":
        raise HTTPException(
            status_code=403,
            detail="Global match rooms start automatically at kickoff.",
        )
    _ensure_deepseek_agent()
    mode = payload.mode.strip().casefold()
    if mode not in {"replay", "live"}:
        raise HTTPException(status_code=422, detail="mode must be replay or live")
    if mode == "replay":
        require_admin_tool(request)
        wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
        _ensure_live_host(room, anonymous_id, wallet=wallet, action="start this replay")
    if not room.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before starting the match.")
    if room.status in {"running_replay", "running_live"}:
        raise HTTPException(status_code=409, detail="The game is already running.")
    if room.status == "waiting_kickoff":
        await _ensure_waiting_room_progress(room)
        return room.public_state()

    if mode == "replay":
        return await _start_replay_room(room, payload)

    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_live_host(room, anonymous_id, wallet=wallet)
    _ensure_live_room_ready(room)
    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at and kickoff_at > datetime.now(timezone.utc):
        _clear_restored_terminal_snapshot(room)
        room.mode = "live"
        room.agent_call_mode = "per_ant"
        room.status = "waiting_kickoff"
        room.add_log(
            "game_locked",
            "Room locked. Live game will start at kickoff.",
            {"mode": "live", "kickoffAt": kickoff_at.isoformat()},
        )
        _schedule_kickoff_start(room)
        await _sync_room_to_supabase_async(room)
        return room.public_state()

    room.mode = "live"
    room.agent_call_mode = "per_ant"
    await _start_live_room_now(room)
    return room.public_state()


@app.post("/api/games/{game_id}/finish")
async def finish_game(game_id: str, payload: FinishGameRequest, request: Request) -> dict[str, Any]:
    room = await _get_game_or_restore_404(game_id)
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_live_host(room, anonymous_id, wallet=wallet, action="finish the game")
    if room.status == "finished":
        return room.public_state()
    if room.status != "running_live":
        raise HTTPException(status_code=409, detail="Only a live room can be manually finished.")
    status = {
        "gameState": room.match_state.game_state if room.match_state else None,
        "statusId": room.match_state.status_id if room.match_state else None,
    }
    if not _live_status_finished(status) and not _live_auto_finish_reached(room):
        raise HTTPException(
            status_code=409,
            detail="The match is still live. Sugar markets close automatically after TXLine confirms full time.",
        )
    game_manager.harness(room.game_id).finish_game(mode="live")
    await _sync_room_to_supabase_async(room)
    return room.public_state()


def _ensure_live_host(
    room: GameRoom,
    anonymous_id: str | None,
    *,
    wallet: str | None = None,
    action: str = "start the game",
) -> None:
    if room.room_kind == "admin":
        return
    if room.owner_wallet:
        if wallet != room.owner_wallet:
            raise HTTPException(status_code=403, detail=f"Only the room host can {action}.")
        return
    if room.owner_anonymous_id:
        if (anonymous_id or "").strip() != room.owner_anonymous_id:
            raise HTTPException(status_code=403, detail=f"Only the room host can {action}.")
        return
    raise HTTPException(status_code=403, detail=f"Only an identified room host can {action}.")


def _ensure_colony_owner(
    room: GameRoom,
    colony_id: str,
    anonymous_id: str | None,
    *,
    wallet: str | None = None,
    action: str,
) -> None:
    colony = room.colonies.get(colony_id)
    if not colony:
        return
    if colony.player_wallet:
        if wallet == colony.player_wallet:
            return
        raise HTTPException(status_code=403, detail=f"Only the colony owner can {action}.")
    if not colony.player_id and not colony.player_anonymous_id:
        if room.room_kind == "admin":
            return
        raise HTTPException(status_code=403, detail=f"Only an identified colony owner can {action}.")
    clean_anonymous_id = (anonymous_id or "").strip()
    if clean_anonymous_id and clean_anonymous_id == colony.player_anonymous_id:
        return
    raise HTTPException(status_code=403, detail=f"Only the colony owner can {action}.")


def _ensure_live_room_ready(room: GameRoom) -> None:
    if not room.players:
        return
    ready_player_ids = {colony.player_id for colony in room.colonies.values() if colony.player_id}
    ready_anonymous_ids = {colony.player_anonymous_id for colony in room.colonies.values() if colony.player_anonymous_id}
    ready_wallets = {colony.player_wallet for colony in room.colonies.values() if colony.player_wallet}
    missing = [
        player.name
        for player in room.players
        if player.player_id not in ready_player_ids
        and (not player.anonymous_id or player.anonymous_id not in ready_anonymous_ids)
        and (not player.wallet or player.wallet not in ready_wallets)
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
    if _global_live_room_can_restart(room):
        previous_status = room.status
        _clear_restored_terminal_snapshot(room)
        room.status = "running_live"
        room.add_log(
            "live_sync",
            "Public live room recovered after a server restart.",
            {"mode": "live", "recovered": True, "previousStatus": previous_status},
        )
        await _sync_room_to_supabase_async(room)
    if room.status == "error" and room.mode == "live":
        if getattr(room, "_aoc_restored_terminal", False):
            return
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


def _clear_restored_terminal_snapshot(room: GameRoom) -> None:
    for attribute in ("_aoc_restored_terminal", "_aoc_restored_public_state"):
        if hasattr(room, attribute):
            delattr(room, attribute)


async def _start_live_room_now(room: GameRoom) -> None:
    _clear_restored_terminal_snapshot(room)
    room.mode = "live"
    room.status = "running_live"
    room.agent_call_mode = "per_ant"
    room.add_log("game_started", "Live game connected to TXLine updates.", {"mode": "live"})
    _ensure_live_task(room)
    await _sync_room_to_supabase_async(room)


@app.post("/api/games/{game_id}/rerun")
async def rerun_game(game_id: str, payload: StartGameRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
    old_room = await _get_game_or_restore_404(game_id)
    if old_room.room_kind == "player" and old_room.room_scope == "global":
        raise HTTPException(
            status_code=403,
            detail="Global match rooms cannot be rerun manually.",
        )
    _ensure_deepseek_agent()
    wallet, anonymous_id = _request_player_identity(request, payload.anonymousId)
    _ensure_live_host(old_room, anonymous_id, wallet=wallet, action="rerun this replay")
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
        competition=old_room.competition,
        start_time=old_room.start_time,
        start_time_iso=old_room.start_time_iso,
        seed=old_room.seed,
        owner_anonymous_id=old_room.owner_anonymous_id,
        owner_wallet=old_room.owner_wallet,
        owner_name=old_room.owner_name,
        room_kind=old_room.room_kind,
        room_scope=old_room.room_scope,
        txline_validation=old_room.txline_validation,
    )
    harness = game_manager.harness(room.game_id)
    for player in old_room.players:
        harness.join_player(player.name, anonymous_id=player.anonymous_id, wallet=player.wallet)
    for colony in old_room.colonies.values():
        cloned_colony = harness.add_colony(
            colony.name,
            colony.size,
            colony.style,
            colony.favorite_context,
            colony.info_need,
            anonymous_id=colony.player_anonymous_id,
            wallet=colony.player_wallet,
            player_id=colony.player_id,
        )
        cloned_colony.strategy_revision = colony.strategy_revision
        cloned_colony.seed = colony.seed
        cloned_colony.ants = [
            clone_ant_for_new_match(ant)
            for ant in colony.ants[: colony.size]
        ]
        carried_ant_ids: list[str] = []
        for ant in cloned_colony.ants:
            if not any(
                (
                    ant.style_override,
                    ant.favorite_context_override,
                    ant.info_need_override,
                    ant.analysis_role_override,
                )
            ):
                continue
            carried_ant_ids.append(ant.ant_id)
            room.add_log(
                "ant_strategy_updated",
                f"{cloned_colony.name} carries {ant.ant_id}'s custom orders into the rerun.",
                {
                    "colonyId": cloned_colony.colony_id,
                    "antId": ant.ant_id,
                    "strategy": ant_strategy_state(ant, cloned_colony),
                    "strategyRevision": cloned_colony.strategy_revision,
                    "carriedForward": True,
                    "sourceGameId": old_room.game_id,
                    "sourceColonyId": colony.colony_id,
                },
            )
        if carried_ant_ids:
            room.add_log(
                "strategy_carried_forward",
                f"{cloned_colony.name} keeps {len(carried_ant_ids)} individual ant strategies for the rerun.",
                {
                    "colonyId": cloned_colony.colony_id,
                    "antIds": carried_ant_ids,
                    "strategyRevision": cloned_colony.strategy_revision,
                    "sourceGameId": old_room.game_id,
                },
            )
    room.mode = "replay"
    room.agent_call_mode = payload.agentCallMode
    return await _start_replay_room(room, payload)


@app.post("/api/admin/rooms")
async def create_admin_room(payload: AdminRoomRequest, request: Request) -> dict[str, Any]:
    require_admin_tool(request)
    if not payload.colonies:
        raise HTTPException(status_code=422, detail="Add at least one colony before creating an admin room.")

    request_key = (payload.requestKey or "").strip()
    if request_key:
        fingerprint = _admin_room_payload_fingerprint(payload)
        with _admin_room_request_lock:
            cached = _admin_room_request_cache.get(request_key)
            existing_room = game_manager.get_room(cached[1]) if cached else None
            if cached and existing_room:
                if cached[0] != fingerprint:
                    raise HTTPException(status_code=409, detail="This admin room request key is already attached to another setup.")
                room = existing_room
            else:
                if cached:
                    _admin_room_request_cache.pop(request_key, None)
                room = _build_admin_room(payload)
                if len(_admin_room_request_cache) >= ADMIN_ROOM_REQUEST_CACHE_LIMIT:
                    _admin_room_request_cache.pop(next(iter(_admin_room_request_cache)))
                _admin_room_request_cache[request_key] = (fingerprint, room.game_id)
    else:
        room = _build_admin_room(payload)

    await _sync_room_to_supabase_async(room)
    return room.public_state()


def _admin_room_payload_fingerprint(payload: AdminRoomRequest) -> str:
    canonical = json.dumps(
        payload.model_dump(mode="json", exclude={"requestKey"}),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _build_admin_room(payload: AdminRoomRequest) -> GameRoom:
    room = game_manager.create_room(
        fixture_id=payload.fixtureId,
        participant1=payload.participant1,
        participant2=payload.participant2,
        competition=payload.competition,
        start_time=payload.startTime,
        start_time_iso=payload.startTimeIso,
        txline_validation=_txline_validation_cache.get(str(payload.fixtureId)),
        seed=payload.seed,
        room_kind="admin",
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
    return room


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

    async def inspect_fixture(fixture: dict[str, Any]) -> tuple[bool, dict[str, Any] | None]:
        fixture_id = fixture.get("fixtureId")
        if fixture_id is None:
            return False, None
        try:
            source_records: dict[str, list[dict[str, Any]]] = {
                "historical": [],
                "updates": [],
                "snapshot": [],
            }
            for source_name, fetcher in (
                ("historical", client.score_historical),
                ("updates", client.score_updates),
                ("snapshot", client.score_snapshot),
            ):
                try:
                    async with asyncio.timeout(3):
                        records = await fetcher(int(fixture_id))
                except (httpx.HTTPError, TimeoutError):
                    continue
                source_records[source_name] = records if isinstance(records, list) else []
                if source_records[source_name]:
                    break
        except (TypeError, ValueError):
            return True, None
        chosen_source, records = _choose_best_source(source_records)
        if not records:
            return True, None
        enriched = dict(fixture)
        enriched.update(
            {
                "playable": True,
                "source": chosen_source,
                "eventCount": len(records),
                "sourceCounts": {name: len(items) for name, items in source_records.items()},
            }
        )
        return True, enriched

    # A completed fixture normally has historical data, so inspect one source at
    # a time and fan out across fixtures. This keeps the admin's first load well
    # below the frontend proxy timeout without changing the final proof check.
    batch_size = 24
    for start in range(0, len(fixtures), batch_size):
        batch = fixtures[start : start + batch_size]
        results = await asyncio.gather(*(inspect_fixture(fixture) for fixture in batch))
        inspected += sum(int(was_inspected) for was_inspected, _ in results)
        for _was_inspected, enriched in results:
            if enriched is not None:
                playable.append(enriched)
            if len(playable) >= limit:
                break
        if len(playable) >= limit:
            break

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


@app.post("/api/admin/fixtures/{fixture_id}/txline-validation")
async def validate_admin_fixture_with_txline(
    fixture_id: int,
    request: Request,
    participant1: str | None = Query(default=None),
    participant2: str | None = Query(default=None),
) -> dict[str, Any]:
    require_admin_tool(request)
    try:
        result = await _txline_fixture_validation(
            fixture_id,
            participant1=participant1,
            participant2=participant2,
        )
    except TxLineOnChainValidationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    _remember_txline_validation(fixture_id, result)
    return result


async def _txline_fixture_validation(
    fixture_id: int,
    *,
    participant1: str | None = None,
    participant2: str | None = None,
    client: TxLineClient | None = None,
) -> dict[str, Any]:
    settings = client.settings if client is not None else TxLineSettings.from_env()
    network = txline_network(settings.base_url)
    client = client or TxLineClient(settings)
    records = await client.score_historical(fixture_id)
    finalized = find_finalized_score_record(records)
    if finalized is None:
        return {
            "status": "pending",
            "verified": False,
            "fixtureId": fixture_id,
            "network": network,
            "participant1": participant1,
            "participant2": participant2,
            "historyCount": len(records),
            "reason": "No game_finalised record with statusId=100 is available yet.",
        }

    raw_seq = finalized.get("Seq") if finalized.get("Seq") is not None else finalized.get("seq")
    try:
        seq = int(raw_seq)
    except (TypeError, ValueError) as exc:
        raise TxLineOnChainValidationError("The final TxLINE score record has no valid sequence number.") from exc

    proof = await client.score_stat_validation(fixture_id, seq, (1, 2))
    if not proof:
        raise TxLineOnChainValidationError("TxLINE returned no stat-validation proof for the final score.")
    onchain = await validate_txline_proof_onchain(proof, network=network)

    stats = onchain.get("stats") if isinstance(onchain.get("stats"), list) else proof.get("statsToProve", [])
    score = final_score_from_stats(stats)
    winner = winner_from_score(score)
    winner_label = participant1 if winner == "participant1" else participant2 if winner == "participant2" else "Draw" if winner == "draw" else None
    verified = bool(onchain.get("verified"))
    return {
        "status": "verified" if verified else "failed",
        "verified": verified,
        "fixtureId": fixture_id,
        "network": network,
        "participant1": participant1,
        "participant2": participant2,
        "seq": seq,
        "action": finalized.get("Action") or finalized.get("action"),
        "statusId": finalized.get("StatusId") if finalized.get("StatusId") is not None else finalized.get("statusId"),
        "finalizedAt": epoch_to_iso(finalized.get("Ts") or finalized.get("ts")),
        "score": score,
        "winner": winner,
        "winnerLabel": winner_label,
        "stats": stats,
        "programId": onchain.get("programId"),
        "dailyScoresPda": onchain.get("dailyScoresPda"),
        "rootAccountExists": bool(onchain.get("rootAccountExists")),
        "rootAccountOwner": onchain.get("rootAccountOwner"),
        "epochDay": onchain.get("epochDay"),
        "method": "validateStatV2",
        "mode": "read-only simulation",
    }


def _remember_txline_validation(fixture_id: int | str, result: dict[str, Any]) -> None:
    if result.get("verified"):
        _txline_validation_cache[str(fixture_id)] = dict(result)
    else:
        _txline_validation_cache.pop(str(fixture_id), None)


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
            room_kind="admin",
        )
        harness = game_manager.harness(room.game_id)
        _add_run_previous_colonies(harness, payload.colonies)
        room.mode = "replay"
        room.agent_call_mode = payload.agentCallMode
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
            await _sync_room_to_supabase_async(room)
            _schedule_replay_task(
                room,
                timeline["events"],
                delay_seconds=payload.replayDelaySeconds,
                time_scale=payload.replayTimeScale,
            )
            return room.public_state()

        await asyncio.to_thread(harness.process_events, timeline["events"])
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
        room_kind="admin",
    )
    harness = game_manager.harness(room.game_id)
    _add_autorun_colonies(harness)
    room.mode = "replay"
    room.agent_call_mode = "per_ant"
    events = demo_events(room.fixture_id)
    room.add_log(
        "game_started",
        f"Demo run started on {fixture['participant1']} - {fixture['participant2']} with {len(events)} events.",
        {"mode": "replay", "source": "demo", "rawCount": len(events)},
    )
    await asyncio.to_thread(harness.process_events, events)
    await _sync_room_to_supabase_async(room)
    return room.public_state()


@app.get("/api/admin/games")
async def admin_games(request: Request, limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    require_admin_tool(request)
    if not supabase_store.configured:
        games = [
            room.public_state()
            for room in game_manager.rooms.values()
            if room.room_kind == "admin"
        ]
        games.sort(key=lambda item: item.get("eventIndex", 0), reverse=True)
        return {
            "source": "memory",
            "configured": False,
            "count": len(games[:limit]),
            "games": games[:limit],
            "hint": "Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist admin games.",
        }
    list_admin_games = getattr(supabase_store, "list_admin_games", None)
    list_stored_games = list_admin_games if callable(list_admin_games) else supabase_store.list_games
    stored_payload = await asyncio.to_thread(list_stored_games, limit=limit)
    payload = stored_payload if isinstance(stored_payload, dict) else {}
    stored_games = payload.get("games")
    if not isinstance(stored_games, list):
        stored_games = []
    games: list[dict[str, Any]] = []
    stored_timestamps: dict[str, float] = {}
    for index, row in enumerate(stored_games):
        game = _admin_game_public_state(row, admin_only=True)
        if not game:
            continue
        games.append(game)
        stored_timestamps[game["gameId"]] = _admin_row_timestamp(row, fallback=-float(index))
    games = await _stop_orphaned_admin_runs(games)

    memory_rooms = {
        game_id: room
        for game_id, room in game_manager.rooms.items()
        if room.room_kind == "admin"
    }
    merged_entries: list[tuple[float, dict[str, Any]]] = []
    seen_game_ids: set[str] = set()
    for stored_game in games:
        game_id = str(stored_game.get("gameId") or "")
        if not game_id or game_id in seen_game_ids:
            continue
        memory_room = memory_rooms.get(game_id)
        state = memory_room.public_state() if memory_room else stored_game
        timestamp = stored_timestamps.get(game_id, 0.0)
        if memory_room:
            timestamp = max(timestamp, _admin_room_timestamp(memory_room))
        merged_entries.append((timestamp, state))
        seen_game_ids.add(game_id)

    # A failed persistence attempt must not make a room disappear. Merge by
    # last activity so an old in-memory room cannot hide a newer stored one.
    for game_id, room in memory_rooms.items():
        if game_id in seen_game_ids:
            continue
        merged_entries.append((_admin_room_timestamp(room), room.public_state()))
    merged_entries.sort(key=lambda entry: entry[0], reverse=True)
    merged_games = [state for _, state in merged_entries[:limit]]
    return {**payload, "count": len(merged_games), "games": merged_games}


async def _stop_orphaned_admin_runs(stored_games: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stop persisted workers with no task in this single-worker process."""
    updated_games: list[dict[str, Any]] = []
    for stored_game in stored_games:
        if room_kind_from_snapshot(stored_game) != "admin":
            continue
        status = stored_game.get("status")
        is_orphan_candidate = status in {"running_replay", "running_live"}
        game_id = str(stored_game.get("gameId") or "")
        memory_room = game_manager.get_room(game_id) if game_id else None
        has_admin_worker = memory_room is not None and memory_room.room_kind == "admin"
        if not is_orphan_candidate or not game_id or has_admin_worker:
            updated_games.append(stored_game)
            continue
        try:
            stopped = await asyncio.to_thread(supabase_store.mark_game_stopped, stored_game)
        except (AttributeError, SupabasePersistenceError):
            stopped = None
        if not stopped:
            updated_games.append(stored_game)
            continue
        updated_games.append(redact_public_identity(stopped))
    return updated_games


def _admin_row_timestamp(row: Any, *, fallback: float = 0.0) -> float:
    if not isinstance(row, dict):
        return fallback
    value = row.get("updated_at") or row.get("completed_at") or row.get("created_at")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return fallback
    return fallback


def _admin_room_timestamp(room: GameRoom) -> float:
    return float(room.log[-1].created_at) if room.log else 0.0


def _admin_game_public_state(row: Any, *, admin_only: bool = False) -> dict[str, Any] | None:
    """Flatten a persisted Supabase row into the public GameState contract."""
    if not isinstance(row, dict):
        return None
    stored_public_state = row.get("public_state")
    state = dict(stored_public_state) if isinstance(stored_public_state, dict) else {}
    game_id = state.get("gameId") or row.get("game_id") or row.get("gameId")
    if not game_id:
        return None

    fallback_fields = {
        "fixtureId": "fixture_id",
        "participant1": "participant1",
        "participant2": "participant2",
        "status": "status",
        "mode": "mode",
        "eventIndex": "event_index",
        "agentUsage": "agent_usage",
    }
    for public_key, stored_key in fallback_fields.items():
        if state.get(public_key) is None and row.get(stored_key) is not None:
            state[public_key] = row[stored_key]

    state["gameId"] = str(game_id)
    state["roomKind"] = room_kind_from_snapshot({**row, **state})
    if state["roomKind"] == "player":
        state["roomScope"] = room_scope_from_snapshot({**row, **state})
    else:
        state.pop("roomScope", None)
    if admin_only and state["roomKind"] != "admin":
        return None
    state["status"] = str(state.get("status") or "created")
    try:
        state["eventIndex"] = int(state.get("eventIndex") or 0)
    except (TypeError, ValueError):
        state["eventIndex"] = 0
    for collection_key in ("players", "colonies", "activeOpportunities"):
        if not isinstance(state.get(collection_key), list):
            state[collection_key] = []
    if not isinstance(state.get("match"), dict):
        state["match"] = {"score": None}
    return redact_public_identity(state)


def _stored_game_can_resume_live(stored_game: dict[str, Any]) -> bool:
    if stored_game.get("status") == "waiting_kickoff":
        return True
    if stored_game.get("status") not in {"running_live", "stopped", "error"}:
        return False
    if stored_game.get("mode") != "live":
        return False
    if room_kind_from_snapshot(stored_game) != "player":
        return False
    if room_scope_from_snapshot(stored_game) != "global":
        return False
    if not stored_game.get("colonies"):
        return False
    return _live_match_snapshot_in_progress(stored_game.get("match"))


def _stored_game_has_orphaned_worker(stored_game: dict[str, Any]) -> bool:
    return (
        stored_game.get("status") in {"running_replay", "running_live"}
        and not _stored_game_can_resume_live(stored_game)
    )


def _live_match_snapshot_in_progress(match: Any) -> bool:
    if not isinstance(match, dict):
        return False
    state = _normalize_live_game_state(match.get("gameState"))
    status_id = _safe_int(match.get("statusId"))
    if state in LIVE_FINAL_GAME_STATES or status_id in LIVE_FINAL_STATUS_IDS:
        return False
    if state in LIVE_WAITING_GAME_STATES or status_id in LIVE_WAITING_STATUS_IDS:
        return False
    return bool(state or status_id is not None)


def _global_live_room_can_restart(room: GameRoom) -> bool:
    if room.status not in {"stopped", "error"}:
        return False
    if room.room_kind != "player" or room.room_scope != "global" or room.mode != "live":
        return False
    if not room.colonies or not room.match_state:
        return False
    return _live_match_snapshot_in_progress(
        {
            "gameState": room.match_state.game_state,
            "statusId": room.match_state.status_id,
        }
    )


async def _mark_orphaned_stored_game(
    stored_game: dict[str, Any],
    *,
    public: bool = True,
) -> dict[str, Any]:
    stopped_state = dict(stored_game)
    stopped_state["status"] = "stopped"
    try:
        persisted = await asyncio.to_thread(supabase_store.mark_game_stopped, stored_game)
    except (AttributeError, SupabasePersistenceError):
        persisted = None
    state = persisted if isinstance(persisted, dict) else stopped_state
    return redact_public_identity(state) if public else state


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
        if _stored_game_has_orphaned_worker(stored_game):
            return await _mark_orphaned_stored_game(stored_game)
        can_restore = _stored_game_can_resume_live(stored_game) or stored_status not in {"finished", "stopped", "error"}
        if can_restore:
            room = _restore_room_from_stored_row(
                {**((replay.get("stored") or {}).get("game") or {}), "public_state": stored_game},
                events=replay.get("events") or [],
            )
            await _ensure_room_progress(room)
            return room.public_state()
        return redact_public_identity(stored_game)
    raise HTTPException(status_code=404, detail="Game not found.")


@app.get("/api/games/{game_id}/replay")
async def game_replay(game_id: str) -> dict[str, Any]:
    room = game_manager.get_room(game_id)
    if not room:
        replay = await _stored_replay_or_none(game_id)
        if replay:
            stored_game = replay["game"]
            if _stored_game_has_orphaned_worker(stored_game):
                replay["game"] = await _mark_orphaned_stored_game(stored_game)
                return _public_stored_replay(replay)
            if _stored_game_can_resume_live(stored_game):
                room = _restore_room_from_stored_row(
                    {**((replay.get("stored") or {}).get("game") or {}), "public_state": stored_game},
                    events=replay.get("events") or [],
                )
            else:
                return _public_stored_replay(replay)
        else:
            raise HTTPException(status_code=404, detail="Game not found.")
    await _ensure_room_log_hydrated(room)
    await _ensure_room_progress(room)
    return {
        "game": room.public_state(),
        "events": [event.public_state() for event in room.log],
    }


def _public_stored_replay(replay: dict[str, Any]) -> dict[str, Any]:
    """Expose replay content without Supabase rows or legacy bearer IDs."""

    return {
        "game": redact_public_identity(replay.get("game") or {}),
        "events": redact_public_identity(replay.get("events") or []),
    }


@app.get("/api/games/{game_id}/events")
async def game_events(game_id: str) -> StreamingResponse:
    room = game_manager.get_room(game_id)
    if not room:
        replay = await _stored_replay_or_none(game_id)
        if not replay:
            raise HTTPException(status_code=404, detail="Game not found.")
        stored_game = replay["game"]
        if _stored_game_has_orphaned_worker(stored_game):
            await _mark_orphaned_stored_game(stored_game)
            raise HTTPException(status_code=409, detail="Live event stream stopped after server restoration.")
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
    results = await asyncio.gather(
        client.score_historical(fixture_id),
        client.score_updates(fixture_id),
        client.score_snapshot(fixture_id),
        return_exceptions=True,
    )
    sources: dict[str, list[dict[str, Any]]] = {}
    errors: list[Exception] = []
    successful_source = False
    for name, result in zip(("historical", "updates", "snapshot"), results, strict=True):
        if isinstance(result, asyncio.CancelledError):
            raise result
        if isinstance(result, Exception):
            errors.append(result)
            sources[name] = []
            continue
        successful_source = True
        sources[name] = result if isinstance(result, list) else []

    if not successful_source and errors:
        raise errors[0]
    return sources


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
        if room.room_kind != "player" or room.room_scope != "private":
            raise HTTPException(status_code=404, detail="Private room code not found.")
        return room
    stored = await _stored_room_by_code_or_none(clean_room_code)
    if stored:
        stored_state = _admin_game_public_state(stored)
        if stored_state and _stored_game_has_orphaned_worker(stored_state):
            stored_state = await _mark_orphaned_stored_game(stored_state, public=False)
            stored = {**stored, "public_state": stored_state}
        room = _restore_room_from_stored_row(stored)
        if room.room_kind != "player" or room.room_scope != "private":
            raise HTTPException(status_code=404, detail="Private room code not found.")
        await _ensure_room_log_hydrated(room)
        return room
    raise HTTPException(status_code=404, detail="Room code not found.")


async def _get_game_or_restore_404(game_id: str):
    room = game_manager.get_room(game_id)
    if room:
        return room
    replay = await _stored_replay_or_none(game_id)
    if replay:
        stored_row = (replay.get("stored") or {}).get("game") or {}
        stored_state = replay.get("game") or stored_row.get("public_state") or stored_row
        if _stored_game_has_orphaned_worker(stored_state):
            stored_state = await _mark_orphaned_stored_game(stored_state, public=False)
        room = _restore_room_from_stored_row(
            {**stored_row, "public_state": stored_state},
            events=replay.get("events") or [],
        )
        return room
    raise HTTPException(status_code=404, detail="Game not found.")


def _restore_room_from_stored_row(row: dict[str, Any], *, events: list[dict[str, Any]] | None = None):
    public_state = row.get("public_state") or row
    game_id = public_state.get("gameId") or row.get("game_id")
    if not game_id:
        raise HTTPException(status_code=404, detail="Game not found.")
    existing = game_manager.get_room(str(game_id))
    if existing:
        _merge_restored_events(existing, events or [])
        _restore_live_market_positions(existing, public_state)
        if events is not None:
            setattr(existing, "_aoc_log_hydrated", True)
        return existing

    owner = public_state.get("owner") or {}
    private_state = public_state.get(PRIVATE_SNAPSHOT_KEY)
    if not isinstance(private_state, dict):
        private_state = {}
    private_player_anonymous_ids = private_state.get("playerAnonymousIds")
    if not isinstance(private_player_anonymous_ids, dict):
        private_player_anonymous_ids = {}
    private_colony_anonymous_ids = private_state.get("colonyAnonymousIds")
    if not isinstance(private_colony_anonymous_ids, dict):
        private_colony_anonymous_ids = {}
    private_ant_profiles = private_state.get("antProfiles")
    if not isinstance(private_ant_profiles, dict):
        private_ant_profiles = {}
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
        txline_validation=public_state.get("txlineValidation") if isinstance(public_state.get("txlineValidation"), dict) else None,
        owner_anonymous_id=(owner.get("anonymousId") if isinstance(owner, dict) else None)
        or private_state.get("ownerAnonymousId")
        or row.get("owner_anonymous_id"),
        owner_wallet=(owner.get("wallet") if isinstance(owner, dict) else None) or row.get("owner_wallet"),
        owner_name=owner.get("name") if isinstance(owner, dict) else None,
        room_kind=room_kind_from_snapshot({**row, **public_state, "events": events or []}),
        room_scope=room_scope_from_snapshot({**row, **public_state, "events": events or []}),
        seed=clean_seed,
    )
    room.status = public_state.get("status") or row.get("status") or "created"
    room.mode = public_state.get("mode") or row.get("mode")
    if room.status in {"finished", "stopped", "error"}:
        setattr(room, "_aoc_restored_terminal", True)
        setattr(room, "_aoc_restored_public_state", json.loads(json.dumps(public_state)))
    stored_agent_call_mode = public_state.get("agentCallMode")
    room.agent_call_mode = stored_agent_call_mode if stored_agent_call_mode in {"per_ant", "batch"} else None
    room.event_index = int(public_state.get("eventIndex") or row.get("event_index") or 0)
    stored_match = public_state.get("match")
    if room.match_state and isinstance(stored_match, dict):
        room.match_state.score = stored_match.get("score")
        room.match_state.game_state = stored_match.get("gameState")
        room.match_state.status_id = stored_match.get("statusId")
        room.match_state.possession_label = stored_match.get("possessionLabel")
    stored_agent_usage = public_state.get("agentUsage") or row.get("agent_usage")
    room.agent_usage = dict(stored_agent_usage) if isinstance(stored_agent_usage, dict) else None
    for player in public_state.get("players") or []:
        if not isinstance(player, dict):
            continue
        player_id = str(player.get("playerId") or f"player_{len(room.players) + 1}")
        room.players.append(
            PlayerState(
                player_id=player_id,
                name=str(player.get("name") or f"Player {len(room.players) + 1}")[:32],
                anonymous_id=(
                    str(player.get("anonymousId") or private_player_anonymous_ids.get(player_id))[:80]
                    if player.get("anonymousId") or private_player_anonymous_ids.get(player_id)
                    else None
                ),
                wallet=str(player.get("wallet"))[:80] if player.get("wallet") else None,
            )
        )
    for colony_state in public_state.get("colonies") or []:
        if not isinstance(colony_state, dict):
            continue
        colony_id = str(colony_state.get("colonyId") or f"col_{len(room.colonies) + 1}")
        try:
            stored_sugar = colony_state.get("sugar", colony_state.get("food"))
            food = int(stored_sugar) if stored_sugar is not None else STARTING_COLONY_FOOD
        except (TypeError, ValueError):
            food = STARTING_COLONY_FOOD
        economy = colony_state.get("economy") if isinstance(colony_state.get("economy"), dict) else {}
        stored_reserved = colony_state.get("sugarReserved")
        if stored_reserved is None:
            stored_reserved = colony_state.get("foodReserved")
        if stored_reserved is None:
            stored_reserved = economy.get("reserved", economy.get("sugarReserved", economy.get("foodReserved")))
        try:
            food_reserved = max(0, min(food, int(stored_reserved))) if stored_reserved is not None else 0
        except (TypeError, ValueError):
            food_reserved = 0
        colony = ColonyState(
            colony_id=colony_id,
            name=str(colony_state.get("name") or f"Colony {len(room.colonies) + 1}")[:40],
            size=STARTING_COLONY_ANTS,
            style=str(colony_state.get("style") or "balanced"),
            favorite_context=str(colony_state.get("favoriteContext") or "balanced"),
            info_need=str(colony_state.get("infoNeed") or "medium"),
            seed=_safe_int(colony_state.get("simulationSeed")) or clean_seed,
            player_id=str(colony_state.get("playerId"))[:80] if colony_state.get("playerId") else None,
            player_anonymous_id=(
                str(
                    colony_state.get("playerAnonymousId")
                    or private_colony_anonymous_ids.get(colony_id)
                )[:80]
                if colony_state.get("playerAnonymousId")
                or private_colony_anonymous_ids.get(colony_id)
                else None
            ),
            player_wallet=str(colony_state.get("playerWallet"))[:80] if colony_state.get("playerWallet") else None,
            food=food,
            food_reserved=food_reserved,
            larvae=0,
            last_food_event_index=room.event_index,
            strategy_revision=max(0, _safe_int(colony_state.get("strategyRevision")) or 0),
        )
        colony.ants = generate_ants(colony)
        ant_profiles = private_ant_profiles.get(colony_id)
        if not isinstance(ant_profiles, dict):
            # Transitional snapshots briefly stored profiles alongside the
            # public colony state. Read them, but never expose them again.
            ant_profiles = colony_state.get("antProfiles") or {}
        if isinstance(ant_profiles, dict):
            for ant in colony.ants:
                restore_ant_profile(ant, ant_profiles.get(ant.ant_id))
        colony.memory.food_net = (
            _safe_int(colony_state.get("sugarNet"))
            or _safe_int(colony_state.get("foodNet"))
            or _safe_int(economy.get("net"))
            or 0
        )
        colony.memory.wins = max(0, _safe_int(colony_state.get("wins")) or 0)
        colony.memory.losses = max(0, _safe_int(colony_state.get("losses")) or 0)
        colony.memory.attempts = colony.memory.wins + colony.memory.losses
        colony.memory.info_purchases = max(0, _safe_int(colony_state.get("infoPurchases")) or 0)
        ant_strategies = colony_state.get("antStrategies") or {}
        if isinstance(ant_strategies, dict):
            ants_by_id = {ant.ant_id: ant for ant in colony.ants}
            for ant_id, strategy in ant_strategies.items():
                ant = ants_by_id.get(str(ant_id))
                if not ant or not isinstance(strategy, dict):
                    continue
                ant.style_override = strategy.get("style") or None
                ant.favorite_context_override = strategy.get("favoriteContext") or None
                ant.info_need_override = strategy.get("infoNeed") or None
                stored_analysis_role = strategy.get("analysisRole")
                ant.analysis_role_override = (
                    str(stored_analysis_role)
                    if stored_analysis_role in {"reactive", "statistical", "situational"}
                    else ant.analysis_role_override
                )
        room.colonies[colony.colony_id] = colony
    _merge_restored_events(room, events or [])
    _restore_live_market_positions(room, public_state)
    if events is not None:
        setattr(room, "_aoc_log_hydrated", True)
    return game_manager.register_room(room)


_RESTORABLE_MARKET_CONTEXTS = (
    "penalties",
    "goal_next_10",
    "next_goal_team",
    "next_corner",
    "next_card",
    "next_substitution",
    "next_free_kick",
    "next_yellow_card",
    "next_foul",
)


def _restore_live_market_positions(room: GameRoom, public_state: dict[str, Any] | None = None) -> int:
    """Rebuild open live positions from the durable snapshot and game journal.

    Public game snapshots deliberately contain no prediction ledger. The journal is
    therefore the source of truth for entries and resolutions, while
    ``activeOpportunities`` limits reconstruction to markets that were still open at
    the snapshot boundary. The function is safe to call again after delayed log
    hydration: already-restored objects are replaced by the same durable ids and
    colony reserves are recomputed rather than incremented.
    """
    snapshot = public_state if isinstance(public_state, dict) else {}
    nested_snapshot = snapshot.get("public_state")
    if isinstance(nested_snapshot, dict):
        snapshot = nested_snapshot

    active_value = snapshot.get("activeOpportunities")
    has_active_snapshot = isinstance(active_value, list)
    active_markets = {
        str(item.get("opportunityId")): item
        for item in (active_value or [])
        if isinstance(item, dict) and item.get("opportunityId")
    }
    active_ids = set(active_markets)

    journal_markets: dict[str, dict[str, Any]] = {}
    prediction_states: dict[str, dict[str, Any]] = {}
    resolved_prediction_ids: set[str] = set()
    for event in sorted(room.log, key=lambda item: item.index):
        data = event.data if isinstance(event.data, dict) else {}
        if event.kind == "opportunity":
            market = data.get("opportunity")
            if isinstance(market, dict) and market.get("opportunityId"):
                journal_markets[str(market["opportunityId"])] = market
            continue
        prediction_id = str(data.get("predictionId") or "")
        if event.kind == "prediction" and prediction_id:
            prediction_states[prediction_id] = dict(data)
        elif event.kind in {"rally", "recall", "switch"} and prediction_id in prediction_states:
            state = prediction_states[prediction_id]
            for key in ("antIds", "option", "sugarReserved", "foodReserved"):
                if data.get(key) is not None:
                    state[key] = data[key]
        elif event.kind in {"settlement", "void"} and prediction_id:
            resolved_prediction_ids.add(prediction_id)

    restored_prediction_ids = set(getattr(room, "_aoc_restored_prediction_ids", set()))
    restored_opportunity_ids = set(getattr(room, "_aoc_restored_opportunity_ids", set()))
    for prediction_id in resolved_prediction_ids:
        existing_prediction = room.predictions.get(prediction_id)
        if existing_prediction:
            existing_prediction.resolved = True
    if has_active_snapshot:
        # The snapshot is the authoritative open-market boundary. This also
        # handles a journal that is hydrated incrementally: positions restored
        # from an earlier page must not keep collateral locked after their
        # market disappears from the newer snapshot.
        for prediction_id in restored_prediction_ids:
            prediction = room.predictions.get(prediction_id)
            if prediction and prediction.opportunity_id not in active_ids:
                prediction.resolved = True
        for opportunity_id in restored_opportunity_ids - active_ids:
            room.opportunities.pop(opportunity_id, None)
        restored_opportunity_ids.intersection_update(active_ids)

    # Restore every market explicitly active in the snapshot, including observed
    # markets with no funded colony position.
    for opportunity_id, market in active_markets.items():
        opportunity = _restored_opportunity(room, opportunity_id, market)
        if opportunity:
            room.opportunities[opportunity_id] = opportunity
            restored_opportunity_ids.add(opportunity_id)
            _remember_restored_opportunity_slot(room, opportunity)

    restored_count = 0
    for prediction_id, data in prediction_states.items():
        if prediction_id in resolved_prediction_ids or prediction_id in room.predictions:
            continue
        opportunity_id = str(data.get("opportunityId") or "")
        colony_id = str(data.get("colonyId") or "")
        if not opportunity_id or colony_id not in room.colonies:
            continue
        if has_active_snapshot and opportunity_id not in active_ids:
            continue

        market = data.get("market") if isinstance(data.get("market"), dict) else None
        market = market or active_markets.get(opportunity_id) or journal_markets.get(opportunity_id) or {}
        opportunity = room.opportunities.get(opportunity_id) or _restored_opportunity(
            room,
            opportunity_id,
            market,
            prediction_data=data,
        )
        if not opportunity:
            continue
        room.opportunities[opportunity_id] = opportunity
        restored_opportunity_ids.add(opportunity_id)
        _remember_restored_opportunity_slot(room, opportunity)

        option_data = data.get("option") if isinstance(data.get("option"), dict) else {}
        canonical_option = next(
            (
                option
                for option in opportunity.options
                if option.option_id == str(option_data.get("optionId") or option_data.get("option_id") or "")
            ),
            None,
        )
        option = _restored_market_option(option_data, canonical_option, context=opportunity.context)
        if not option:
            continue
        for index, candidate in enumerate(opportunity.options):
            if candidate.option_id == option.option_id:
                opportunity.options[index] = option
                break
        else:
            opportunity.options.append(option)

        reserved = _first_restored_int(
            data.get("sugarReserved"),
            data.get("foodReserved"),
            data.get("riskSugar"),
        )
        reserved = reserved if reserved is not None and reserved > 0 else MARKET_RISK_SUGAR
        created_event_index = _first_restored_int(data.get("createdEventIndex"), opportunity.created_event_index)
        ant_ids = [str(value) for value in data.get("antIds", [])] if isinstance(data.get("antIds"), list) else []
        prediction = Prediction(
            prediction_id=prediction_id,
            colony_id=colony_id,
            opportunity_id=opportunity_id,
            option=option,
            ant_ids=ant_ids,
            created_event_index=min(room.event_index, created_event_index or room.event_index),
            deadline_clock=opportunity.deadline_clock,
            deadline_event_index=opportunity.deadline_event_index,
            info_bought=bool(data.get("infoBought")),
            reserved_food=reserved,
            support_fraction=_restored_float(data.get("supportFraction", data.get("consensus")), 0.0),
            entry_threshold=_restored_float(data.get("entryThreshold"), 0.0),
            rallied=bool(data.get("rallied")),
            switched=bool(data.get("switched")),
        )
        room.predictions[prediction_id] = prediction
        restored_prediction_ids.add(prediction_id)
        restored_count += 1

    # Once at least one prediction journal entry is available, its open/resolved
    # ledger supersedes the aggregate reserve stored in the colony snapshot.
    if prediction_states:
        for colony in room.colonies.values():
            colony.food_reserved = sum(
                prediction.reserved_food
                for prediction in room.predictions.values()
                if prediction.colony_id == colony.colony_id and not prediction.resolved
            )
    setattr(room, "_aoc_restored_prediction_ids", restored_prediction_ids)
    setattr(room, "_aoc_restored_opportunity_ids", restored_opportunity_ids)
    return restored_count


def _restored_opportunity(
    room: GameRoom,
    opportunity_id: str,
    market: dict[str, Any],
    *,
    prediction_data: dict[str, Any] | None = None,
) -> Opportunity | None:
    context = str(market.get("context") or _market_context_from_id(opportunity_id) or "")
    if context not in _RESTORABLE_MARKET_CONTEXTS:
        return None
    team_label = market.get("teamLabel")
    source_event = market.get("sourceEvent") if isinstance(market.get("sourceEvent"), dict) else {}
    source_event = dict(source_event)
    source_event.setdefault("_participant1Label", room.participant1 or "A")
    source_event.setdefault("_participant2Label", room.participant2 or "B")
    if team_label:
        source_event.setdefault("participantLabel", team_label)
        source_event.setdefault("possessionLabel", team_label)
    minute = _first_restored_int(market.get("minute"), source_event.get("minute"))
    if minute is not None:
        source_event.setdefault("minute", minute)

    canonical = opportunity_options(context, room.participant1 or "A", room.participant2 or "B", team_label)
    canonical_by_id = {option.option_id: option for option in canonical}
    options: list[OpportunityOption] = []
    raw_options = market.get("options") if isinstance(market.get("options"), list) else []
    for raw_option in raw_options:
        if not isinstance(raw_option, dict):
            continue
        option_id = str(raw_option.get("optionId") or raw_option.get("option_id") or "")
        option = _restored_market_option(raw_option, canonical_by_id.get(option_id), context=context)
        if option:
            options.append(option)
    seen_option_ids = {option.option_id for option in options}
    options.extend(option for option in canonical if option.option_id not in seen_option_ids)

    prediction_data = prediction_data or {}
    created_event_index = _first_restored_int(
        market.get("createdEventIndex"),
        prediction_data.get("createdEventIndex"),
        _opportunity_event_index_from_id(opportunity_id, context),
        room.event_index,
    )
    deadline_clock = _first_restored_int(market.get("deadlineClock"), prediction_data.get("deadlineClock"))
    deadline_event_index = _first_restored_int(
        market.get("deadlineEventIndex"),
        prediction_data.get("deadlineEventIndex"),
    )
    if context == "goal_next_10":
        if deadline_clock is None and minute is not None:
            deadline_clock = minute * 60 + 10 * 60
        if deadline_clock is None and deadline_event_index is None:
            deadline_event_index = max((created_event_index or room.event_index) + 56, room.event_index + 1)

    return Opportunity(
        opportunity_id=opportunity_id,
        fixture_id=market.get("fixtureId", room.fixture_id),
        context=context,
        label=str(market.get("label") or "Market"),
        team=market.get("team"),
        team_label=str(team_label) if team_label is not None else None,
        minute=minute,
        created_event_index=created_event_index or room.event_index,
        deadline_clock=deadline_clock,
        deadline_event_index=deadline_event_index,
        options=options,
        source_event=source_event,
    )


def _restored_market_option(
    raw: dict[str, Any],
    fallback: OpportunityOption | None,
    *,
    context: str,
) -> OpportunityOption | None:
    option_id = str(raw.get("optionId") or raw.get("option_id") or (fallback.option_id if fallback else ""))
    if not option_id:
        return None
    reward = _first_restored_int(raw.get("rewardSugar"), raw.get("reward_sugar"))
    target = str(raw.get("target") or (fallback.target if fallback else _restored_option_target(context, option_id)))
    team_scope = str(raw.get("teamScope") or raw.get("team_scope") or (fallback.team_scope if fallback else "any"))
    return OpportunityOption(
        option_id=option_id,
        label=str(raw.get("label") or (fallback.label if fallback else option_id)),
        risk=str(raw.get("risk") or (fallback.risk if fallback else "safe")),
        multiplier=_restored_float(raw.get("multiplier"), fallback.multiplier if fallback else 1.0),
        target=target,
        team_scope=team_scope,
        reward_sugar=reward if reward is not None else (fallback.reward_sugar if fallback else 1),
    )


def _restored_option_target(context: str, option_id: str) -> str:
    lowered = option_id.casefold()
    if "none" in lowered or "no_goal" in lowered:
        return {
            "next_corner": "no_corner",
            "next_free_kick": "no_free_kick",
            "next_yellow_card": "no_yellow_card",
        }.get(context, "no_goal")
    return {
        "penalties": "goal",
        "goal_next_10": "goal",
        "next_goal_team": "goal",
        "next_corner": "corner",
        "next_card": "card",
        "next_substitution": "substitution",
        "next_free_kick": "free_kick",
        "next_yellow_card": "yellow_card",
        "next_foul": "foul",
    }.get(context, "")


def _market_context_from_id(opportunity_id: str) -> str | None:
    return next(
        (context for context in _RESTORABLE_MARKET_CONTEXTS if opportunity_id.endswith(f"_{context}")),
        None,
    )


def _opportunity_event_index_from_id(opportunity_id: str, context: str) -> int | None:
    prefix = opportunity_id[: -len(context)].rstrip("_")
    return _first_restored_int(prefix.rsplit("_", 1)[-1])


def _remember_restored_opportunity_slot(room: GameRoom, opportunity: Opportunity) -> None:
    team_key = opportunity.team if opportunity.team is not None else opportunity.team_label or "any"
    key = f"{opportunity.context}:{team_key}" if opportunity.context == "penalties" else opportunity.context
    cadence_key = key if opportunity.context == "penalties" else "standard_market_arrival"
    room.last_opportunity_event_index_by_key[cadence_key] = max(
        room.last_opportunity_event_index_by_key.get(cadence_key, -10_000),
        opportunity.created_event_index,
    )
    clock = _first_restored_int(opportunity.source_event.get("clockSeconds"))
    if clock is None and opportunity.minute is not None:
        clock = opportunity.minute * 60
    if clock is not None:
        room.last_opportunity_clock_by_key[cadence_key] = max(
            room.last_opportunity_clock_by_key.get(cadence_key, -10_000),
            clock,
        )


def _first_restored_int(*values: Any) -> int | None:
    for value in values:
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _restored_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


async def _ensure_room_log_hydrated(room: GameRoom) -> None:
    if getattr(room, "_aoc_log_hydrated", False):
        return
    if not supabase_store.configured:
        setattr(room, "_aoc_log_hydrated", True)
        return
    replay = await _stored_replay_or_none(room.game_id)
    if replay:
        _merge_restored_events(room, replay.get("events") or [])
        _restore_live_market_positions(room, replay.get("game"))
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
    return await asyncio.to_thread(
        supabase_store.latest_game_for_room_code,
        room_code,
        room_scope="private",
    )


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
        _clear_restored_terminal_snapshot(room)
        room.mode = "replay"
        room.agent_call_mode = payload.agentCallMode
        room.add_log(
            "game_started",
            f"Demo replay started with {len(events)} normalized events.",
            {"mode": "replay", "source": "demo", "rawCount": len(events)},
        )
        room.status = "running_replay"
        await _sync_room_to_supabase_async(room)
        _schedule_replay_task(
            room,
            events,
            delay_seconds=payload.replayDelaySeconds,
            time_scale=payload.replayTimeScale,
        )
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
    _clear_restored_terminal_snapshot(room)
    room.mode = "replay"
    room.agent_call_mode = payload.agentCallMode
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
    await _sync_room_to_supabase_async(room)
    _schedule_replay_task(
        room,
        timeline["events"],
        delay_seconds=payload.replayDelaySeconds,
        time_scale=payload.replayTimeScale,
    )
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
                    await _finish_live_game_with_txline(harness, client)
                    await _sync_room_to_supabase_async(room)
                    break
                baseline_count = 0
                if _live_timeline_active(timeline):
                    baseline_count = await asyncio.to_thread(_open_live_baseline_markets, harness, timeline_events)
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
                _sync_live_match_state_from_timeline(room, timeline)
                _sync_room_agent_usage(game_id)
                await _sync_room_to_supabase_async(room)
            elif room.match_state:
                _sync_live_match_state_from_timeline(room, timeline)
            if _live_timeline_finished(timeline) or _live_auto_finish_reached(room):
                await _finish_live_game_with_txline(harness, client)
                await _sync_room_to_supabase_async(room)
                break
            if _live_timeline_active(timeline):
                baseline_count = await asyncio.to_thread(_open_live_baseline_markets, harness, timeline_events)
                if baseline_count:
                    await _sync_room_to_supabase_async(room)
            first_batch = False
            await asyncio.sleep(LIVE_SCORE_POLL_SECONDS)
    except asyncio.CancelledError:
        if (
            room.room_kind == "player"
            and room.room_scope == "global"
            and room.mode == "live"
            and room.status == "running_live"
            and room.match_state
            and _live_match_snapshot_in_progress(
                {"gameState": room.match_state.game_state, "statusId": room.match_state.status_id}
            )
        ):
            room.add_log(
                "live_sync",
                "Public live polling paused for a server restart.",
                {"mode": "live", "restartPending": True},
            )
        else:
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
        _sync_live_match_state_from_timeline(room, timeline)
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
    has_match_activity = _live_timeline_has_match_activity(timeline)
    state = _normalize_live_game_state(status.get("gameState"))
    if state in LIVE_WAITING_GAME_STATES:
        return has_match_activity
    status_id = _safe_int(status.get("statusId"))
    if status_id in LIVE_WAITING_STATUS_IDS:
        return has_match_activity
    if state:
        return True
    if status_id is not None and status_id not in LIVE_FINAL_STATUS_IDS:
        return True
    return has_match_activity


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


def _live_status_waiting(status: dict[str, Any] | None) -> bool:
    if not status or _live_status_finished(status):
        return False
    state = _normalize_live_game_state(status.get("gameState"))
    if state in LIVE_WAITING_GAME_STATES:
        return True
    status_id = _safe_int(status.get("statusId"))
    return status_id in LIVE_WAITING_STATUS_IDS


def _live_timeline_has_match_activity(timeline: dict[str, Any] | None) -> bool:
    if not isinstance(timeline, dict):
        return False
    score = timeline.get("score")
    if isinstance(score, dict):
        p1 = _safe_int(score.get("participant1"))
        p2 = _safe_int(score.get("participant2"))
        if (p1 is not None and p1 > 0) or (p2 is not None and p2 > 0):
            return True
    events = [event for event in timeline.get("events") or [] if isinstance(event, dict)]
    if any(_live_event_has_match_activity(event) for event in events):
        return True
    # A long stream of normalized events is only produced once TXLine has real match data.
    return len(events) >= 20


def _live_event_has_match_activity(event: dict[str, Any]) -> bool:
    action = _normalize_live_game_state(event.get("action"))
    if action in LIVE_ACTIVITY_ACTIONS:
        return True
    if action in LIVE_PREMATCH_ACTIONS:
        return False
    clock_seconds = _safe_int(event.get("clockSeconds"))
    if clock_seconds is not None and clock_seconds > 0:
        return True
    minute = _safe_int(event.get("minute"))
    if minute is not None and minute > 0:
        return True
    highlights = event.get("highlights")
    return bool(isinstance(highlights, list) and highlights)


def _sync_live_match_state_from_timeline(room: GameRoom, timeline: dict[str, Any] | None) -> None:
    if not room.match_state:
        return
    status = _live_timeline_status(timeline)
    if _live_status_finished(status):
        room.match_state.game_state = status.get("gameState") or status.get("status") or "finished"
        if status.get("statusId") is not None:
            room.match_state.status_id = status.get("statusId")
        return
    if _live_timeline_active(timeline):
        if status.get("gameState") and not _live_status_waiting(status):
            room.match_state.game_state = status.get("gameState")
        else:
            room.match_state.game_state = "inplay"
        if status.get("statusId") is not None and _safe_int(status.get("statusId")) not in LIVE_WAITING_STATUS_IDS:
            room.match_state.status_id = status.get("statusId")


def _normalize_live_game_state(value: Any) -> str:
    return str(value or "").strip().casefold().replace("-", "_").replace(" ", "_")


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _open_live_baseline_markets(harness: Any, timeline_events: list[dict[str, Any]] | None = None) -> int:
    room = harness.room
    latest_event = _latest_fixture_event(room, timeline_events or [])
    if not _live_standard_market_due(room, latest_event):
        return 0
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


def _live_standard_market_due(room: GameRoom, latest_event: dict[str, Any] | None) -> bool:
    """Return whether the next five-minute live market wave may be opened."""

    cadence_key = "standard_market_arrival"
    last_clock = room.last_opportunity_clock_by_key.get(cadence_key)
    if last_clock is None:
        return True
    current_clock = _event_clock_seconds(latest_event or {})
    if current_clock is not None:
        return current_clock - last_clock >= STANDARD_MARKET_INTERVAL_SECONDS
    last_event_index = room.last_opportunity_event_index_by_key.get(cadence_key, -10_000)
    return room.event_index - last_event_index >= 24


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


async def _finish_live_game_with_txline(
    harness: Any,
    client: TxLineClient,
    *,
    attempts: int | None = None,
    retry_seconds: float | None = None,
) -> None:
    """Verify the final TXLine score, persist the proof, then close the live room.

    Verification is deliberately read-only and never blocks the game from
    finishing permanently: an unavailable or invalid proof is stored as a
    visible status instead of turning the room into an error.
    """

    room = harness.room
    max_attempts = max(
        1,
        attempts
        if attempts is not None
        else int(_env_float("TXLINE_AUTO_VALIDATION_ATTEMPTS", 3)),
    )
    delay = max(
        0.0,
        retry_seconds
        if retry_seconds is not None
        else _env_float("TXLINE_AUTO_VALIDATION_RETRY_SECONDS", 2.0),
    )
    base_result: dict[str, Any] = {
        "status": "pending",
        "verified": False,
        "fixtureId": room.fixture_id,
        "network": txline_network(client.settings.base_url),
        "participant1": room.participant1,
        "participant2": room.participant2,
        "reason": "Waiting for the finalized TxLINE score proof.",
    }
    room.txline_validation = dict(base_result)
    room.add_log(
        "txline_validation",
        "Match ended. Verifying the final score with TxLINE and Solana.",
        dict(base_result),
    )
    await _sync_room_to_supabase_async(room)

    result = _txline_validation_cache.get(str(room.fixture_id))
    if not result or not result.get("verified"):
        result = None
        try:
            fixture_id = int(room.fixture_id)
            for attempt in range(1, max_attempts + 1):
                result = await _txline_fixture_validation(
                    fixture_id,
                    participant1=room.participant1,
                    participant2=room.participant2,
                    client=client,
                )
                if result.get("status") != "pending" or attempt == max_attempts:
                    break
                if delay:
                    await asyncio.sleep(delay)
        except Exception as exc:
            result = {
                **base_result,
                "status": "failed",
                "reason": str(exc) or exc.__class__.__name__,
            }

    result = dict(result or base_result)
    room.txline_validation = result
    _remember_txline_validation(room.fixture_id, result)
    if result.get("verified") and room.match_state and isinstance(result.get("score"), dict):
        room.match_state.score = dict(result["score"])

    if result.get("verified"):
        score = result.get("score") or {}
        message = (
            "TxLINE verified the final score against its on-chain Solana root: "
            f"{score.get('participant1', '—')}-{score.get('participant2', '—')}."
        )
    elif result.get("status") == "pending":
        message = "The match is finished, but the final TxLINE proof is not available yet."
    else:
        message = f"The match is finished, but TxLINE verification failed: {result.get('reason') or 'unknown error'}."
    room.add_log("txline_validation", message, result)
    await asyncio.to_thread(_finish_live_game, harness)


def _live_auto_finish_reached(room: GameRoom) -> bool:
    if LIVE_AUTO_FINISH_AFTER_SECONDS <= 0:
        return False
    now = datetime.now(timezone.utc)
    kickoff_at = _room_kickoff_datetime(room)
    if kickoff_at and now >= kickoff_at + timedelta(seconds=LIVE_AUTO_FINISH_AFTER_SECONDS):
        return True
    started_at = _room_live_started_datetime(room)
    return bool(started_at and now >= started_at + timedelta(seconds=LIVE_AUTO_FINISH_AFTER_SECONDS))


def _room_live_started_datetime(room: GameRoom) -> datetime | None:
    for event in room.log:
        if event.kind != "game_started":
            continue
        if event.data.get("mode") != "live":
            continue
        return datetime.fromtimestamp(float(event.created_at), tz=timezone.utc)
    return None


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
