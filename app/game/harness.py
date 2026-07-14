from __future__ import annotations

import copy
import hashlib
import math
import random
import re
import threading
import time
import uuid
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, cast

from .agents import ColonyAgentDecision, ColonyDecisionAgent


VALID_SIZES = {10, 20, 50}
VALID_STYLES = {"cautious", "balanced", "aggressive"}
VALID_CONTEXTS = {"penalties", "corners", "momentum", "chaos", "balanced"}
VALID_INFO_NEEDS = {"low", "medium", "high"}
VALID_ANALYSIS_ROLES = {"reactive", "statistical", "situational"}
ANALYSIS_ROLE_BY_ARCHETYPE = {
    "cautious": "statistical",
    "balanced": "situational",
    "data_first": "statistical",
    "opportunist": "situational",
    "momentum": "reactive",
    "chaos": "reactive",
}
SIGNAL_COUNT_KEYS = (
    "goal",
    "shot",
    "corner",
    "free_kick",
    "foul",
    "yellow",
    "red",
    "penalty",
    "penalty_scored",
    "penalty_missed",
    "substitution",
    "danger",
    "attack",
)
RoomKind = Literal["admin", "player"]
VALID_ROOM_KINDS = {"admin", "player"}
RoomScope = Literal["global", "private"]
VALID_ROOM_SCOPES = {"global", "private"}
JOINABLE_STATUSES = {"created", "waiting_kickoff"}
STRATEGY_EDITABLE_STATUSES = {"created", "waiting_kickoff", "running_replay", "running_live"}
STARTING_COLONY_ANTS = 20
STARTING_COLONY_SUGAR = 20
# Backward-compatible internal/API alias. Sugar is the only player-facing resource.
STARTING_COLONY_FOOD = STARTING_COLONY_SUGAR
MARKET_RISK_SUGAR = 2
MAX_RESERVED_SUGAR = 10
STYLE_ENTRY_THRESHOLDS = {
    "cautious": 0.70,
    "balanced": 0.60,
    "aggressive": 0.51,
}
STYLE_ALIASES = {
    "prudent": "cautious",
    "cautious": "cautious",
    "equilibre": "balanced",
    "balanced": "balanced",
    "agressif": "aggressive",
    "aggressive": "aggressive",
}

_PRIVATE_IDENTITY_KEYS = {
    "anonymousId",
    "ownerAnonymousId",
    "playerAnonymousId",
    "anonymous_id",
    "owner_anonymous_id",
    "player_anonymous_id",
}
PRIVATE_SNAPSHOT_KEY = "_private"
_PRIVATE_RESPONSE_KEYS = {PRIVATE_SNAPSHOT_KEY, "antProfiles"}


def room_kind_from_snapshot(value: Any, *, default: RoomKind = "player") -> RoomKind:
    """Resolve a room kind without granting admin rights from missing identity.

    ``roomKind`` is an authorization boundary, so structural guesses such as an
    ownerless colony are deliberately insufficient.  A durable explicit marker
    in the snapshot (or its ``game_created`` journal event) is accepted; every
    pre-marker/ambiguous snapshot remains a player room.
    """

    if not isinstance(value, dict):
        return default

    for key in ("roomKind", "room_kind"):
        candidate = value.get(key)
        if candidate in VALID_ROOM_KINDS:
            return cast(RoomKind, candidate)

    nested_snapshot = value.get("public_state")
    if isinstance(nested_snapshot, dict):
        for key in ("roomKind", "room_kind"):
            candidate = nested_snapshot.get(key)
            if candidate in VALID_ROOM_KINDS:
                return cast(RoomKind, candidate)

    for collection_key in ("events", "log"):
        events = value.get(collection_key)
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("kind") != "game_created":
                continue
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            for key in ("roomKind", "room_kind"):
                candidate = data.get(key)
                if candidate in VALID_ROOM_KINDS:
                    return cast(RoomKind, candidate)
    return default


def room_scope_from_snapshot(
    value: Any,
    *,
    room_kind: RoomKind | None = None,
) -> RoomScope | None:
    """Resolve the player-room scope while keeping legacy rooms compatible.

    Admin simulations do not participate in the player lobby and therefore do
    not have a scope. Player snapshots created before ``roomScope`` existed are
    the historical public match rooms, so they remain ``global``.
    """

    resolved_kind = room_kind or room_kind_from_snapshot(value)
    if resolved_kind == "admin":
        return None
    if not isinstance(value, dict):
        return "global"

    for key in ("roomScope", "room_scope"):
        candidate = value.get(key)
        if candidate in VALID_ROOM_SCOPES:
            return cast(RoomScope, candidate)

    nested_snapshot = value.get("public_state")
    if isinstance(nested_snapshot, dict):
        for key in ("roomScope", "room_scope"):
            candidate = nested_snapshot.get(key)
            if candidate in VALID_ROOM_SCOPES:
                return cast(RoomScope, candidate)

    for collection_key in ("events", "log"):
        events = value.get(collection_key)
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("kind") != "game_created":
                continue
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            for key in ("roomScope", "room_scope"):
                candidate = data.get(key)
                if candidate in VALID_ROOM_SCOPES:
                    return cast(RoomScope, candidate)
    return "global"


def redact_public_identity(value: Any) -> Any:
    """Remove legacy bearer identifiers before state or events leave the server."""

    if isinstance(value, dict):
        return {
            key: redact_public_identity(item)
            for key, item in value.items()
            if key not in _PRIVATE_IDENTITY_KEYS and key not in _PRIVATE_RESPONSE_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [redact_public_identity(item) for item in value]
    return value


CONTEXT_ALIASES = {
    "equilibre": "balanced",
    "balanced": "balanced",
    "penalties": "penalties",
    "corners": "corners",
    "momentum": "momentum",
    "chaos": "chaos",
}
INFO_NEED_ALIASES = {
    "bas": "low",
    "low": "low",
    "moyen": "medium",
    "medium": "medium",
    "haut": "high",
    "high": "high",
}

RISK_RULES: dict[str, dict[str, float]] = {
    "safe": {"multiplier": 1.3},
    "risky": {"multiplier": 4.0},
    "wild": {"multiplier": 7.0},
    "chaos": {"multiplier": 10.0},
}
RESOURCE_LOSS_MULTIPLIER = {"safe": 1.0, "risky": 2.0, "wild": 3.0, "chaos": 4.0}
RALLY_COST = 3
RALLY_ANTS = 5
RECALL_ANTS = 5
SWITCH_COST = 2

FOOD_DRAIN_BY_SIZE = {10: 1, 20: 1, 50: 1}
FOOD_DRAIN_INTERVAL_EVENTS = 24
LARVAE_INCUBATION_EVENTS = 18
GOAL_NEXT_10_SECONDS = 10 * 60
BASELINE_MARKET_CONTEXTS = ("next_corner", "next_card", "next_substitution", "next_goal_team")
LEGACY_MARKET_CONTEXTS = {"goal_next_10", "next_free_kick", "next_yellow_card", "next_foul"}
ROLLING_WINDOW_CONTEXTS = set(BASELINE_MARKET_CONTEXTS).union(LEGACY_MARKET_CONTEXTS)
NO_DEADLINE_CONTEXTS = {"penalties", *ROLLING_WINDOW_CONTEXTS} - {"goal_next_10"}
STANDARD_MARKET_INTERVAL_SECONDS = 5 * 60
MAX_OPEN_STANDARD_MARKETS = 3
MARKET_COOLDOWN_SECONDS = {
    "penalties": 5 * 60,
    "goal_next_10": 10 * 60,
    "next_goal_team": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_corner": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_card": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_substitution": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_free_kick": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_yellow_card": STANDARD_MARKET_INTERVAL_SECONDS,
    "next_foul": STANDARD_MARKET_INTERVAL_SECONDS,
}


def normalize_choice(value: str | None) -> str:
    return (value or "").strip().casefold().replace("é", "e").replace("è", "e")


def normalize_style(value: str | None) -> str:
    return STYLE_ALIASES.get(normalize_choice(value), normalize_choice(value))


def normalize_context(value: str | None) -> str:
    return CONTEXT_ALIASES.get(normalize_choice(value), normalize_choice(value))


def normalize_info_need(value: str | None) -> str:
    return INFO_NEED_ALIASES.get(normalize_choice(value), normalize_choice(value))


def stable_seed(*parts: Any) -> int:
    payload = "|".join(str(part) for part in parts)
    return int(hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16], 16)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def food_drain_for_colony(colony: "ColonyState") -> int:
    # V0 has no upkeep or starvation. Kept as a compatibility helper for callers
    # that still import the historical food-drain function.
    return 0


def info_cost_for_colony(colony: "ColonyState", opportunity: "Opportunity") -> int:
    base = 2
    if any(option.risk in {"wild", "chaos"} for option in opportunity.options):
        return math.ceil(base * 1.5)
    return base


@dataclass
class AntMemory:
    attempts_by_context: dict[str, int] = field(default_factory=dict)
    wins_by_context: dict[str, int] = field(default_factory=dict)
    losses_by_context: dict[str, int] = field(default_factory=dict)
    recent_losses: int = 0
    info_attempts: int = 0
    info_successes: int = 0

    def success_rate(self, context: str) -> float:
        attempts = self.attempts_by_context.get(context, 0)
        if attempts == 0:
            return 0.5
        return self.wins_by_context.get(context, 0) / attempts


@dataclass
class AntState:
    ant_id: str
    archetype: str
    risk_appetite: float
    info_hunger: float
    favorite_context: str
    confidence_threshold: float
    loss_sensitivity: float
    momentum_bias: float
    chaos_bias: float
    base_influence: float = 1.0
    influence: float = 1.0
    alive: bool = True
    wounded_until_event: int = 0
    engaged_prediction_ids: set[str] = field(default_factory=set)
    memory: AntMemory = field(default_factory=AntMemory)
    style_override: str | None = None
    favorite_context_override: str | None = None
    info_need_override: str | None = None
    analysis_role_override: str | None = None

    def is_active(self, event_index: int) -> bool:
        return self.alive and self.wounded_until_event <= event_index


@dataclass
class ColonyMemory:
    attempts: int = 0
    wins: int = 0
    losses: int = 0
    food_net: int = 0
    info_purchases: int = 0
    context_attempts: dict[str, int] = field(default_factory=dict)
    context_wins: dict[str, int] = field(default_factory=dict)

    @property
    def accuracy(self) -> float:
        return self.wins / self.attempts if self.attempts else 0.0

    def context_rate(self, context: str) -> float:
        attempts = self.context_attempts.get(context, 0)
        if attempts == 0:
            return 0.5
        return self.context_wins.get(context, 0) / attempts

    @property
    def sugar_net(self) -> int:
        return self.food_net

    @sugar_net.setter
    def sugar_net(self, value: int) -> None:
        self.food_net = value


@dataclass
class PlayerState:
    player_id: str
    name: str
    anonymous_id: str | None = None
    wallet: str | None = None

    def public_state(self) -> dict[str, Any]:
        state = {
            "playerId": self.player_id,
            "name": self.name,
        }
        if self.wallet:
            state["wallet"] = self.wallet
        return state


@dataclass
class ColonyState:
    colony_id: str
    name: str
    size: int
    style: str
    favorite_context: str
    info_need: str
    seed: int
    player_id: str | None = None
    player_anonymous_id: str | None = None
    player_wallet: str | None = None
    ants: list[AntState] = field(default_factory=list)
    food: int = 0
    food_reserved: int = 0
    larvae: int = 0
    larvae_ready_events: list[int] = field(default_factory=list)
    last_food_event_index: int = 0
    memory: ColonyMemory = field(default_factory=ColonyMemory)
    strategy_revision: int = 0
    strategy_lock: Any = field(default_factory=threading.RLock, repr=False, compare=False)

    @property
    def alive_ants(self) -> list[AntState]:
        return [ant for ant in self.ants if ant.alive]

    def active_ants(self, event_index: int) -> list[AntState]:
        return [ant for ant in self.ants if ant.is_active(event_index)]

    @property
    def sugar(self) -> int:
        return self.food

    @sugar.setter
    def sugar(self, value: int) -> None:
        self.food = value

    @property
    def sugar_reserved(self) -> int:
        return self.food_reserved

    @sugar_reserved.setter
    def sugar_reserved(self, value: int) -> None:
        self.food_reserved = value

    def public_state(self, event_index: int) -> dict[str, Any]:
        ant_counts = colony_ant_counts(self, event_index)
        alive = ant_counts["aliveCount"]
        wounded = ant_counts["woundedCount"]
        dead = len([ant for ant in self.ants if not ant.alive])
        born = max(0, len(self.ants) - self.size)
        larvae = len(self.larvae_ready_events) if self.larvae_ready_events else self.larvae
        base_size = max(1, self.size)
        growth_rate = born / base_size
        mortality_rate = dead / base_size
        score_breakdown = {"sugar": self.food}
        score = self.food
        available_sugar = max(0, self.food - self.food_reserved)
        entry_threshold = STYLE_ENTRY_THRESHOLDS[self.style]
        state = {
            "colonyId": self.colony_id,
            "name": self.name,
            "size": self.size,
            "simulationSeed": self.seed,
            "style": self.style,
            "favoriteContext": self.favorite_context,
            "infoNeed": self.info_need,
            "strategyRevision": self.strategy_revision,
            "antsAlive": alive,
            "antsActive": ant_counts["activeCount"],
            "antsEngaged": ant_counts["engagedCount"],
            "antsWounded": wounded,
            "antsDead": dead,
            "antsBorn": born,
            "sugar": self.food,
            "sugarReserved": self.food_reserved,
            "sugarAvailable": available_sugar,
            "food": self.food,
            "foodReserved": self.food_reserved,
            "foodAvailable": available_sugar,
            "larvae": 0,
            "score": score,
            "scoreBreakdown": score_breakdown,
            "accuracy": round(self.memory.accuracy, 3),
            "growthRate": round(growth_rate, 3),
            "mortalityRate": round(mortality_rate, 3),
            "sugarNet": self.memory.food_net,
            "foodNet": self.memory.food_net,
            "entryThreshold": entry_threshold,
            "economy": {
                "currency": "sugar",
                "balance": self.food,
                "reserved": self.food_reserved,
                "available": available_sugar,
                "net": self.memory.food_net,
                "sugar": self.food,
                "sugarReserved": self.food_reserved,
                "sugarAvailable": available_sugar,
                "sugarNet": self.memory.food_net,
                "food": self.food,
                "foodReserved": self.food_reserved,
                "foodAvailable": available_sugar,
                "foodNet": self.memory.food_net,
                "riskPerMarket": MARKET_RISK_SUGAR,
                "maxReserved": MAX_RESERVED_SUGAR,
                "maxFundedMarkets": MAX_RESERVED_SUGAR // MARKET_RISK_SUGAR,
                "upkeepEnabled": False,
                "upkeepCost": 0,
                "upkeepEveryEvents": None,
                "nextUpkeepInEvents": None,
                "lastUpkeepEventIndex": self.last_food_event_index,
                "runwayUpkeeps": None,
                "status": "stable",
            },
            "wins": self.memory.wins,
            "losses": self.memory.losses,
            "infoPurchases": self.memory.info_purchases,
            "archetypes": dict(Counter(ant.archetype for ant in self.ants)),
            "antStrategies": {
                ant.ant_id: {
                    "style": ant.style_override,
                    "favoriteContext": ant.favorite_context_override,
                    "infoNeed": ant.info_need_override,
                    **(
                        {"analysisRole": ant.analysis_role_override}
                        if ant.analysis_role_override is not None
                        else {}
                    ),
                }
                for ant in self.ants
                if any(
                    (
                        ant.style_override,
                        ant.favorite_context_override,
                        ant.info_need_override,
                        ant.analysis_role_override,
                    )
                )
            },
        }
        if self.player_id:
            state["playerId"] = self.player_id
        if self.player_wallet:
            state["playerWallet"] = self.player_wallet
        return state


@dataclass(frozen=True)
class OpportunityOption:
    option_id: str
    label: str
    risk: str
    multiplier: float
    target: str
    team_scope: str = "same_team"
    reward_sugar: int = 1

    @property
    def risk_sugar(self) -> int:
        return MARKET_RISK_SUGAR

    def public_state(self) -> dict[str, Any]:
        return {
            "optionId": self.option_id,
            "label": self.label,
            "risk": self.risk,
            "multiplier": self.multiplier,
            "lossMultiplier": MARKET_RISK_SUGAR,
            "rewardSugar": self.reward_sugar,
            "riskSugar": MARKET_RISK_SUGAR,
        }

    def log_state(self) -> dict[str, Any]:
        return {
            **self.__dict__,
            "optionId": self.option_id,
            "rewardSugar": self.reward_sugar,
            "riskSugar": MARKET_RISK_SUGAR,
        }


@dataclass
class InfoPacket:
    opportunity_id: str
    cost: int
    facts: list[str]
    complete: bool

    @property
    def summary(self) -> str:
        return " / ".join(self.facts) if self.facts else "Partial info: no new signal."


@dataclass
class Opportunity:
    opportunity_id: str
    fixture_id: Any
    context: str
    label: str
    team: Any
    team_label: str | None
    minute: int | None
    created_event_index: int
    deadline_clock: int | None
    deadline_event_index: int | None
    options: list[OpportunityOption]
    source_event: dict[str, Any]
    info_bought_by: set[str] = field(default_factory=set)

    @property
    def info_cost(self) -> int:
        return 3 if any(option.risk in {"wild", "chaos"} for option in self.options) else 2

    def public_state(self) -> dict[str, Any]:
        return {
            "opportunityId": self.opportunity_id,
            "fixtureId": self.fixture_id,
            "context": self.context,
            "label": self.label,
            "teamLabel": self.team_label,
            "minute": self.minute,
            "infoCost": self.info_cost,
            "riskSugar": MARKET_RISK_SUGAR,
            "options": [option.public_state() for option in self.options],
        }


@dataclass
class Prediction:
    prediction_id: str
    colony_id: str
    opportunity_id: str
    option: OpportunityOption
    ant_ids: list[str]
    created_event_index: int
    deadline_clock: int | None
    deadline_event_index: int | None
    info_bought: bool = False
    reserved_food: int = 0
    support_fraction: float = 0.0
    entry_threshold: float = 0.0
    resolved: bool = False
    rallied: bool = False
    switched: bool = False

    @property
    def reserved_sugar(self) -> int:
        return self.reserved_food

    @reserved_sugar.setter
    def reserved_sugar(self, value: int) -> None:
        self.reserved_food = value

    @property
    def risk_sugar(self) -> int:
        return self.reserved_food

    @property
    def reward_sugar(self) -> int:
        return self.option.reward_sugar

    @property
    def consensus(self) -> float:
        return self.support_fraction


@dataclass
class MatchState:
    fixture_id: Any
    participant1: str | None = None
    participant2: str | None = None
    score: dict[str, Any] | None = None
    game_state: Any = None
    status_id: Any = None
    possession_label: str | None = None
    # TXLine commonly emits well over one thousand records for a match. Keep the
    # complete in-memory timeline so the statistical lens is genuinely based on
    # the whole match; presentation helpers still select a short recent tail.
    recent_events: deque[dict[str, Any]] = field(default_factory=deque)

    def update(self, event: dict[str, Any]) -> None:
        if event.get("gameState") is not None:
            self.game_state = event.get("gameState")
        if event.get("statusId") is not None:
            self.status_id = event.get("statusId")
        if event.get("score") and (event["score"].get("participant1") is not None or event["score"].get("participant2") is not None):
            current = self.score or {"participant1": 0, "participant2": 0}
            self.score = {
                "participant1": event["score"].get("participant1") if event["score"].get("participant1") is not None else current.get("participant1", 0),
                "participant2": event["score"].get("participant2") if event["score"].get("participant2") is not None else current.get("participant2", 0),
            }
        if event.get("possessionLabel"):
            self.possession_label = event["possessionLabel"]
        self.recent_events.append(event)

    def pressure_summary(self) -> str:
        recent = list(self.recent_events)[-10:]
        danger = len([event for event in recent if _event_has_text(event, "danger", "high_danger")])
        corners = len([event for event in recent if "corner" in event.get("highlights", []) or _event_has_text(event, "corner")])
        shots = len([event for event in recent if _event_has_text(event, "shot", "tir")])
        if not any((danger, corners, shots)):
            return "low recent pressure"
        return f"recent pressure: {danger} danger, {corners} corner(s), {shots} shot(s)"


@dataclass
class GameLogEvent:
    index: int
    kind: str
    message: str
    data: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)

    def public_state(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "kind": self.kind,
            "message": self.message,
            "data": redact_public_identity(self.data),
            "createdAt": self.created_at,
        }


@dataclass
class GameRoom:
    game_id: str
    room_code: str
    fixture_id: Any
    participant1: str | None = None
    participant2: str | None = None
    competition: str | None = None
    start_time: Any = None
    start_time_iso: str | None = None
    txline_validation: dict[str, Any] | None = None
    owner_anonymous_id: str | None = None
    owner_wallet: str | None = None
    owner_name: str | None = None
    room_kind: RoomKind = "player"
    room_scope: RoomScope | None = None
    seed: int = 7
    status: str = "created"
    mode: str | None = None
    agent_call_mode: str | None = None
    event_index: int = 0
    players: list[PlayerState] = field(default_factory=list)
    colonies: dict[str, ColonyState] = field(default_factory=dict)
    match_state: MatchState | None = None
    opportunities: dict[str, Opportunity] = field(default_factory=dict)
    predictions: dict[str, Prediction] = field(default_factory=dict)
    last_opportunity_event_index_by_key: dict[str, int] = field(default_factory=dict)
    last_opportunity_clock_by_key: dict[str, int] = field(default_factory=dict)
    log: list[GameLogEvent] = field(default_factory=list)
    agent_usage: dict[str, Any] | None = None
    log_lock: Any = field(default_factory=threading.RLock, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self.room_kind not in VALID_ROOM_KINDS:
            raise ValueError("room_kind must be admin or player")
        if self.room_kind == "admin":
            if self.room_scope is not None:
                raise ValueError("admin rooms cannot have a player room_scope")
        elif self.room_scope is None:
            self.room_scope = "global"
        elif self.room_scope not in VALID_ROOM_SCOPES:
            raise ValueError("room_scope must be global or private")
        self.match_state = MatchState(self.fixture_id, self.participant1, self.participant2)

    def add_log(self, kind: str, message: str, data: dict[str, Any] | None = None) -> None:
        with self.log_lock:
            self.log.append(GameLogEvent(len(self.log), kind, message, data or {}))

    def public_state(self) -> dict[str, Any]:
        colonies = [colony.public_state(self.event_index) for colony in self.colonies.values()]
        colonies.sort(key=lambda item: item["score"], reverse=True)
        player_colonies = self._player_colonies()
        state = {
            "gameId": self.game_id,
            "roomCode": self.room_code,
            "roomKind": self.room_kind,
            "fixtureId": self.fixture_id,
            "participant1": self.participant1,
            "participant2": self.participant2,
            "competition": self.competition,
            "startTime": self.start_time,
            "startTimeIso": self.start_time_iso,
            "txlineValidation": self.txline_validation,
            "owner": {
                "wallet": self.owner_wallet,
                "name": self.owner_name,
            }
            if self.owner_anonymous_id or self.owner_wallet or self.owner_name
            else None,
            "status": self.status,
            "mode": self.mode,
            "agentCallMode": self.agent_call_mode,
            "eventIndex": self.event_index,
            "players": [self._public_player_state(player, player_colonies) for player in self.players],
            "match": {
                "score": self.match_state.score if self.match_state else None,
                "gameState": self.match_state.game_state if self.match_state else None,
                "statusId": self.match_state.status_id if self.match_state else None,
                "possessionLabel": self.match_state.possession_label if self.match_state else None,
            },
            "colonies": colonies,
            "activeOpportunities": [opportunity.public_state() for opportunity in self.opportunities.values()],
            "agentUsage": self.agent_usage,
            "logCount": len(self.log),
        }
        if self.room_kind == "player":
            state["roomScope"] = self.room_scope
        restored_snapshot = getattr(self, "_aoc_restored_public_state", None)
        if self.status in {"finished", "stopped", "error"} and isinstance(restored_snapshot, dict):
            snapshot = copy.deepcopy(restored_snapshot)
            snapshot["status"] = self.status
            snapshot["mode"] = self.mode
            snapshot["agentCallMode"] = self.agent_call_mode
            snapshot["roomKind"] = self.room_kind
            if self.room_kind == "player":
                snapshot["roomScope"] = self.room_scope
            else:
                snapshot.pop("roomScope", None)
            try:
                snapshot["logCount"] = max(int(snapshot.get("logCount") or 0), len(self.log))
            except (TypeError, ValueError):
                snapshot["logCount"] = len(self.log)
            return redact_public_identity(snapshot)
        return state

    def persistence_state(self) -> dict[str, Any]:
        """Return a server-only snapshot with data required after a restart.

        The private section is stored behind Supabase RLS and is always removed
        by ``redact_public_identity`` before any API response leaves the server.
        """

        state = copy.deepcopy(self.public_state())
        state[PRIVATE_SNAPSHOT_KEY] = {
            "version": 1,
            "ownerAnonymousId": self.owner_anonymous_id,
            "playerAnonymousIds": {
                player.player_id: player.anonymous_id
                for player in self.players
                if player.anonymous_id
            },
            "colonyAnonymousIds": {
                colony.colony_id: colony.player_anonymous_id
                for colony in self.colonies.values()
                if colony.player_anonymous_id
            },
            "antProfiles": {
                colony.colony_id: {
                    ant.ant_id: ant_profile_state(ant)
                    for ant in colony.ants[: colony.size]
                }
                for colony in self.colonies.values()
            },
        }
        return state

    def _player_colonies(self) -> dict[str, ColonyState]:
        linked: dict[str, ColonyState] = {}
        for colony in self.colonies.values():
            if colony.player_id:
                linked[f"player:{colony.player_id}"] = colony
            if colony.player_anonymous_id:
                linked[f"anonymous:{colony.player_anonymous_id}"] = colony
            if colony.player_wallet:
                linked[f"wallet:{colony.player_wallet}"] = colony
        return linked

    def _public_player_state(self, player: PlayerState, player_colonies: dict[str, ColonyState]) -> dict[str, Any]:
        state = player.public_state()
        if player.wallet and player.wallet == self.owner_wallet:
            state["isHost"] = True
        elif player.anonymous_id and player.anonymous_id == self.owner_anonymous_id:
            state["isHost"] = True
        elif not self.owner_anonymous_id and not self.owner_wallet and player.name == self.owner_name:
            state["isHost"] = True
        colony = player_colonies.get(f"player:{player.player_id}")
        if not colony and player.anonymous_id:
            colony = player_colonies.get(f"anonymous:{player.anonymous_id}")
        if not colony and player.wallet:
            colony = player_colonies.get(f"wallet:{player.wallet}")
        if colony:
            state["ready"] = True
            state["colonyId"] = colony.colony_id
            state["colonyName"] = colony.name
        return state


class GameHarness:
    def __init__(self, room: GameRoom, decision_agent: ColonyDecisionAgent | None = None) -> None:
        self.room = room
        self.decision_agent = decision_agent

    def add_colony(
        self,
        name: str,
        size: int,
        style: str,
        favorite_context: str,
        info_need: str,
        *,
        anonymous_id: str | None = None,
        wallet: str | None = None,
        player_id: str | None = None,
    ) -> ColonyState:
        if self.room.status not in JOINABLE_STATUSES:
            raise ValueError("room is closed; colonies can no longer join")
        if size not in VALID_SIZES:
            raise ValueError("size must be one of 10, 20 or 50")
        style = normalize_style(style)
        favorite_context = normalize_context(favorite_context)
        info_need = normalize_info_need(info_need)
        if style not in VALID_STYLES:
            raise ValueError("style must be cautious, balanced or aggressive")
        if favorite_context not in VALID_CONTEXTS:
            raise ValueError("favorite_context must be penalties, corners, momentum, chaos or balanced")
        if info_need not in VALID_INFO_NEEDS:
            raise ValueError("info_need must be low, medium or high")

        clean_anonymous_id = (anonymous_id or "").strip()[:80] or None
        clean_wallet = (wallet or "").strip()[:80] or None
        clean_player_id = (player_id or "").strip()[:80] or None
        player = self._find_player(clean_player_id, clean_anonymous_id, clean_wallet)
        if (clean_anonymous_id or clean_wallet) and not player:
            raise ValueError("join the room before creating a colony")
        if player:
            for existing in self.room.colonies.values():
                if player.wallet and existing.player_wallet == player.wallet:
                    raise ValueError("this wallet already has a colony")
                if existing.player_id and existing.player_id == player.player_id:
                    raise ValueError("this player already has a colony")
                if player.anonymous_id and existing.player_anonymous_id == player.anonymous_id:
                    raise ValueError("this player already has a colony")
            clean_player_id = player.player_id
            clean_anonymous_id = player.anonymous_id
            clean_wallet = player.wallet

        clean_colony_name = (player.name if player else name).strip() or f"Colony {len(self.room.colonies) + 1}"
        colony_id = f"col_{uuid.uuid4().hex[:10]}"
        seed = stable_seed(self.room.seed, self.room.game_id, colony_id, clean_colony_name)
        colony = ColonyState(
            colony_id=colony_id,
            name=clean_colony_name,
            size=STARTING_COLONY_ANTS,
            style=style,
            favorite_context=favorite_context,
            info_need=info_need,
            seed=seed,
            player_id=clean_player_id,
            player_anonymous_id=clean_anonymous_id,
            player_wallet=clean_wallet,
            food=STARTING_COLONY_FOOD,
            last_food_event_index=self.room.event_index,
        )
        colony.ants = generate_ants(colony)
        self.room.colonies[colony_id] = colony
        self.room.add_log(
            "colony_created",
            f"{colony.name} enters the game with {STARTING_COLONY_ANTS} ants and {STARTING_COLONY_SUGAR} Sugar.",
            {
                "colonyId": colony_id,
                "size": STARTING_COLONY_ANTS,
                "requestedSize": size,
                "startingSugar": STARTING_COLONY_SUGAR,
                "startingFood": STARTING_COLONY_FOOD,
                "style": style,
                "favoriteContext": favorite_context,
                "infoNeed": info_need,
                "wallet": clean_wallet,
            },
        )
        return colony

    def join_player(self, name: str, anonymous_id: str | None = None, wallet: str | None = None) -> PlayerState:
        if self.room.room_kind == "admin":
            raise ValueError("admin simulation rooms do not accept players")
        if self.room.status not in JOINABLE_STATUSES:
            raise ValueError("room is closed; new players can no longer join")
        clean_name = name.strip()[:32] or f"Player {len(self.room.players) + 1}"
        clean_anonymous_id = (anonymous_id or "").strip()[:80] or None
        clean_wallet = (wallet or "").strip()[:80] or None
        if clean_wallet or clean_anonymous_id:
            for player in self.room.players:
                same_wallet = bool(clean_wallet and player.wallet == clean_wallet)
                same_anonymous = bool(clean_anonymous_id and player.anonymous_id == clean_anonymous_id)
                if same_wallet or same_anonymous:
                    if player.name != clean_name:
                        player.name = clean_name
                        for colony in self.room.colonies.values():
                            if colony.player_id == player.player_id or (
                                player.wallet and colony.player_wallet == player.wallet
                            ) or (
                                player.anonymous_id and colony.player_anonymous_id == player.anonymous_id
                            ):
                                colony.name = clean_name
                        self.room.add_log(
                            "player_updated",
                            f"{player.name} updated their player name.",
                            {
                                "playerId": player.player_id,
                                "name": player.name,
                                "anonymousId": player.anonymous_id,
                                "wallet": player.wallet,
                            },
                        )
                    return player
        player = PlayerState(
            player_id=f"player_{uuid.uuid4().hex[:8]}",
            name=clean_name,
            anonymous_id=clean_anonymous_id,
            wallet=clean_wallet,
        )
        self.room.players.append(player)
        self.room.add_log(
            "player_joined",
            f"{player.name} joined the room.",
            {
                "playerId": player.player_id,
                "name": player.name,
                "anonymousId": player.anonymous_id,
                "wallet": player.wallet,
            },
        )
        return player

    def _find_player(
        self,
        player_id: str | None = None,
        anonymous_id: str | None = None,
        wallet: str | None = None,
    ) -> PlayerState | None:
        for player in self.room.players:
            if player_id and player.player_id == player_id:
                return player
            if anonymous_id and player.anonymous_id == anonymous_id:
                return player
            if wallet and player.wallet == wallet:
                return player
        return None

    def update_colony_strategy(
        self,
        colony_id: str,
        *,
        style: str | None = None,
        favorite_context: str | None = None,
        info_need: str | None = None,
    ) -> ColonyState:
        if self.room.status not in STRATEGY_EDITABLE_STATUSES:
            raise ValueError("strategies can only be changed before or during a match")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")
        if style is None and favorite_context is None and info_need is None:
            raise ValueError("provide at least one colony strategy field")

        next_style = colony.style
        next_favorite_context = colony.favorite_context
        next_info_need = colony.info_need
        if style is not None:
            style = normalize_style(style)
            if style not in VALID_STYLES:
                raise ValueError("style must be cautious, balanced or aggressive")
            next_style = style
        if favorite_context is not None:
            favorite_context = normalize_context(favorite_context)
            if favorite_context not in VALID_CONTEXTS:
                raise ValueError("favorite_context must be penalties, corners, momentum, chaos or balanced")
            next_favorite_context = favorite_context
        if info_need is not None:
            info_need = normalize_info_need(info_need)
            if info_need not in VALID_INFO_NEEDS:
                raise ValueError("info_need must be low, medium or high")
            next_info_need = info_need

        with colony.strategy_lock:
            colony.style = next_style
            colony.favorite_context = next_favorite_context
            colony.info_need = next_info_need
            colony.strategy_revision += 1
            revision = colony.strategy_revision

        self.room.add_log(
            "strategy_updated",
            (
                f"{colony.name} strategy updated: {colony.style}, {colony.favorite_context}, "
                f"info {colony.info_need}. New orders apply from the next decision window."
            ),
            {
                "colonyId": colony.colony_id,
                "style": colony.style,
                "favoriteContext": colony.favorite_context,
                "infoNeed": colony.info_need,
                "strategyRevision": revision,
            },
        )
        return colony

    def rally(self, colony_id: str, opportunity_id: str) -> int:
        raise ValueError("Rally is unavailable in Sugar V0: every market has a fixed 2 Sugar stake.")

        if self.room.status not in {"running_replay", "running_live"}:
            raise ValueError("The match is not live.")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")

        prediction = next(
            (
                candidate
                for candidate in self.room.predictions.values()
                if candidate.colony_id == colony_id
                and candidate.opportunity_id == opportunity_id
                and not candidate.resolved
            ),
            None,
        )
        if not prediction:
            raise ValueError("Your ants sat this market out — no prediction to rally.")
        if prediction.rallied:
            raise ValueError("Your ants already rallied on this market.")

        existing_ant_ids = set(prediction.ant_ids)
        idle_ants = [
            ant
            for ant in colony.alive_ants
            if ant.is_active(self.room.event_index) and ant.ant_id not in existing_ant_ids
        ]
        if not idle_ants:
            raise ValueError("No idle ants left to rally.")

        loss_per_ant = RESOURCE_LOSS_MULTIPLIER[prediction.option.risk]
        available_food = max(0, colony.food - colony.food_reserved)
        collateral_budget = available_food - RALLY_COST
        max_affordable_ants = int(collateral_budget // loss_per_ant)
        if max_affordable_ants <= 0:
            raise ValueError("Not enough available Sugar to rally and cover the added risk.")

        chosen = idle_ants[: min(RALLY_ANTS, max_affordable_ants)]
        added = len(chosen)
        added_ant_ids = [ant.ant_id for ant in chosen]
        added_reserved_food = int(round(added * loss_per_ant))
        colony.food -= RALLY_COST
        colony.memory.food_net -= RALLY_COST
        colony.food_reserved += added_reserved_food
        prediction.reserved_food += added_reserved_food
        prediction.ant_ids.extend(added_ant_ids)
        prediction.rallied = True
        self.room.add_log(
            "rally",
            f"{colony.name} rallies — {added} ants join {prediction.option.label} (-3 Sugar).",
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity_id,
                "predictionId": prediction.prediction_id,
                "ants": added,
                "antIds": list(prediction.ant_ids),
                "antIdsAdded": added_ant_ids,
                "antStrategiesAdded": {
                    ant.ant_id: dict(ant_strategy_state(ant, colony))
                    for ant in chosen
                },
                "option": prediction.option.log_state(),
                "cost": RALLY_COST,
                "foodReservedAdded": added_reserved_food,
                "foodReserved": prediction.reserved_food,
                "strategyRevision": colony.strategy_revision,
            },
        )
        return added

    def recall(self, colony_id: str, opportunity_id: str) -> int:
        raise ValueError("Recall is unavailable in Sugar V0: funded positions stay fixed until settlement.")

        if self.room.status not in {"running_replay", "running_live"}:
            raise ValueError("The match is not live.")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")

        prediction = next(
            (
                candidate
                for candidate in self.room.predictions.values()
                if candidate.colony_id == colony_id
                and candidate.opportunity_id == opportunity_id
                and not candidate.resolved
            ),
            None,
        )
        if not prediction:
            raise ValueError("Your ants sat this market out — nothing to recall.")

        removable = min(RECALL_ANTS, len(prediction.ant_ids) - 1)
        if removable <= 0:
            raise ValueError("Your last ant won't abandon the call.")

        removed_ant_ids = list(prediction.ant_ids[-removable:])
        released_reserved_food = min(
            prediction.reserved_food,
            int(round(removable * RESOURCE_LOSS_MULTIPLIER[prediction.option.risk])),
        )
        del prediction.ant_ids[-removable:]
        prediction.reserved_food -= released_reserved_food
        colony.food_reserved = max(0, colony.food_reserved - released_reserved_food)
        self.room.add_log(
            "recall",
            f"{colony.name} recalls {removable} ants from {prediction.option.label}.",
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity_id,
                "predictionId": prediction.prediction_id,
                "ants": removable,
                "antIds": list(prediction.ant_ids),
                "antIdsRemoved": removed_ant_ids,
                "option": prediction.option.log_state(),
                "foodReservedReleased": released_reserved_food,
                "foodReserved": prediction.reserved_food,
            },
        )
        return removable

    def switch_call(self, colony_id: str, opportunity_id: str, option_id: str) -> None:
        raise ValueError("Switching is unavailable in Sugar V0: the colony follows its ant majority.")

        if self.room.status not in {"running_replay", "running_live"}:
            raise ValueError("The match is not live.")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")

        prediction = next(
            (
                candidate
                for candidate in self.room.predictions.values()
                if candidate.colony_id == colony_id
                and candidate.opportunity_id == opportunity_id
                and not candidate.resolved
            ),
            None,
        )
        if not prediction:
            raise ValueError("Your ants sat this market out — nothing to switch.")
        if prediction.switched:
            raise ValueError("Your colony already pivoted on this market.")

        opportunity = self.room.opportunities.get(opportunity_id)
        new_option = next(
            (option for option in opportunity.options if option.option_id == option_id),
            None,
        ) if opportunity else None
        if not new_option:
            raise ValueError("That option is not on this market.")
        if new_option.option_id == prediction.option.option_id:
            raise ValueError("Your ants are already on that call.")
        if colony.food < SWITCH_COST:
            raise ValueError("Not enough Sugar to pivot (needs 2).")

        previous_option = prediction.option
        next_reserved_food = int(round(len(prediction.ant_ids) * RESOURCE_LOSS_MULTIPLIER[new_option.risk]))
        reserved_food_delta = next_reserved_food - prediction.reserved_food
        available_food = max(0, colony.food - colony.food_reserved)
        required_available_food = max(0, SWITCH_COST + reserved_food_delta)
        if available_food < required_available_food:
            raise ValueError("Not enough available Sugar to pivot and cover the new risk.")

        colony.food -= SWITCH_COST
        colony.memory.food_net -= SWITCH_COST
        colony.food_reserved = max(0, colony.food_reserved + reserved_food_delta)
        prediction.reserved_food = next_reserved_food
        prediction.option = new_option
        prediction.switched = True
        self.room.add_log(
            "switch",
            f"{colony.name} pivots to {new_option.label} (-2 Sugar).",
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity_id,
                "predictionId": prediction.prediction_id,
                "optionId": option_id,
                "antIds": list(prediction.ant_ids),
                "option": new_option.log_state(),
                "previousOption": previous_option.log_state(),
                "cost": SWITCH_COST,
                "foodReservedDelta": reserved_food_delta,
                "foodReserved": prediction.reserved_food,
            },
        )

    def update_ant_strategy(
        self,
        colony_id: str,
        ant_id: str,
        *,
        style: str | None = None,
        favorite_context: str | None = None,
        info_need: str | None = None,
        analysis_role: str | None = None,
        inherit_global: bool = False,
    ) -> AntState:
        if self.room.status not in STRATEGY_EDITABLE_STATUSES:
            raise ValueError("ant strategies can only be changed before or during a match")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")
        ant = find_ant(colony, ant_id)
        if not ant:
            raise ValueError("ant not found")
        if not ant.alive:
            raise ValueError("dead ants cannot receive new orders")

        if (
            not inherit_global
            and style is None
            and favorite_context is None
            and info_need is None
            and analysis_role is None
        ):
            raise ValueError("provide an ant strategy or set inheritGlobal to true")
        if style is not None:
            style = normalize_style(style)
            if style not in VALID_STYLES:
                raise ValueError("style must be cautious, balanced or aggressive")
        if favorite_context is not None:
            favorite_context = normalize_context(favorite_context)
            if favorite_context not in VALID_CONTEXTS:
                raise ValueError("favorite_context must be penalties, corners, momentum, chaos or balanced")
        if info_need is not None:
            info_need = normalize_info_need(info_need)
            if info_need not in VALID_INFO_NEEDS:
                raise ValueError("info_need must be low, medium or high")
        if analysis_role is not None:
            analysis_role = str(analysis_role).strip().casefold()
            if analysis_role not in VALID_ANALYSIS_ROLES:
                raise ValueError("analysis_role must be reactive, statistical or situational")

        with colony.strategy_lock:
            if inherit_global:
                ant.style_override = None
                ant.favorite_context_override = None
                ant.info_need_override = None
            else:
                if style is not None:
                    ant.style_override = style
                if favorite_context is not None:
                    ant.favorite_context_override = favorite_context
                if info_need is not None:
                    ant.info_need_override = info_need
            # The analysis role is ant-only: there is no colony-level role to
            # inherit. Apply it independently so legacy `inheritGlobal` calls
            # cannot erase an order those clients do not know about.
            if analysis_role is not None:
                ant.analysis_role_override = analysis_role
            colony.strategy_revision += 1
            revision = colony.strategy_revision
            strategy = ant_strategy_state(ant, colony)
        self.room.add_log(
            "ant_strategy_updated",
            (
                f"{colony.name} updates {ant.ant_id}: {strategy['style']}, "
                f"{strategy['favoriteContext']}, info {strategy['infoNeed']}, "
                f"role {strategy['analysisRole']}."
            ),
            {
                "colonyId": colony.colony_id,
                "antId": ant.ant_id,
                "strategy": strategy,
                "strategyRevision": revision,
            },
        )
        return ant

    def process_events(self, events: Iterable[dict[str, Any]]) -> None:
        self.room.status = "running_replay"
        for event in events:
            self.process_event(event)
        self.finish_game(mode="replay")

    def open_baseline_markets(self, source_event: dict[str, Any] | None = None, *, reason: str = "live_baseline") -> int:
        if not self.room.colonies:
            return 0
        before_log_count = len(self.room.log)
        self.process_event(build_baseline_market_event(self.room, source_event, reason=reason))
        return len([event for event in self.room.log[before_log_count:] if event.kind == "opportunity"])

    def finish_game(self, *, mode: str = "replay") -> None:
        if self.room.status == "finished":
            return
        self._finish_open_markets()
        self._sync_agent_usage()
        self.room.status = "finished"
        cost_message = describe_agent_usage_cost(self.room.agent_usage)
        final_message = "Live match finished, final leaderboard available." if mode == "live" else "Replay finished, final leaderboard available."
        if cost_message:
            final_message = f"{final_message} {cost_message}"
        self.room.add_log(
            "game_finished",
            final_message,
            {"leaderboard": self.room.public_state()["colonies"], "agentUsage": self.room.agent_usage},
        )

    def process_event(self, event: dict[str, Any]) -> None:
        self.room.event_index += 1
        # A timed window is half-open: an event at its deadline belongs to the
        # next window, not the one that just ended. Expire those positions
        # before evaluating the incoming event so a late goal cannot win a
        # goal-next-10 market. Markets without deadlines still evaluate it.
        self._expire_predictions(event)
        self._settle_predictions(event)
        if self.room.match_state:
            self.room.match_state.update(event)
        for colony in self.room.colonies.values():
            self._apply_colony_upkeep(colony)

        opportunities = build_opportunities(event, self.room.event_index, self.room.match_state)
        for opportunity_index, opportunity in enumerate(opportunities):
            if not self._claim_opportunity_slot(opportunity):
                continue
            self.room.opportunities[opportunity.opportunity_id] = opportunity
            self.room.add_log("opportunity", opportunity.label, {"opportunity": opportunity.public_state()})
            strategy_snapshots = {
                colony.colony_id: colony_strategy_snapshot(colony)
                for colony in self.room.colonies.values()
            }
            remaining_windows = max(1, len(opportunities) - opportunity_index)
            for colony in self.room.colonies.values():
                available_food = max(0, colony.food - colony.food_reserved)
                self._decide_for_colony(
                    colony,
                    opportunity,
                    strategy_snapshot=strategy_snapshots[colony.colony_id],
                    food_budget=available_food // remaining_windows,
                )

        self._clear_old_opportunities(event)

    def _decide_for_colony(
        self,
        colony: ColonyState,
        opportunity: Opportunity,
        *,
        strategy_snapshot: dict[str, Any] | None = None,
        food_budget: int | None = None,
    ) -> None:
        if not colony.alive_ants:
            return
        if not colony.active_ants(self.room.event_index):
            self.room.add_log(
                "observe",
                f"{colony.name} has no active ants for this window.",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id},
            )
            return

        strategy_snapshot = strategy_snapshot or colony_strategy_snapshot(colony)
        first_vote = self._run_vote(colony, opportunity, strategy_snapshot=strategy_snapshot)
        self.room.add_log("vote", describe_vote(colony, first_vote), {"colonyId": colony.colony_id, "vote": public_vote(first_vote)})

        info_packet = None
        bought_info = False
        pre_agent_decision = None
        if first_vote.get("source") != "deepseek_ant_agents":
            pre_agent_decision = self._agent_decision(colony, opportunity, first_vote, stage="pre_info")
        if pre_agent_decision:
            self.room.add_log(
                "agent_decision",
                describe_agent_decision(colony, pre_agent_decision),
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id, "decision": pre_agent_decision.public_state()},
            )

        if should_buy_info(colony, opportunity, first_vote, agent_decision=pre_agent_decision):
            info_packet = build_info_packet(opportunity, colony, self.room.match_state)
            colony.food = max(0, colony.food - info_packet.cost)
            colony.memory.food_net -= info_packet.cost
            colony.memory.info_purchases += 1
            opportunity.info_bought_by.add(colony.colony_id)
            bought_info = True
            self.room.add_log(
                "info",
                f"{colony.name} spends {info_packet.cost} Sugar on an info packet.",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id, "info": info_packet.__dict__},
            )
            self.room.add_log(
                "info_result",
                f"Info received: {info_packet.summary}",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id},
            )
            final_vote = self._run_vote(
                colony,
                opportunity,
                info_packet=info_packet,
                strategy_snapshot=strategy_snapshot,
            )
            self.room.add_log("vote", describe_vote(colony, final_vote, after_info=True), {"colonyId": colony.colony_id, "vote": public_vote(final_vote)})
            final_agent_decision = None
            if final_vote.get("source") != "deepseek_ant_agents":
                final_agent_decision = self._agent_decision(colony, opportunity, final_vote, stage="post_info", info_packet=info_packet)
            if final_agent_decision:
                self.room.add_log(
                    "agent_decision",
                    describe_agent_decision(colony, final_agent_decision),
                    {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id, "decision": final_agent_decision.public_state()},
                )
        else:
            final_vote = first_vote
            final_agent_decision = pre_agent_decision

        prediction = create_prediction(
            colony,
            opportunity,
            final_vote,
            self.room.event_index,
            bought_info=bought_info,
            agent_decision=final_agent_decision,
            strategy_style=str(strategy_snapshot["style"]),
            food_budget=food_budget,
        )
        if not prediction:
            entry = entry_vote_state(
                opportunity,
                final_vote,
                str(strategy_snapshot["style"]),
            )
            available_sugar = max(0, colony.food - colony.food_reserved)
            reserve_capacity = max(0, MAX_RESERVED_SUGAR - colony.food_reserved)
            if available_sugar < MARKET_RISK_SUGAR:
                reason = "insufficient_sugar"
                message = f"{colony.name} cannot enter this market: fewer than 2 Sugar are available."
            elif reserve_capacity < MARKET_RISK_SUGAR:
                reason = "reserve_limit"
                message = f"{colony.name} observes this market: its 10 Sugar exposure limit is reached."
            elif entry["tie"]:
                reason = "tied_vote"
                message = f"{colony.name} observes this market: the ant vote is tied."
            else:
                reason = "low_consensus"
                message = (
                    f"{colony.name} observes this market: {entry['supportFraction']:.0%} consensus "
                    f"is below its {entry['entryThreshold']:.0%} threshold."
                )
            self.room.add_log(
                "observe",
                message,
                {
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "reason": reason,
                    "sugar": colony.food,
                    "sugarAvailable": available_sugar,
                    "requiredSugar": MARKET_RISK_SUGAR,
                    "sugarReserved": colony.food_reserved,
                    "maxReservedSugar": MAX_RESERVED_SUGAR,
                    "consensus": entry["supportFraction"],
                    "supportFraction": entry["supportFraction"],
                    "entryThreshold": entry["entryThreshold"],
                    "topVoteCount": entry["topVoteCount"],
                    "activeAnts": entry["activeCount"],
                    "topOptionId": entry["option"].option_id if entry["option"] else None,
                    "tie": entry["tie"],
                    # Backward-compatible aliases.
                    "food": colony.food,
                    "foodAvailable": available_sugar,
                    "requiredFood": MARKET_RISK_SUGAR,
                },
            )
            return

        self.room.predictions[prediction.prediction_id] = prediction
        chosen_decisions = {
            str(item.get("antId")): {
                "vote": item.get("vote"),
                "weight": round(float(item.get("weight") or 0), 3),
                "reason": str(item.get("reason") or "")[:180],
            }
            for item in final_vote.get("predictions", {}).get(prediction.option.option_id, [])
            if str(item.get("antId") or "") in prediction.ant_ids
        }
        ant_strategies = {
            ant_id: dict(strategy_snapshot.get("ants", {}).get(ant_id) or {})
            for ant_id in prediction.ant_ids
        }
        self.room.add_log(
            "prediction",
            (
                f"{colony.name} enters {prediction.option.label}: {len(prediction.ant_ids)}/"
                f"{max(1, int(final_vote.get('activeCount') or 0))} ant votes "
                f"({prediction.support_fraction:.0%}), 2 Sugar locked."
            ),
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity.opportunity_id,
                "predictionId": prediction.prediction_id,
                "option": prediction.option.log_state(),
                "ants": len(prediction.ant_ids),
                "antIds": list(prediction.ant_ids),
                "antDecisions": chosen_decisions,
                "antStrategies": ant_strategies,
                "market": opportunity.public_state(),
                "sugarReserved": prediction.reserved_food,
                "riskSugar": MARKET_RISK_SUGAR,
                "rewardSugar": prediction.option.reward_sugar,
                "consensus": prediction.support_fraction,
                "supportFraction": prediction.support_fraction,
                "entryThreshold": prediction.entry_threshold,
                "foodReserved": prediction.reserved_food,
                "sugarBudget": food_budget,
                "foodBudget": food_budget,
                "infoBought": bought_info,
                "strategyRevision": strategy_snapshot["revision"],
            },
        )

    def _run_vote(
        self,
        colony: ColonyState,
        opportunity: Opportunity,
        *,
        info_packet: InfoPacket | None = None,
        strategy_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        decide_ants = getattr(self.decision_agent, "decide_ants", None)
        if not callable(decide_ants):
            raise RuntimeError("DeepSeek agent required: no local policy is allowed.")

        ant_counts = colony_ant_counts(colony, self.room.event_index)
        active_count = ant_counts["activeCount"]
        stage_label = "after info" if info_packet else "before info"
        self.room.add_log(
            "ant_agent_start",
            f"{colony.name}: starting {active_count} individual DeepSeek calls {stage_label}.",
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity.opportunity_id,
                "activeCount": active_count,
                "aliveCount": ant_counts["aliveCount"],
                "engagedCount": ant_counts["engagedCount"],
                "woundedCount": ant_counts["woundedCount"],
                "stage": "post_info" if info_packet else "pre_info",
            },
        )
        agent_vote = self._ant_agent_vote(
            colony,
            opportunity,
            info_packet=info_packet,
            strategy_snapshot=strategy_snapshot,
        )
        if agent_vote:
            self.room.add_log(
                "ant_agent_vote",
                describe_ant_agent_vote(colony, agent_vote),
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id, "vote": public_vote(agent_vote)},
            )
            return agent_vote

        raise RuntimeError("DeepSeek did not produce any usable vote.")

    def _ant_agent_vote(
        self,
        colony: ColonyState,
        opportunity: Opportunity,
        *,
        info_packet: InfoPacket | None = None,
        strategy_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        decide_ants = getattr(self.decision_agent, "decide_ants", None)
        if not callable(decide_ants):
            raise RuntimeError("DeepSeek agent required: no local policy is allowed.")

        active_ants = colony.active_ants(self.room.event_index)
        if not active_ants:
            return None

        ant_counts = colony_ant_counts(colony, self.room.event_index)
        stage = "post_info" if info_packet else "pre_info"
        orders = strategy_snapshot or colony_strategy_snapshot(colony)
        signal_pack = build_market_signal_pack(self.room.match_state, opportunity)
        agent_reliability = agent_reliability_context(signal_pack["reliability"])
        agent_opportunity = agent_opportunity_context(opportunity)
        agent_market = agent_market_context(opportunity)
        directional_vote_required = self.room.room_kind == "player" and self.room.mode == "live"
        if directional_vote_required:
            agent_market["availableVotes"] = [
                item
                for item in agent_market.get("availableVotes", [])
                if item.get("vote") != "abstain"
            ]
        agent_market.pop("minute", None)
        if opportunity.context != "penalties":
            agent_market.pop("teamLabel", None)
        context = {
            "match": {
                "fixtureId": self.room.fixture_id,
                "participant1": self.room.participant1,
                "participant2": self.room.participant2,
                "dataReliability": agent_reliability,
            },
            "colony": {
                "name": colony.name,
                "strategyRevision": orders["revision"],
                "sugar": colony.food,
                "sugarReserved": colony.food_reserved,
                "sugarAvailable": max(0, colony.food - colony.food_reserved),
                "riskPerMarket": MARKET_RISK_SUGAR,
                "maxReservedSugar": MAX_RESERVED_SUGAR,
                # Backward-compatible aliases for older agent adapters.
                "food": colony.food,
                "foodReserved": colony.food_reserved,
                "foodAvailable": max(0, colony.food - colony.food_reserved),
                "antsAlive": ant_counts["aliveCount"],
                "antsActive": ant_counts["activeCount"],
                "antsEngaged": ant_counts["engagedCount"],
                "antsWounded": ant_counts["woundedCount"],
            },
            "rules": {
                "stage": stage,
                "agentCallMode": self.room.agent_call_mode,
                "decisionFormat": "Each ant must answer with one vote from market.availableVotes.",
                "confidenceDisabled": True,
                "infoFeatureEnabled": False,
                "infoFeatureReason": "Paid info is disabled for now and will return later with concrete info types.",
                "oneDecisionPerAnt": True,
                "economy": "Each entered market risks exactly 2 Sugar; rewards are the option's rewardSugar.",
                "doctrineAppliedAfterVotes": True,
                "directionalVoteRequired": directional_vote_required,
            },
            "opportunity": agent_opportunity,
            "market": agent_market,
        }
        ant_orders = orders.get("ants") or {}
        ants = []
        analysis_roles: dict[str, str] = {}
        for ant in active_ants:
            ant_strategy = ant_orders.get(ant.ant_id) or ant_strategy_state(ant, colony)
            analysis_role = str(ant_strategy.get("analysisRole") or effective_analysis_role(ant))
            if analysis_role not in VALID_ANALYSIS_ROLES:
                analysis_role = effective_analysis_role(ant)
            analysis_roles[ant.ant_id] = analysis_role
            agent_strategy = {"analysisRole": analysis_role}
            ants.append(
                ant_agent_context(
                    ant,
                    opportunity,
                    colony,
                    strategy=agent_strategy,
                    role_evidence=role_evidence_from_signal_pack(signal_pack, analysis_role),
                    reliability=agent_reliability,
                )
            )
        decisions = decide_ants(game_id=self.room.game_id, stage=stage, context=context, ants=ants)
        self._sync_agent_usage()
        vote = vote_from_ant_agent_decisions(
            colony,
            opportunity,
            self.room.event_index,
            decisions or [],
            info_packet=info_packet,
            reliability=signal_pack["reliability"],
            analysis_roles=analysis_roles,
        )
        if not vote:
            raise RuntimeError("DeepSeek did not produce any usable vote.")
        if vote.get("agentDecisionCount") != vote.get("activeCount"):
            raise RuntimeError(
                f"DeepSeek controlled {vote.get('agentDecisionCount', 0)}/{vote.get('activeCount', 0)} voting ants."
            )
        return vote

    def _sync_agent_usage(self) -> None:
        usage_for_game = getattr(self.decision_agent, "usage_for_game", None)
        if not callable(usage_for_game):
            return
        try:
            self.room.agent_usage = usage_for_game(self.room.game_id)
        except Exception:
            return

    def _apply_colony_upkeep(self, colony: ColonyState) -> None:
        # Sugar V0 keeps exactly the starting ant roster. There is no upkeep,
        # starvation, death, larva incubation, or hatching.
        return

    def _consume_food(self, colony: ColonyState) -> None:
        return

    def _hatch_larvae(self, colony: ColonyState) -> None:
        return

    def _agent_decision(
        self,
        colony: ColonyState,
        opportunity: Opportunity,
        vote: dict[str, Any],
        *,
        stage: str,
        info_packet: InfoPacket | None = None,
    ) -> ColonyAgentDecision | None:
        if not self.decision_agent:
            return None
        context = {
            "match": {
                "fixtureId": self.room.fixture_id,
                "participant1": self.room.participant1,
                "participant2": self.room.participant2,
                "score": self.room.match_state.score if self.room.match_state else None,
                "possessionLabel": self.room.match_state.possession_label if self.room.match_state else None,
                "recentEvents": recent_event_brief(self.room.match_state),
            },
            "colony": colony.public_state(self.room.event_index),
            "colonyMemory": {
                "attempts": colony.memory.attempts,
                "wins": colony.memory.wins,
                "losses": colony.memory.losses,
                "sugarNet": colony.memory.food_net,
                "foodNet": colony.memory.food_net,
                "contextAttempts": colony.memory.context_attempts,
                "contextWins": colony.memory.context_wins,
            },
            "agentSquads": agent_squad_context(colony, self.room.event_index),
            "opportunity": opportunity.public_state(),
            "vote": public_vote(vote),
            "infoPacket": info_packet.__dict__ if info_packet else None,
        }
        decision = self.decision_agent.decide(game_id=self.room.game_id, stage=stage, context=context)
        self._sync_agent_usage()
        return decision

    def _claim_opportunity_slot(self, opportunity: Opportunity) -> bool:
        key = self._opportunity_slot_key(opportunity)
        if opportunity.context in ROLLING_WINDOW_CONTEXTS.union({"penalties"}) and self._has_open_market_slot(key):
            return False
        if opportunity.context != "penalties" and len(self._open_standard_market_contexts()) >= MAX_OPEN_STANDARD_MARKETS:
            return False

        # TXLine can emit an award, a VAR confirmation and a result record for
        # the same penalty. A shared penalty key plus a five-minute match-clock
        # cooldown lets the award create one market while confirmations are
        # ignored. Result records are filtered earlier by ``event_contexts``.
        cadence_key = key if opportunity.context == "penalties" else "standard_market_arrival"
        clock = opportunity_clock_seconds(opportunity)
        if clock is not None:
            last_clock = self.room.last_opportunity_clock_by_key.get(cadence_key)
            cooldown = MARKET_COOLDOWN_SECONDS[opportunity.context]
            if last_clock is not None and clock - last_clock < cooldown:
                return False
            self.room.last_opportunity_clock_by_key[cadence_key] = clock
            self.room.last_opportunity_event_index_by_key[cadence_key] = self.room.event_index
            return True

        # Rare malformed records without a minute/clock keep a conservative
        # event-index fallback so a feed issue cannot flood the room.
        cooldown_by_context = {
            "penalties": 2,
            "goal_next_10": 24,
            "next_goal_team": 24,
            "next_corner": 24,
            "next_card": 24,
            "next_substitution": 24,
            "next_free_kick": 24,
            "next_yellow_card": 24,
            "next_foul": 24,
        }
        last_event_index = self.room.last_opportunity_event_index_by_key.get(cadence_key, -10_000)
        if self.room.event_index - last_event_index < cooldown_by_context[opportunity.context]:
            return False
        self.room.last_opportunity_event_index_by_key[cadence_key] = self.room.event_index
        return True

    def _has_open_market_slot(self, key: str) -> bool:
        for opportunity in self.room.opportunities.values():
            if self._opportunity_slot_key(opportunity) == key:
                return True
        return False

    def _open_standard_market_contexts(self) -> set[str]:
        return {
            opportunity.context
            for opportunity in self.room.opportunities.values()
            if opportunity.context != "penalties"
        }

    def _opportunity_slot_key(self, opportunity: Opportunity) -> str:
        team_key = opportunity.team if opportunity.team is not None else opportunity.team_label or "any"
        if opportunity.context in {"penalties"}:
            return f"{opportunity.context}:{team_key}"
        return opportunity.context

    def _settle_predictions(self, event: dict[str, Any]) -> None:
        for prediction in list(self.room.predictions.values()):
            if prediction.resolved or prediction.created_event_index >= self.room.event_index:
                continue
            opportunity = self.room.opportunities.get(prediction.opportunity_id)
            if not opportunity:
                continue
            if penalty_cancelled_for_opportunity(opportunity, event):
                self._void_prediction(prediction, opportunity, reason="penalty_cancelled")
                continue
            result = evaluate_prediction_event(prediction, opportunity, event)
            if result is not None:
                self._apply_settlement(
                    prediction,
                    opportunity,
                    win=result,
                    reason="resolved",
                    outcome=resolved_market_outcome(opportunity, event, reason="resolved"),
                )

    def _expire_predictions(self, event: dict[str, Any]) -> None:
        clock = event.get("clockSeconds")
        for prediction in list(self.room.predictions.values()):
            if prediction.resolved:
                continue
            opportunity = self.room.opportunities.get(prediction.opportunity_id)
            if not opportunity or opportunity.context in NO_DEADLINE_CONTEXTS:
                continue
            expired_by_clock = clock is not None and prediction.deadline_clock is not None and clock >= prediction.deadline_clock
            # Event counts are only a fallback for feeds that do not provide a match clock.
            expired_by_events = (
                prediction.deadline_clock is None
                and prediction.deadline_event_index is not None
                and self.room.event_index >= prediction.deadline_event_index
            )
            if not (expired_by_clock or expired_by_events):
                continue
            win = prediction.option.target in {"nothing", "no_goal"}
            self._apply_settlement(
                prediction,
                opportunity,
                win=win,
                reason="expired",
                outcome=resolved_market_outcome(opportunity, None, reason="expired"),
            )

    def _apply_settlement(
        self,
        prediction: Prediction,
        opportunity: Opportunity,
        *,
        win: bool,
        reason: str,
        outcome: dict[str, Any] | None = None,
    ) -> None:
        colony = self.room.colonies.get(prediction.colony_id)
        if not colony:
            return

        prediction.resolved = True
        colony.food_reserved = max(0, colony.food_reserved - prediction.reserved_food)
        colony.memory.attempts += 1
        colony.memory.context_attempts[opportunity.context] = colony.memory.context_attempts.get(opportunity.context, 0) + 1
        for ant_id in prediction.ant_ids:
            ant = find_ant(colony, ant_id)
            if ant:
                ant.memory.attempts_by_context[opportunity.context] = ant.memory.attempts_by_context.get(opportunity.context, 0) + 1

        if win:
            sugar_gain = prediction.option.reward_sugar
            colony.food += sugar_gain
            colony.memory.wins += 1
            colony.memory.food_net += sugar_gain
            colony.memory.context_wins[opportunity.context] = colony.memory.context_wins.get(opportunity.context, 0) + 1
            for ant_id in prediction.ant_ids:
                ant = find_ant(colony, ant_id)
                if ant:
                    ant.influence = clamp(ant.influence + 0.04 * prediction.option.multiplier, 0.35, 2.25)
                    ant.memory.wins_by_context[opportunity.context] = ant.memory.wins_by_context.get(opportunity.context, 0) + 1
                    ant.memory.recent_losses = 0
                    if prediction.info_bought:
                        ant.memory.info_successes += 1
            message = f"Result {colony.name}: +{sugar_gain} Sugar on {prediction.option.label}."
            data = {
                "win": True,
                "sugar": sugar_gain,
                "sugarDelta": sugar_gain,
                "rewardSugar": sugar_gain,
                "riskSugar": MARKET_RISK_SUGAR,
                # Backward-compatible aliases.
                "food": sugar_gain,
                "resourceDelta": sugar_gain,
                "reason": reason,
            }
        else:
            actual_loss = min(colony.food, MARKET_RISK_SUGAR)
            colony.food -= actual_loss
            colony.memory.food_net -= actual_loss
            selected = [find_ant(colony, ant_id) for ant_id in prediction.ant_ids]
            selected = [ant for ant in selected if ant is not None]
            for ant in selected:
                ant.influence = clamp(ant.influence * 0.94, 0.35, 2.25)
                ant.memory.losses_by_context[opportunity.context] = ant.memory.losses_by_context.get(opportunity.context, 0) + 1
                ant.memory.recent_losses += 1
            colony.memory.losses += 1
            message = f"Result {colony.name}: -{actual_loss} Sugar on {prediction.option.label}."
            data = {
                "win": False,
                "sugar": -actual_loss,
                "sugarDelta": -actual_loss,
                "rewardSugar": prediction.option.reward_sugar,
                "riskSugar": MARKET_RISK_SUGAR,
                # Backward-compatible aliases.
                "food": -actual_loss,
                "resourceDelta": -actual_loss,
                "resourceLoss": actual_loss,
                "reason": reason,
            }

        self.room.add_log(
            "settlement",
            message,
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "option": prediction.option.log_state(),
                "ants": len(prediction.ant_ids),
                "antIds": list(prediction.ant_ids),
                "sugarReserved": prediction.reserved_food,
                "foodReserved": prediction.reserved_food,
                "consensus": prediction.support_fraction,
                "supportFraction": prediction.support_fraction,
                "entryThreshold": prediction.entry_threshold,
                "resolvedOutcome": outcome,
                **data,
            },
        )

    def _finish_open_markets(self) -> None:
        closed = 0
        for prediction in list(self.room.predictions.values()):
            if prediction.resolved:
                continue
            opportunity = self.room.opportunities.get(prediction.opportunity_id)
            if not opportunity:
                continue
            if opportunity.context == "goal_next_10":
                self._apply_settlement(
                    prediction,
                    opportunity,
                    win=prediction.option.target == "no_goal",
                    reason="full_time",
                    outcome=resolved_market_outcome(opportunity, None, reason="full_time"),
                )
            else:
                self._void_prediction(prediction, opportunity, reason="full_time")
            closed += 1
        self.room.opportunities.clear()
        if closed:
            self.room.add_log(
                "markets_closed",
                f"Full time: {closed} open prediction(s) are closed.",
                {"closed": closed, "reason": "full_time"},
            )

    def _void_prediction(self, prediction: Prediction, opportunity: Opportunity, *, reason: str) -> None:
        colony = self.room.colonies.get(prediction.colony_id)
        if not colony:
            return
        prediction.resolved = True
        colony.food_reserved = max(0, colony.food_reserved - prediction.reserved_food)
        self.room.add_log(
            "void",
            f"{colony.name}: position voided on {prediction.option.label}; 2 Sugar released.",
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "option": prediction.option.log_state(),
                "reason": reason,
                "ants": len(prediction.ant_ids),
                "antIds": list(prediction.ant_ids),
                "sugarReserved": prediction.reserved_food,
                "riskSugar": MARKET_RISK_SUGAR,
                "rewardSugar": prediction.option.reward_sugar,
                "foodReserved": prediction.reserved_food,
            },
        )

    def _clear_old_opportunities(self, event: dict[str, Any] | None = None) -> None:
        for opportunity_id, opportunity in list(self.room.opportunities.items()):
            opportunity_predictions = [
                prediction
                for prediction in self.room.predictions.values()
                if prediction.opportunity_id == opportunity_id
            ]
            has_open_prediction = any(not prediction.resolved for prediction in opportunity_predictions)
            if has_open_prediction or self.room.event_index <= opportunity.created_event_index:
                continue
            if opportunity_predictions:
                self.room.opportunities.pop(opportunity_id, None)
                continue
            # An abstained market is still a live market. Keep it visible until
            # the matching football event occurs instead of removing it on the
            # very next (often unrelated) TXLine update.
            if event is None or not opportunity_resolved_by_event(opportunity, event):
                continue
            self.room.add_log(
                "market_closed",
                f"Market resolved without a position: {opportunity.label}",
                {
                    "opportunityId": opportunity_id,
                    "reason": "no_entries",
                    "positionCount": 0,
                    "market": opportunity.public_state(),
                    "resolvedOutcome": resolved_market_outcome(opportunity, event, reason="resolved"),
                },
            )
            self.room.opportunities.pop(opportunity_id, None)


class GameManager:
    def __init__(self, decision_agent: ColonyDecisionAgent | None = None) -> None:
        self.rooms: dict[str, GameRoom] = {}
        self.room_codes: dict[str, str] = {}
        self.live_tasks: dict[str, Any] = {}
        self.kickoff_tasks: dict[str, Any] = {}
        self.replay_tasks: dict[str, Any] = {}
        self.decision_agent = decision_agent

    def create_room(
        self,
        *,
        fixture_id: Any,
        participant1: str | None = None,
        participant2: str | None = None,
        seed: int | None = None,
        owner_anonymous_id: str | None = None,
        owner_wallet: str | None = None,
        owner_name: str | None = None,
        room_kind: RoomKind = "player",
        room_scope: RoomScope | None = None,
        room_code: str | None = None,
        competition: str | None = None,
        start_time: Any = None,
        start_time_iso: str | None = None,
        txline_validation: dict[str, Any] | None = None,
    ) -> GameRoom:
        game_id = f"game_{uuid.uuid4().hex[:10]}"
        clean_room_code = self._reserve_room_code(room_code)
        room = GameRoom(
            game_id=game_id,
            room_code=clean_room_code,
            fixture_id=fixture_id,
            participant1=participant1,
            participant2=participant2,
            competition=(competition or "").strip()[:120] or None,
            start_time=start_time,
            start_time_iso=(start_time_iso or "").strip()[:80] or None,
            txline_validation=dict(txline_validation) if txline_validation else None,
            owner_anonymous_id=(owner_anonymous_id or "").strip()[:80] or None,
            owner_wallet=(owner_wallet or "").strip()[:80] or None,
            owner_name=(owner_name or "").strip()[:32] or None,
            room_kind=room_kind,
            room_scope=room_scope,
            seed=seed if seed is not None else stable_seed(game_id, fixture_id) % 1_000_000,
        )
        creation_data = {
            "gameId": game_id,
            "roomCode": clean_room_code,
            "fixtureId": fixture_id,
            "ownerAnonymousId": room.owner_anonymous_id,
            "ownerWallet": room.owner_wallet,
            "ownerName": room.owner_name,
            "roomKind": room.room_kind,
        }
        if room.room_kind == "player":
            creation_data["roomScope"] = room.room_scope
        room.add_log(
            "game_created",
            f"Room {clean_room_code} created for fixture {fixture_id}.",
            creation_data,
        )
        self.rooms[game_id] = room
        self.room_codes[clean_room_code] = game_id
        return room

    def get_room(self, game_id: str) -> GameRoom | None:
        return self.rooms.get(game_id)

    def get_room_by_code(self, room_code: str) -> GameRoom | None:
        clean_room_code = normalize_room_code(room_code)
        game_id = self.room_codes.get(clean_room_code)
        return self.rooms.get(game_id) if game_id else None

    def register_room(self, room: GameRoom) -> GameRoom:
        self.rooms[room.game_id] = room
        self.room_codes[room.room_code] = room.game_id
        return room

    def _reserve_room_code(self, room_code: str | None = None) -> str:
        if room_code:
            clean_room_code = normalize_room_code(room_code)
            if len(clean_room_code) != 6:
                raise ValueError("room_code must contain exactly 6 digits")
            if self.room_codes.get(clean_room_code):
                raise ValueError("room_code is already in use")
            self.room_codes.setdefault(clean_room_code, "")
            return clean_room_code
        for _ in range(100):
            candidate = f"{random.randint(100000, 999999)}"
            if candidate not in self.room_codes:
                self.room_codes[candidate] = ""
                return candidate
        raise RuntimeError("Could not allocate a unique room code")

    def harness(self, game_id: str) -> GameHarness:
        room = self.rooms[game_id]
        return GameHarness(room, self.decision_agent)


def normalize_room_code(value: str | int | None) -> str:
    return "".join(character for character in str(value or "") if character.isdigit())[:6]


def generate_ants(colony: ColonyState) -> list[AntState]:
    rng = random.Random(colony.seed)
    # A colony must remain meaningfully diverse even for an unlucky seed. Give
    # every base archetype one representative (when the roster is large enough),
    # then use the configured weighted distribution for the remaining ants.
    guaranteed_archetypes = list(archetype_weights(colony))
    rng.shuffle(guaranteed_archetypes)
    ants: list[AntState] = []
    for index in range(colony.size):
        if index < len(guaranteed_archetypes):
            archetype = guaranteed_archetypes[index]
            ants.append(
                AntState(
                    ant_id=f"ant_{index:04d}",
                    archetype=archetype,
                    **traits_for_archetype(archetype, colony, rng),
                )
            )
        else:
            ants.append(spawn_ant(colony, index, rng))
    return ants


def clone_ant_for_new_match(ant: AntState) -> AntState:
    """Keep one ant's identity and standing orders, but reset match state.

    Regenerating a roster is not equivalent to carrying it into another match:
    ant generation depends on both a colony seed and its current global strategy.
    Copy the stable profile explicitly so mutable memory or participation state can
    never leak from the previous match.
    """

    return AntState(
        ant_id=ant.ant_id,
        archetype=ant.archetype,
        risk_appetite=ant.risk_appetite,
        info_hunger=ant.info_hunger,
        favorite_context=ant.favorite_context,
        confidence_threshold=ant.confidence_threshold,
        loss_sensitivity=ant.loss_sensitivity,
        momentum_bias=ant.momentum_bias,
        chaos_bias=ant.chaos_bias,
        base_influence=ant.base_influence,
        influence=ant.base_influence,
        style_override=ant.style_override,
        favorite_context_override=ant.favorite_context_override,
        info_need_override=ant.info_need_override,
        analysis_role_override=ant.analysis_role_override,
    )


def ant_profile_state(ant: AntState) -> dict[str, Any]:
    """Serialize only the durable identity/personality of an ant."""

    return {
        "antId": ant.ant_id,
        "archetype": ant.archetype,
        "riskAppetite": ant.risk_appetite,
        "infoHunger": ant.info_hunger,
        "naturalFocus": ant.favorite_context,
        "confidenceThreshold": ant.confidence_threshold,
        "lossSensitivity": ant.loss_sensitivity,
        "momentumBias": ant.momentum_bias,
        "chaosBias": ant.chaos_bias,
        "baseInfluence": ant.base_influence,
        "naturalAnalysisRole": natural_analysis_role(ant),
        "analysisRole": effective_analysis_role(ant),
        "analysisRoleOverride": ant.analysis_role_override,
        "roleSource": "custom" if ant.analysis_role_override else "archetype",
    }


def restore_ant_profile(ant: AntState, profile: Any) -> AntState:
    """Apply a stored static profile to a generated legacy fallback ant.

    Invalid or partial values retain the safely generated fallback. Match state
    such as influence changes, memory, wounds and engagements is intentionally
    absent from the durable profile.
    """

    if not isinstance(profile, dict):
        return ant
    stored_ant_id = profile.get("antId")
    if stored_ant_id is not None and str(stored_ant_id) != ant.ant_id:
        return ant

    archetype = str(profile.get("archetype") or "")
    if archetype in {"cautious", "balanced", "data_first", "opportunist", "momentum", "chaos"}:
        ant.archetype = archetype

    natural_focus = str(profile.get("naturalFocus") or "")
    if natural_focus in VALID_CONTEXTS:
        ant.favorite_context = natural_focus

    def stored_float(key: str, fallback: float, low: float, high: float) -> float:
        value = profile.get(key)
        if isinstance(value, bool):
            return fallback
        try:
            candidate = float(value)
        except (TypeError, ValueError):
            return fallback
        if not math.isfinite(candidate) or not low <= candidate <= high:
            return fallback
        return candidate

    ant.risk_appetite = stored_float("riskAppetite", ant.risk_appetite, 0.0, 1.0)
    ant.info_hunger = stored_float("infoHunger", ant.info_hunger, 0.0, 1.0)
    ant.confidence_threshold = stored_float(
        "confidenceThreshold", ant.confidence_threshold, 0.0, 1.0
    )
    ant.loss_sensitivity = stored_float("lossSensitivity", ant.loss_sensitivity, 0.0, 1.0)
    ant.momentum_bias = stored_float("momentumBias", ant.momentum_bias, 0.0, 1.0)
    ant.chaos_bias = stored_float("chaosBias", ant.chaos_bias, 0.0, 1.0)
    ant.base_influence = stored_float("baseInfluence", ant.base_influence, 0.35, 2.25)
    ant.influence = ant.base_influence
    stored_role_override = profile.get("analysisRoleOverride")
    if stored_role_override is None and profile.get("roleSource") == "custom":
        stored_role_override = profile.get("analysisRole")
    if stored_role_override in VALID_ANALYSIS_ROLES:
        ant.analysis_role_override = str(stored_role_override)
    return ant


def natural_analysis_role(ant: AntState) -> str:
    """Return the stable evidence lens attached to an ant's archetype."""

    return ANALYSIS_ROLE_BY_ARCHETYPE.get(ant.archetype, "situational")


def effective_analysis_role(ant: AntState) -> str:
    if ant.analysis_role_override in VALID_ANALYSIS_ROLES:
        return str(ant.analysis_role_override)
    return natural_analysis_role(ant)


def ant_strategy_state(ant: AntState, colony: ColonyState) -> dict[str, Any]:
    inherits_global = not any(
        (ant.style_override, ant.favorite_context_override, ant.info_need_override)
    )
    inherits_role = ant.analysis_role_override is None
    return {
        "style": ant.style_override or colony.style,
        "favoriteContext": ant.favorite_context_override or colony.favorite_context,
        "infoNeed": ant.info_need_override or colony.info_need,
        "analysisRole": effective_analysis_role(ant),
        "inheritsRole": inherits_role,
        "roleSource": "archetype" if inherits_role else "custom",
        "inheritsGlobal": inherits_global,
        "source": "colony" if inherits_global else "custom",
    }


def colony_strategy_snapshot(colony: ColonyState) -> dict[str, Any]:
    with colony.strategy_lock:
        return {
            "revision": colony.strategy_revision,
            "style": colony.style,
            "favoriteContext": colony.favorite_context,
            "infoNeed": colony.info_need,
            "ants": {
                ant.ant_id: dict(ant_strategy_state(ant, colony))
                for ant in colony.ants
            },
        }


def ant_public_state(ant: AntState, colony: ColonyState, event_index: int) -> dict[str, Any]:
    attempts = sum(ant.memory.attempts_by_context.values())
    wins = sum(ant.memory.wins_by_context.values())
    losses = sum(ant.memory.losses_by_context.values())
    if not ant.alive:
        status = "dead"
    elif ant.wounded_until_event > event_index:
        status = "wounded"
    else:
        status = "active"
    return {
        "antId": ant.ant_id,
        "archetype": ant.archetype,
        "status": status,
        "alive": ant.alive,
        "active": ant.is_active(event_index),
        "naturalFocus": ant.favorite_context,
        "influence": round(ant.influence, 3),
        "strategy": ant_strategy_state(ant, colony),
        "performance": {
            "attempts": attempts,
            "wins": wins,
            "losses": losses,
            "successRate": round(wins / attempts, 3) if attempts else None,
            "recentLosses": ant.memory.recent_losses,
        },
    }


def ant_bet_history(room: GameRoom, colony_id: str, ant_id: str) -> list[dict[str, Any]]:
    """Build one ant's durable betting ledger from persisted game log events."""
    opportunities: dict[str, dict[str, Any]] = {}
    resolutions: dict[str, GameLogEvent] = {}
    predictions: list[GameLogEvent] = []
    tactics: dict[str, list[GameLogEvent]] = {}

    for event in sorted(room.log, key=lambda item: item.index):
        data = event.data if isinstance(event.data, dict) else {}
        if event.kind == "opportunity":
            opportunity = data.get("opportunity")
            if isinstance(opportunity, dict) and opportunity.get("opportunityId"):
                opportunities[str(opportunity["opportunityId"])] = opportunity
        elif event.kind == "prediction":
            predictions.append(event)
        elif event.kind in {"rally", "recall", "switch"} and data.get("predictionId"):
            tactics.setdefault(str(data["predictionId"]), []).append(event)
        elif event.kind in {"settlement", "void"} and data.get("predictionId"):
            resolutions[str(data["predictionId"])] = event

    history: list[dict[str, Any]] = []
    for event in predictions:
        data = event.data if isinstance(event.data, dict) else {}
        if str(data.get("colonyId") or "") != colony_id:
            continue

        prediction_id = str(data.get("predictionId") or "")
        opportunity_id = str(data.get("opportunityId") or "")
        option = data.get("option") if isinstance(data.get("option"), dict) else {}
        market = data.get("market") if isinstance(data.get("market"), dict) else opportunities.get(opportunity_id, {})
        initial_ant_ids = [str(value) for value in data.get("antIds", [])] if isinstance(data.get("antIds"), list) else []
        current_ant_ids = list(initial_ant_ids)
        joined_event = event if ant_id in current_ant_ids else None
        recalled_event: GameLogEvent | None = None
        recalled_vote_count: int | None = None
        ant_decisions = data.get("antDecisions") if isinstance(data.get("antDecisions"), dict) else {}
        ant_strategies = data.get("antStrategies") if isinstance(data.get("antStrategies"), dict) else {}
        decision = ant_decisions.get(ant_id) if isinstance(ant_decisions.get(ant_id), dict) else {}
        strategy = ant_strategies.get(ant_id) if isinstance(ant_strategies.get(ant_id), dict) else None

        for tactic in tactics.get(prediction_id, []):
            tactic_data = tactic.data if isinstance(tactic.data, dict) else {}
            if tactic.kind == "rally":
                explicit_added = tactic_data.get("antIdsAdded")
                if isinstance(explicit_added, list):
                    added_ant_ids = [str(value) for value in explicit_added]
                else:
                    logged_ant_ids = tactic_data.get("antIds")
                    added_ant_ids = (
                        [str(value) for value in logged_ant_ids if str(value) not in current_ant_ids]
                        if isinstance(logged_ant_ids, list)
                        else []
                    )
                current_ant_ids.extend(value for value in added_ant_ids if value not in current_ant_ids)
                if ant_id in added_ant_ids:
                    recalled_event = None
                    recalled_vote_count = None
                    rallied_option = tactic_data.get("option")
                    if isinstance(rallied_option, dict):
                        option = rallied_option
                    added_strategies = (
                        tactic_data.get("antStrategiesAdded")
                        if isinstance(tactic_data.get("antStrategiesAdded"), dict)
                        else {}
                    )
                    added_strategy = added_strategies.get(ant_id)
                    if isinstance(added_strategy, dict):
                        strategy = added_strategy
                    decision = {"reason": "Joined through a live rally."}
                    if joined_event is None:
                        joined_event = tactic
            elif tactic.kind == "switch" and ant_id in current_ant_ids:
                switched_option = tactic_data.get("option")
                if isinstance(switched_option, dict):
                    option = switched_option
                else:
                    switched_option_id = str(tactic_data.get("optionId") or "")
                    market_options = market.get("options") if isinstance(market.get("options"), list) else []
                    option = next(
                        (
                            candidate
                            for candidate in market_options
                            if isinstance(candidate, dict)
                            and str(candidate.get("optionId") or candidate.get("option_id") or "") == switched_option_id
                        ),
                        option,
                    )
            elif tactic.kind == "recall":
                explicit_removed = tactic_data.get("antIdsRemoved")
                if isinstance(explicit_removed, list):
                    removed_ant_ids = [str(value) for value in explicit_removed]
                else:
                    remaining_ant_ids = tactic_data.get("antIds")
                    removed_ant_ids = (
                        [value for value in current_ant_ids if value not in {str(item) for item in remaining_ant_ids}]
                        if isinstance(remaining_ant_ids, list)
                        else []
                    )
                if ant_id in removed_ant_ids and ant_id in current_ant_ids:
                    recalled_event = tactic
                    recalled_vote_count = len(current_ant_ids)
                current_ant_ids = [value for value in current_ant_ids if value not in set(removed_ant_ids)]

        if joined_event is None:
            continue

        resolution = None if recalled_event else resolutions.get(prediction_id)
        resolution_data = resolution.data if resolution and isinstance(resolution.data, dict) else {}
        if recalled_event:
            status = "recalled"
        elif resolution and resolution.kind == "settlement":
            status = "won" if bool(resolution_data.get("win")) else "lost"
        elif resolution and resolution.kind == "void":
            status = "void"
        else:
            status = "open"

        if resolution:
            resolved_option = resolution_data.get("option")
            if isinstance(resolved_option, dict):
                option = resolved_option
        if recalled_event:
            vote_count = max(1, recalled_vote_count or 1)
        elif resolution:
            vote_count = max(1, _safe_history_int(resolution_data.get("ants"), len(current_ant_ids)))
        else:
            vote_count = max(1, len(current_ant_ids))

        sugar_at_risk = _safe_history_float(data.get("riskSugar"))
        if sugar_at_risk is None:
            sugar_at_risk = float(MARKET_RISK_SUGAR)
        resource_delta = (
            _safe_history_float(resolution_data.get("resourceDelta"))
            if resolution and resolution.kind == "settlement"
            else None
        )
        resolved_event = recalled_event or resolution
        resolved_data = (
            recalled_event.data
            if recalled_event and isinstance(recalled_event.data, dict)
            else resolution_data
        )

        history.append(
            {
                "predictionId": prediction_id,
                "opportunityId": opportunity_id,
                "status": status,
                "marketLabel": market.get("label") or "Market",
                "context": market.get("context"),
                "minute": market.get("minute"),
                "optionId": option.get("option_id") or option.get("optionId"),
                "optionLabel": option.get("label") or "Prediction",
                "risk": option.get("risk"),
                "multiplier": option.get("multiplier"),
                "rewardSugar": option.get("rewardSugar", option.get("reward_sugar")),
                "sugarAtRisk": sugar_at_risk,
                "colonySugarDelta": resource_delta,
                # Backward-compatible aliases.
                "foodAtRisk": sugar_at_risk,
                "colonyFoodDelta": resource_delta,
                "antShareDelta": round(resource_delta / vote_count, 2) if resource_delta is not None else None,
                "voteCount": vote_count,
                "infoBought": bool(data.get("infoBought")),
                "strategyRevision": (
                    joined_event.data.get("strategyRevision", data.get("strategyRevision"))
                    if isinstance(joined_event.data, dict)
                    else data.get("strategyRevision")
                ),
                "strategy": strategy,
                "decisionReason": decision.get("reason"),
                "createdEventIndex": joined_event.index,
                "createdAt": joined_event.created_at,
                "resolvedEventIndex": resolved_event.index if resolved_event else None,
                "resolvedAt": resolved_event.created_at if resolved_event else None,
                "resolutionReason": "recalled" if recalled_event else resolved_data.get("reason"),
                "resolvedOutcome": resolved_data.get("resolvedOutcome") if resolution else None,
            }
        )

    return sorted(history, key=lambda item: item["createdEventIndex"], reverse=True)


def ant_strategy_history(room: GameRoom, colony_id: str, ant_id: str) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    for event in room.log:
        if event.kind != "ant_strategy_updated" or not isinstance(event.data, dict):
            continue
        if str(event.data.get("colonyId") or "") != colony_id or str(event.data.get("antId") or "") != ant_id:
            continue
        strategy = event.data.get("strategy") if isinstance(event.data.get("strategy"), dict) else {}
        history.append(
            {
                "eventIndex": event.index,
                "changedAt": event.created_at,
                "strategyRevision": event.data.get("strategyRevision"),
                "strategy": strategy,
            }
        )
    return sorted(history, key=lambda item: item["eventIndex"], reverse=True)


def _safe_history_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _safe_history_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def colony_ant_counts(colony: ColonyState, event_index: int) -> dict[str, int]:
    alive_ants = colony.alive_ants
    return {
        "aliveCount": len(alive_ants),
        "activeCount": len(colony.active_ants(event_index)),
        "engagedCount": 0,
        "woundedCount": len([ant for ant in alive_ants if ant.wounded_until_event > event_index]),
    }


def spawn_ant(colony: ColonyState, index: int, rng: random.Random) -> AntState:
    weights = archetype_weights(colony)
    archetypes = list(weights)
    total_weight = sum(weights.values())
    pick = rng.uniform(0, total_weight)
    cursor = 0.0
    archetype = archetypes[-1]
    for candidate in archetypes:
        cursor += weights[candidate]
        if pick <= cursor:
            archetype = candidate
            break
    traits = traits_for_archetype(archetype, colony, rng)
    return AntState(ant_id=f"ant_{index:04d}", archetype=archetype, **traits)


def archetype_weights(colony: ColonyState) -> dict[str, float]:
    weights = {
        "cautious": 1.0,
        "balanced": 1.0,
        "data_first": 1.0,
        "opportunist": 1.0,
        "momentum": 1.0,
        "chaos": 1.0,
    }
    if colony.style == "cautious":
        weights.update({"cautious": 4.0, "data_first": 2.8, "balanced": 2.0, "opportunist": 1.1, "momentum": 1.0, "chaos": 0.7})
    elif colony.style == "aggressive":
        weights.update({"cautious": 1.0, "data_first": 1.3, "balanced": 2.0, "opportunist": 3.0, "momentum": 2.4, "chaos": 1.6})
    else:
        weights.update({"cautious": 1.7, "data_first": 1.7, "balanced": 3.0, "opportunist": 1.8, "momentum": 1.8, "chaos": 1.0})

    if colony.info_need == "high":
        weights["data_first"] += 2.0
    elif colony.info_need == "low":
        weights["opportunist"] += 1.1

    if colony.favorite_context == "momentum":
        weights["momentum"] += 2.0
    elif colony.favorite_context == "chaos":
        weights["chaos"] += 2.0
    elif colony.favorite_context in {"penalties", "corners"}:
        weights["opportunist"] += 0.8
        weights["data_first"] += 0.7

    return {key: max(0.35, value) for key, value in weights.items()}


def traits_for_archetype(archetype: str, colony: ColonyState, rng: random.Random) -> dict[str, Any]:
    base = {
        "cautious": (0.25, 0.55, 0.72, 0.75, 0.30, 0.20),
        "balanced": (0.48, 0.45, 0.58, 0.50, 0.45, 0.35),
        "data_first": (0.38, 0.78, 0.62, 0.55, 0.35, 0.30),
        "opportunist": (0.70, 0.35, 0.50, 0.35, 0.55, 0.45),
        "momentum": (0.62, 0.42, 0.53, 0.42, 0.82, 0.35),
        "chaos": (0.82, 0.40, 0.48, 0.30, 0.40, 0.88),
    }[archetype]
    risk, info, threshold, loss, momentum, chaos = base
    if colony.style == "cautious":
        risk -= 0.06
        threshold += 0.05
        loss += 0.08
    elif colony.style == "aggressive":
        risk += 0.08
        threshold -= 0.04
        loss -= 0.05
    if colony.info_need == "high":
        info += 0.16
    elif colony.info_need == "low":
        info -= 0.14

    favorite_context = colony.favorite_context
    if favorite_context == "balanced":
        favorite_context = rng.choice(["penalties", "corners", "momentum", "chaos"])

    return {
        "risk_appetite": clamp(risk + rng.uniform(-0.08, 0.08), 0.05, 0.98),
        "info_hunger": clamp(info + rng.uniform(-0.08, 0.08), 0.05, 0.98),
        "favorite_context": favorite_context,
        "confidence_threshold": clamp(threshold + rng.uniform(-0.06, 0.06), 0.25, 0.90),
        "loss_sensitivity": clamp(loss + rng.uniform(-0.08, 0.08), 0.05, 0.98),
        "momentum_bias": clamp(momentum + rng.uniform(-0.08, 0.08), 0.05, 0.98),
        "chaos_bias": clamp(chaos + rng.uniform(-0.08, 0.08), 0.05, 0.98),
    }


def build_opportunity(event: dict[str, Any], event_index: int, match_state: MatchState | None = None) -> Opportunity | None:
    opportunities = build_opportunities(event, event_index, match_state)
    return opportunities[0] if opportunities else None


def build_baseline_market_event(room: GameRoom, source_event: dict[str, Any] | None = None, *, reason: str = "live_baseline") -> dict[str, Any]:
    source = source_event or {}
    event: dict[str, Any] = {
        "fixtureId": room.fixture_id,
        "seq": f"{reason}_{room.event_index + 1}",
        "action": "market_tick",
        "type": "market_tick",
        "highlights": ["market_tick"],
        "minute": source.get("minute"),
        "clockSeconds": source.get("clockSeconds"),
        "description": "Live market refresh",
        "synthetic": True,
        "reason": reason,
    }
    for key in ("participant", "participantLabel", "possession", "possessionLabel"):
        if source.get(key) is not None:
            event[key] = source[key]
    if source.get("score") is not None:
        event["score"] = source.get("score")
    elif room.match_state and room.match_state.score:
        event["score"] = dict(room.match_state.score)
    return event


def build_opportunities(event: dict[str, Any], event_index: int, match_state: MatchState | None = None) -> list[Opportunity]:
    contexts = event_contexts(event)
    if not contexts:
        return []
    return [
        opportunity
        for context in contexts
        if (opportunity := build_opportunity_for_context(event, event_index, context, match_state)) is not None
    ]


def build_opportunity_for_context(
    event: dict[str, Any],
    event_index: int,
    context: str,
    match_state: MatchState | None = None,
) -> Opportunity | None:
    fixture_id = event.get("fixtureId")
    team = event.get("participant") or event.get("possession")
    team_label = event.get("participantLabel") or event.get("possessionLabel")
    minute = event.get("minute")
    clock = event_clock_seconds(event)
    participant1 = match_state.participant1 if match_state and match_state.participant1 else "A"
    participant2 = match_state.participant2 if match_state and match_state.participant2 else "B"
    source_event = dict(event)
    source_event["_participant1Label"] = participant1
    source_event["_participant2Label"] = participant2
    options = opportunity_options(context, participant1, participant2, team_label)
    if not options:
        return None
    deadline_seconds = opportunity_deadline_seconds(context)
    deadline_events = opportunity_deadline_events(context)
    return Opportunity(
        opportunity_id=f"opp_{fixture_id}_{event_index}_{context}",
        fixture_id=fixture_id,
        context=context,
        label=opportunity_label(context, event, team_label),
        team=team,
        team_label=team_label,
        minute=minute,
        created_event_index=event_index,
        deadline_clock=clock + deadline_seconds if clock is not None and deadline_seconds is not None else None,
        deadline_event_index=event_index + deadline_events if deadline_events is not None else None,
        options=options,
        source_event=source_event,
    )


def event_context(event: dict[str, Any]) -> str | None:
    contexts = event_contexts(event)
    return contexts[0] if contexts else None


def event_contexts(event: dict[str, Any]) -> list[str]:
    flags = set(event.get("highlights") or [])
    if event.get("synthetic") and (_event_token(event.get("action")) == "market_tick" or "market_tick" in flags):
        return cadence_market_contexts(event)
    if _event_is_penalty_award(event):
        targets = event_targets(event)
        if targets.intersection({"goal", "miss", "saved", "cancel"}):
            return []
        return ["penalties"]
    targets = event_targets(event)
    if targets.intersection({"goal", "card", "foul", "corner", "free_kick", "substitution", "cancel"}):
        return []
    if (
        _event_has_text(event, "high_danger", "danger_possession", "attack_possession", "shot", "tir")
        or targets.intersection({"pressure", "shot"})
    ):
        return cadence_market_contexts(event)
    return []


def cadence_market_contexts(event: dict[str, Any]) -> list[str]:
    """Return one concrete event market for the current five-minute wave."""

    clock = event_clock_seconds(event) or 0
    context_index = (clock // STANDARD_MARKET_INTERVAL_SECONDS) % len(BASELINE_MARKET_CONTEXTS)
    return [BASELINE_MARKET_CONTEXTS[context_index]]


def _event_is_penalty_award(event: dict[str, Any]) -> bool:
    action = _event_token(event.get("action"))
    event_type = _event_token(event.get("type"))
    flags = set(event.get("highlights") or [])
    award_tokens = {"penalty", "penalties", "penalty_awarded", "penalty_given", "penalty_kick", "spot_kick"}
    confirmation_tokens = {"penalty_confirmed", "confirmed_penalty"}
    result_tokens = {
        "penalty_scored",
        "penalty_saved",
        "penalty_missed",
        "penalty_failed",
        "penalty_cancelled",
        "penalty_outcome",
        "penalty_result",
        "penalty_shootout_outcome",
    }
    false_prefixes = ("penalty_area", "penalty_box", "penalty_arc", "penalty_possible")
    if event.get("confirmed") is not None and not truthy(event.get("confirmed")):
        return False
    if _event_has_text(event, "possible penalty", "penalty possible", "check possible", "not confirmed", "pending confirmation"):
        return False
    if _event_has_text(event, "no penalty", "not a penalty", "penalty cancelled", "penalty canceled", "penalty denied", "penalty overturned"):
        return False
    if action in result_tokens or event_type in result_tokens:
        return False
    if action in award_tokens or action in confirmation_tokens:
        return True
    if event_type in award_tokens or event_type in confirmation_tokens:
        return True
    if action.startswith(false_prefixes) or event_type.startswith(false_prefixes):
        return False
    if "penalty" in flags and action in {"", "penalty", "penalties"}:
        return True
    return bool(
        event.get("confirmed") is not None
        and truthy(event.get("confirmed"))
        and _event_has_text(event, "penalty")
        and _event_has_text(event, "confirmed", "confirme", "awarded", "given")
    )


def _event_token(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"[^a-z0-9]+", "_", str(value).casefold()).strip("_")


def event_clock_seconds(event: dict[str, Any]) -> int | None:
    raw_clock = event.get("clockSeconds")
    if raw_clock is not None:
        try:
            return int(raw_clock)
        except (TypeError, ValueError):
            pass
    raw_minute = event.get("minute")
    if raw_minute is not None:
        try:
            return int(raw_minute) * 60
        except (TypeError, ValueError):
            pass
    return None


def opportunity_clock_seconds(opportunity: Opportunity) -> int | None:
    clock = event_clock_seconds(opportunity.source_event)
    if clock is not None:
        return clock
    if opportunity.minute is not None:
        try:
            return int(opportunity.minute) * 60
        except (TypeError, ValueError):
            return None
    return None


def opportunity_deadline_seconds(context: str) -> int | None:
    return {
        "penalties": None,
        "goal_next_10": GOAL_NEXT_10_SECONDS,
        "next_goal_team": None,
        "next_corner": None,
        "next_card": None,
        "next_substitution": None,
        "next_free_kick": None,
        "next_yellow_card": None,
        "next_foul": None,
    }[context]


def opportunity_deadline_events(context: str) -> int | None:
    return {
        "penalties": None,
        "goal_next_10": 56,
        "next_goal_team": None,
        "next_corner": None,
        "next_card": None,
        "next_substitution": None,
        "next_free_kick": None,
        "next_yellow_card": None,
        "next_foul": None,
    }[context]


def opportunity_options(context: str, participant1: str = "A", participant2: str = "B", team_label: str | None = None) -> list[OpportunityOption]:
    if context == "penalties":
        return [
            OpportunityOption("penalty_goal", "yes, penalty scored", "safe", 1.35, "goal", reward_sugar=1),
            OpportunityOption("penalty_no_goal", "no, missed or saved", "wild", 5.5, "no_goal", "any", reward_sugar=4),
        ]
    if context == "goal_next_10":
        return [
            OpportunityOption("goal_next_10_yes", "yes, goal in the next 10 min", "risky", 2.4, "goal", "any", reward_sugar=5),
            OpportunityOption("goal_next_10_no", "no goal in the next 10 min", "safe", 1.35, "no_goal", "any", reward_sugar=1),
        ]
    if context == "next_goal_team":
        return [
            OpportunityOption("next_goal_p1", f"{participant1} scores the next goal", "wild", 4.4, "goal", "participant1", reward_sugar=2),
            OpportunityOption("next_goal_p2", f"{participant2} scores the next goal", "wild", 4.4, "goal", "participant2", reward_sugar=2),
        ]
    if context == "next_corner":
        return [
            OpportunityOption("next_corner_p1", f"{participant1} wins the next corner", "risky", 2.6, "corner", "participant1", reward_sugar=2),
            OpportunityOption("next_corner_p2", f"{participant2} wins the next corner", "risky", 2.6, "corner", "participant2", reward_sugar=2),
        ]
    if context == "next_card":
        return [
            OpportunityOption("next_card_p1", f"{participant1} gets the next card", "risky", 2.6, "card", "participant1", reward_sugar=2),
            OpportunityOption("next_card_p2", f"{participant2} gets the next card", "risky", 2.6, "card", "participant2", reward_sugar=2),
        ]
    if context == "next_substitution":
        return [
            OpportunityOption("next_substitution_p1", f"{participant1} makes the next substitution", "risky", 2.6, "substitution", "participant1", reward_sugar=2),
            OpportunityOption("next_substitution_p2", f"{participant2} makes the next substitution", "risky", 2.6, "substitution", "participant2", reward_sugar=2),
        ]
    if context == "next_free_kick":
        return [
            OpportunityOption("next_free_kick_p1", f"{participant1} wins the next free kick", "risky", 2.2, "free_kick", "participant1", reward_sugar=2),
            OpportunityOption("next_free_kick_p2", f"{participant2} wins the next free kick", "risky", 2.2, "free_kick", "participant2", reward_sugar=2),
        ]
    if context == "next_yellow_card":
        return [
            OpportunityOption("next_yellow_card_p1", f"{participant1} gets the next yellow card", "wild", 3.8, "yellow_card", "participant1", reward_sugar=2),
            OpportunityOption("next_yellow_card_p2", f"{participant2} gets the next yellow card", "wild", 3.8, "yellow_card", "participant2", reward_sugar=2),
        ]
    if context == "next_foul":
        return [
            OpportunityOption("next_foul_p1", f"yes, {participant1} commits the next foul", "risky", 2.2, "foul", "participant1", reward_sugar=2),
            OpportunityOption("next_foul_p2", f"no, {participant2} commits the next foul", "risky", 2.2, "foul", "participant2", reward_sugar=2),
        ]
    return []


def opportunity_label(context: str, event: dict[str, Any], team_label: str | None) -> str:
    minute = f"{event.get('minute')}' - " if event.get("minute") is not None else ""
    team = f" for {team_label}" if context == "penalties" and team_label else ""
    labels = {
        "penalties": "Penalty: goal or no goal?",
        "goal_next_10": "Market: goal in the next 10 minutes?",
        "next_goal_team": "Market: who scores the next goal?",
        "next_corner": "Market: who wins the next corner?",
        "next_card": "Market: who gets the next card?",
        "next_substitution": "Market: who makes the next substitution?",
        "next_free_kick": "Market: who wins the next free kick?",
        "next_yellow_card": "Market: who gets the next yellow card?",
        "next_foul": "Market: who commits the next foul?",
    }
    return f"{minute}{labels[context]}{team}"


def run_vote(
    colony: ColonyState,
    opportunity: Opportunity,
    event_index: int,
    *,
    info_packet: InfoPacket | None = None,
) -> dict[str, Any]:
    predictions: dict[str, list[dict[str, Any]]] = {option.option_id: [] for option in opportunity.options}
    info_requests: list[dict[str, Any]] = []
    neutral = 0
    active_ants = colony.active_ants(event_index)
    for ant in active_ants:
        rng = random.Random(stable_seed(colony.seed, ant.ant_id, opportunity.opportunity_id, "info" if info_packet else "first"))
        if not info_packet and ant_wants_info(ant, colony, opportunity, rng):
            info_requests.append({"antId": ant.ant_id, "weight": ant.influence})
            ant.memory.info_attempts += 1
            continue

        best_option = None
        best_score = -1.0
        for option in opportunity.options:
            score = option_score(ant, colony, opportunity, option, rng, info_packet=info_packet)
            if score > best_score:
                best_option = option
                best_score = score

        threshold = ant.confidence_threshold
        if max(0, colony.food - colony.food_reserved) < food_drain_for_colony(colony) * 2:
            threshold -= 0.10
        if best_option is None or best_score < threshold:
            neutral += 1
            continue
        predictions[best_option.option_id].append({"antId": ant.ant_id, "confidence": round(best_score, 3), "weight": ant.influence * best_score})

    return {
        "activeCount": len(active_ants),
        "predictions": predictions,
        "infoRequests": info_requests,
        "neutralCount": neutral,
        "infoPacket": info_packet,
    }


def ant_agent_context(
    ant: AntState,
    opportunity: Opportunity,
    colony: ColonyState | None = None,
    *,
    strategy: dict[str, Any] | None = None,
    role_evidence: dict[str, Any] | None = None,
    reliability: dict[str, Any] | None = None,
) -> dict[str, Any]:
    requested_role = strategy.get("analysisRole") if isinstance(strategy, dict) else None
    effective_strategy = {
        "analysisRole": (
            str(requested_role)
            if requested_role in VALID_ANALYSIS_ROLES
            else effective_analysis_role(ant)
        )
    }
    return {
        "antId": ant.ant_id,
        "objective": (
            "Help your colony win across the match: earn resources, avoid bad resource losses, "
            "and take good rewards when the fixed 2 Sugar risk is worth it."
        ),
        "strategy": effective_strategy,
        "dataReliability": copy.deepcopy(reliability) if isinstance(reliability, dict) else None,
        "roleEvidence": copy.deepcopy(role_evidence) if isinstance(role_evidence, dict) else {
            "role": effective_strategy["analysisRole"],
        },
    }


def agent_market_context(opportunity: Opportunity) -> dict[str, Any]:
    if opportunity.context == "penalties":
        proposition = "Is the penalty scored?"
    elif opportunity.context == "goal_next_10":
        proposition = "Will there be a goal in the next 10 minutes, including stoppage time?"
    elif opportunity.context == "next_goal_team":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who scores the next goal before full time: {participant1} or {participant2}? No goal makes the market void."
    elif opportunity.context == "next_corner":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who wins the next corner before full time: {participant1} or {participant2}? No corner makes the market void."
    elif opportunity.context == "next_card":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who gets the next yellow or red card before full time: {participant1} or {participant2}? No card makes the market void."
    elif opportunity.context == "next_substitution":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who makes the next substitution before full time: {participant1} or {participant2}? No substitution makes the market void."
    elif opportunity.context == "next_free_kick":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who wins the next free kick before full time: {participant1} or {participant2}? No free kick makes the market void."
    elif opportunity.context == "next_yellow_card":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who gets the next yellow card before full time: {participant1} or {participant2}? No card makes the market void."
    elif opportunity.context == "next_foul":
        participant1 = opportunity.source_event.get("_participant1Label") or "team A"
        participant2 = opportunity.source_event.get("_participant2Label") or "team B"
        proposition = f"Who commits the next foul: {participant1} or {participant2}?"
    else:
        proposition = opportunity.label
    available_votes = market_available_votes(opportunity)
    return {
        "marketId": opportunity.opportunity_id,
        "context": opportunity.context,
        "proposition": proposition,
        "teamLabel": opportunity.team_label,
        "minute": opportunity.minute,
        "availableVotes": available_votes,
        "yesOptionId": available_votes[0]["optionId"] if len(available_votes) >= 1 else None,
        "noOptionId": available_votes[1]["optionId"] if len(available_votes) >= 2 else None,
    }


def agent_opportunity_context(opportunity: Opportunity) -> dict[str, Any]:
    """Return market facts shared by every role without trigger-time clues."""

    labels = {
        "penalties": "Penalty: goal or no goal?",
        "goal_next_10": "Market: goal in the next 10 minutes?",
        "next_goal_team": "Market: who scores the next goal?",
        "next_corner": "Market: who wins the next corner?",
        "next_card": "Market: who gets the next card?",
        "next_substitution": "Market: who makes the next substitution?",
        "next_free_kick": "Market: who wins the next free kick?",
        "next_yellow_card": "Market: who gets the next yellow card?",
        "next_foul": "Market: who commits the next foul?",
    }
    state = opportunity.public_state()
    state.pop("minute", None)
    state["label"] = labels.get(opportunity.context, "Market")
    if opportunity.context == "penalties" and opportunity.team_label:
        state["label"] += f" for {opportunity.team_label}"
    else:
        state.pop("teamLabel", None)
    return state


def market_available_votes(opportunity: Opportunity) -> list[dict[str, Any]]:
    vote_keys = ["yes", "no"] if len(opportunity.options) <= 2 else ["option_a", "option_b", "option_c", "option_d"]
    items = []
    for index, option in enumerate(opportunity.options):
        vote_key = vote_keys[index] if index < len(vote_keys) else f"option_{index + 1}"
        items.append(
            {
                "vote": vote_key,
                "meaning": option.label,
                "optionId": option.option_id,
                "risk": option.risk,
                "multiplier": option.multiplier,
                "lossMultiplier": MARKET_RISK_SUGAR,
                "rewardSugar": option.reward_sugar,
                "riskSugar": MARKET_RISK_SUGAR,
            }
        )
    items.append(
        {
            "vote": "abstain",
            "meaning": "do not commit this ant to this market",
            "optionId": None,
            "risk": "none",
            "multiplier": 0,
            "rewardSugar": 0,
            "riskSugar": 0,
        }
    )
    return items


def vote_from_ant_agent_decisions(
    colony: ColonyState,
    opportunity: Opportunity,
    event_index: int,
    decisions: list[Any],
    *,
    info_packet: InfoPacket | None = None,
    reliability: dict[str, Any] | None = None,
    analysis_roles: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    active_ants = colony.active_ants(event_index)
    if not active_ants or not decisions:
        return None

    ant_counts = colony_ant_counts(colony, event_index)
    decision_by_ant_id: dict[str, Any] = {}
    for decision in decisions:
        ant_id = str(_ant_decision_value(decision, "ant_id", "antId", ""))
        if ant_id:
            decision_by_ant_id[ant_id] = decision
    if not decision_by_ant_id:
        return None

    predictions: dict[str, list[dict[str, Any]]] = {option.option_id: [] for option in opportunity.options}
    info_requests: list[dict[str, Any]] = []
    neutral = 0
    samples: list[dict[str, Any]] = []
    active_ids = {ant.ant_id for ant in active_ants}
    market = agent_market_context(opportunity)
    vote_labels = {item["vote"]: item["meaning"] for item in market["availableVotes"]}
    vote_option_ids = {item["vote"]: item.get("optionId") for item in market["availableVotes"]}
    vote_counts: dict[str, int] = {item["vote"]: 0 for item in market["availableVotes"]}
    role_vote_counts: dict[str, dict[str, int]] = {
        role: {vote: 0 for vote in vote_counts}
        for role in sorted(VALID_ANALYSIS_ROLES)
    }
    role_ant_counts: dict[str, int] = {role: 0 for role in sorted(VALID_ANALYSIS_ROLES)}

    for ant in active_ants:
        role = (analysis_roles or {}).get(ant.ant_id) or effective_analysis_role(ant)
        if role not in VALID_ANALYSIS_ROLES:
            role = effective_analysis_role(ant)
        role_ant_counts[role] += 1
        decision = decision_by_ant_id.get(ant.ant_id)
        if not decision:
            vote_counts["abstain"] += 1
            role_vote_counts[role]["abstain"] += 1
            neutral += 1
            continue

        vote = normalize_agent_vote(_ant_decision_value(decision, "vote", "vote", None))
        if not vote:
            vote = normalize_agent_vote(_ant_decision_value(decision, "choice", "choice", None))
        if vote not in vote_counts:
            vote = "abstain"
        vote_counts[vote] += 1
        role_vote_counts[role][vote] += 1
        option_id = _ant_decision_value(decision, "option_id", "optionId", vote_option_ids.get(vote))
        raw_action = _ant_decision_value(decision, "action", default=None)
        action = str(raw_action or ("predict" if option_id in predictions else "neutral"))
        reason = str(_ant_decision_value(decision, "reason", default="") or "").strip()
        if len(samples) < 8:
            samples.append(
                {
                    "antId": ant.ant_id,
                    "archetype": ant.archetype,
                    "analysisRole": role,
                    "vote": vote,
                    "voteLabel": vote_labels.get(vote),
                    "action": action,
                    "optionId": option_id,
                    "reason": reason[:90],
                }
            )

        if action == "predict" and option_id in predictions:
            predictions[str(option_id)].append(
                {
                    "antId": ant.ant_id,
                    "vote": vote,
                    "weight": ant.influence,
                    "reason": reason[:90],
                }
            )
            continue

        neutral += 1

    return {
        "activeCount": len(active_ants),
        "predictions": predictions,
        "infoRequests": info_requests,
        "neutralCount": neutral,
        "infoPacket": info_packet,
        "aliveCount": ant_counts["aliveCount"],
        "engagedCount": ant_counts["engagedCount"],
        "woundedCount": ant_counts["woundedCount"],
        "source": "deepseek_ant_agents",
        "agentDecisionCount": len([ant_id for ant_id in decision_by_ant_id if ant_id in active_ids]),
        "agentCoverage": round(len([ant_id for ant_id in decision_by_ant_id if ant_id in active_ids]) / max(1, len(active_ants)), 3),
        "market": market,
        "voteCounts": vote_counts,
        "voteLabels": vote_labels,
        "roleVoteCounts": role_vote_counts,
        "roleAntCounts": role_ant_counts,
        "reliabilitySummary": reliability_summary(reliability),
        "agentSamples": samples,
    }


def normalize_agent_vote(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    vote = value.strip().casefold()
    if vote in {"yes", "oui", "y", "a"}:
        return "yes"
    if vote in {"no", "non", "n", "b"}:
        return "no"
    if vote in {"option_a", "option a", "team_a", "team a"}:
        return "option_a"
    if vote in {"option_b", "option b", "team_b", "team b"}:
        return "option_b"
    if vote in {"option_c", "option c", "none", "no_goal", "no goal"}:
        return "option_c"
    if vote in {"abstain", "abstention", "neutral", "neutre", "skip", "c"}:
        return "abstain"
    return None


def _ant_decision_value(decision: Any, snake_key: str, camel_key: str | None = None, default: Any = None) -> Any:
    if hasattr(decision, snake_key):
        return getattr(decision, snake_key)
    if isinstance(decision, dict):
        if snake_key in decision:
            return decision[snake_key]
        if camel_key and camel_key in decision:
            return decision[camel_key]
    return default


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def ant_wants_info(ant: AntState, colony: ColonyState, opportunity: Opportunity, rng: random.Random) -> bool:
    max_risk = max(RISK_RULES[option.risk]["multiplier"] for option in opportunity.options)
    available_food = max(0, colony.food - colony.food_reserved)
    food_pressure = 0.12 if available_food < len(colony.alive_ants) * 0.35 else 0.0
    context_bonus = 0.08 if prefers_market(ant.favorite_context, opportunity, None) or prefers_market(colony.favorite_context, opportunity, None) else 0.0
    score = ant.info_hunger + (max_risk / 100) + context_bonus - food_pressure + rng.uniform(-0.16, 0.10)
    threshold = {"low": 0.78, "medium": 0.66, "high": 0.54}[colony.info_need]
    return score >= threshold


def option_score(
    ant: AntState,
    colony: ColonyState,
    opportunity: Opportunity,
    option: OpportunityOption,
    rng: random.Random,
    *,
    info_packet: InfoPacket | None = None,
) -> float:
    if option.risk == "safe":
        score = 0.44 + (1 - ant.risk_appetite) * 0.28
    elif option.risk == "risky":
        score = 0.38 + (1 - abs(ant.risk_appetite - 0.58)) * 0.24
    elif option.risk == "wild":
        score = 0.33 + ant.risk_appetite * 0.28
    else:
        score = 0.28 + ant.chaos_bias * 0.34

    if prefers_market(ant.favorite_context, opportunity, option) or prefers_market(colony.favorite_context, opportunity, option):
        score += 0.15
    if opportunity.context in {"goal_next_10", "next_goal_team", "next_corner", "next_substitution", "next_free_kick"}:
        score += ant.momentum_bias * 0.12
    if opportunity.context in {"next_card", "next_yellow_card", "next_foul"}:
        score += ant.chaos_bias * 0.12
        score += ant.momentum_bias * 0.05
    if opportunity.context == "chaos":
        score += ant.chaos_bias * 0.13
    score += (ant.memory.success_rate(opportunity.context) - 0.5) * 0.22
    score += (colony.memory.context_rate(opportunity.context) - 0.5) * 0.12
    if ant.memory.recent_losses >= 2:
        score -= ant.loss_sensitivity * 0.10
    if info_packet:
        score += 0.07 if info_packet.complete else 0.035
        if any("not confirmed" in fact for fact in info_packet.facts) and option.target == "goal":
            score -= 0.08
    score += rng.uniform(-0.11, 0.11)
    return clamp(score, 0.0, 1.2)


def prefers_market(favorite_context: str, opportunity: Opportunity, option: OpportunityOption | None) -> bool:
    if favorite_context == opportunity.context:
        return True
    if opportunity.context in {"goal_next_10", "next_goal_team"}:
        if favorite_context in {"momentum", "corners"} and (option is None or option.target == "goal"):
            return True
    if opportunity.context == "next_corner":
        if favorite_context in {"corners", "momentum"}:
            return True
    if opportunity.context == "next_substitution":
        if favorite_context == "momentum":
            return True
    if opportunity.context == "next_card":
        if favorite_context == "chaos":
            return True
    if opportunity.context == "next_free_kick":
        if favorite_context in {"momentum", "chaos"}:
            return True
    if opportunity.context == "next_yellow_card":
        if favorite_context == "chaos":
            return True
    if opportunity.context == "next_foul":
        if favorite_context in {"chaos", "momentum"}:
            return True
    return False


def should_buy_info(
    colony: ColonyState,
    opportunity: Opportunity,
    vote: dict[str, Any],
    *,
    agent_decision: ColonyAgentDecision | None = None,
) -> bool:
    if colony.colony_id in opportunity.info_bought_by:
        return False
    if max(0, colony.food - colony.food_reserved) < info_cost_for_colony(colony, opportunity):
        return False
    active_weight = max(1.0, float(vote["activeCount"]))
    request_weight = sum(item["weight"] for item in vote["infoRequests"])
    ants_want_info = request_weight / active_weight >= 0.25
    agent_wants_info = bool(agent_decision and agent_decision.authoritative and agent_decision.buy_info)
    return ants_want_info or agent_wants_info


def build_info_packet(opportunity: Opportunity, colony: ColonyState, match_state: MatchState | None) -> InfoPacket:
    event = opportunity.source_event
    facts: list[str] = []
    player = event.get("player")
    if isinstance(player, dict) and player.get("name"):
        facts.append(f"involved player: {player['name']}")
    else:
        facts.append("involved player unknown")
    if event.get("confirmed") is not None:
        facts.append("action confirmed" if truthy(event.get("confirmed")) else "action not confirmed")
    if event.get("minute") is not None:
        facts.append(f"minute {event['minute']}")
    if event.get("score") and (event["score"].get("participant1") is not None or event["score"].get("participant2") is not None):
        facts.append(f"score {event['score'].get('participant1') or 0}-{event['score'].get('participant2') or 0}")
    if event.get("participantLabel") or event.get("possessionLabel"):
        facts.append(f"team: {event.get('participantLabel') or event.get('possessionLabel')}")
    if match_state:
        facts.append(match_state.pressure_summary())
    facts.append(f"colony memory: {round(colony.memory.context_rate(opportunity.context) * 100)}% on {opportunity.context}")
    complete = any("confirmed" in fact for fact in facts) or any("involved player:" in fact for fact in facts)
    return InfoPacket(opportunity.opportunity_id, info_cost_for_colony(colony, opportunity), facts, complete)


def create_prediction(
    colony: ColonyState,
    opportunity: Opportunity,
    vote: dict[str, Any],
    event_index: int,
    *,
    bought_info: bool,
    agent_decision: ColonyAgentDecision | None = None,
    strategy_style: str | None = None,
    food_budget: int | None = None,
) -> Prediction | None:
    # Kept in the signature for compatibility with existing callers. Sugar V0 is
    # governed only by the raw ant majority, never by weighted influence, a
    # colony-agent override, variable stake sizing, or a per-window food budget.
    _ = agent_decision, food_budget
    effective_style = strategy_style if strategy_style in VALID_STYLES else colony.style
    entry = entry_vote_state(opportunity, vote, effective_style)
    best_option = entry["option"]
    best_votes = entry["votes"]
    if not best_option or entry["tie"] or entry["supportFraction"] < entry["entryThreshold"]:
        return None
    available_sugar = max(0, colony.food - colony.food_reserved)
    reserve_capacity = max(0, MAX_RESERVED_SUGAR - colony.food_reserved)
    if available_sugar < MARKET_RISK_SUGAR or reserve_capacity < MARKET_RISK_SUGAR:
        return None
    supporting_ant_ids = [str(item.get("antId")) for item in best_votes if item.get("antId")]
    if not supporting_ant_ids:
        return None
    prediction = Prediction(
        prediction_id=f"pred_{uuid.uuid4().hex[:10]}",
        colony_id=colony.colony_id,
        opportunity_id=opportunity.opportunity_id,
        option=best_option,
        ant_ids=supporting_ant_ids,
        created_event_index=event_index,
        deadline_clock=opportunity.deadline_clock,
        deadline_event_index=opportunity.deadline_event_index,
        info_bought=bought_info,
        reserved_food=MARKET_RISK_SUGAR,
        support_fraction=entry["supportFraction"],
        entry_threshold=entry["entryThreshold"],
    )
    colony.food_reserved += MARKET_RISK_SUGAR
    return prediction


def top_voted_option(opportunity: Opportunity, vote: dict[str, Any]) -> tuple[OpportunityOption | None, list[dict[str, Any]]]:
    ranked = [
        (option, list(vote.get("predictions", {}).get(option.option_id, [])))
        for option in opportunity.options
    ]
    if not ranked:
        return None, []
    top_count = max(len(items) for _, items in ranked)
    winners = [(option, items) for option, items in ranked if len(items) == top_count]
    if top_count <= 0 or len(winners) != 1:
        return None, []
    return winners[0]


def entry_vote_state(
    opportunity: Opportunity,
    vote: dict[str, Any],
    style: str,
) -> dict[str, Any]:
    ranked = [
        (option, list(vote.get("predictions", {}).get(option.option_id, [])))
        for option in opportunity.options
    ]
    top_count = max((len(items) for _, items in ranked), default=0)
    winners = [(option, items) for option, items in ranked if len(items) == top_count]
    tie = len(winners) > 1
    option, items = winners[0] if len(winners) == 1 and top_count > 0 else (None, [])
    try:
        active_count = max(0, int(vote.get("activeCount") or 0))
    except (TypeError, ValueError):
        active_count = 0
    threshold = STYLE_ENTRY_THRESHOLDS.get(style, STYLE_ENTRY_THRESHOLDS["balanced"])
    support_fraction = top_count / active_count if active_count else 0.0
    return {
        "option": option,
        "votes": items,
        "topVoteCount": top_count,
        "activeCount": active_count,
        "supportFraction": support_fraction,
        "consensus": support_fraction,
        "entryThreshold": threshold,
        "tie": tie,
    }


def resolved_market_outcome(opportunity: Opportunity, event: dict[str, Any] | None, *, reason: str) -> dict[str, Any]:
    targets = event_targets(event) if event else set()
    team_label = event_team_label(event, opportunity) if event else None
    team_scope = event_team_scope(event, opportunity) if event else None
    minute = event.get("minute") if event else None

    target = None
    option = None
    label = "Resolved"

    if opportunity.context == "penalties":
        if "goal" in targets:
            target = "goal"
            label = f"{team_label} penalty scored" if team_label else "Penalty scored"
        elif targets.intersection({"miss", "saved"}):
            target = "no_goal"
            label = f"{team_label} penalty missed or saved" if team_label else "Penalty missed or saved"
        elif "cancel" in targets:
            label = "Penalty cancelled"
        option = outcome_option(opportunity, target)

    elif opportunity.context == "goal_next_10":
        if "goal" in targets:
            target = "goal"
            label = f"{team_label} scored" if team_label else "Goal scored"
        else:
            target = "no_goal"
            label = "No goal in the next 10 min"
        option = outcome_option(opportunity, target)

    elif opportunity.context == "next_goal_team":
        if "goal" in targets:
            target = "goal"
            label = f"{team_label} scored" if team_label else "Goal scored"
            option = outcome_option(opportunity, target, team_scope)
        else:
            label = "No goal before full time"

    elif opportunity.context == "next_corner":
        if "corner" in targets:
            target = "corner"
            label = f"{team_label} won the next corner" if team_label else "Corner won"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No corner before full time"

    elif opportunity.context == "next_card":
        if "card" in targets:
            target = "card"
            label = f"{team_label} got the next card" if team_label else "Card shown"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No card before full time"

    elif opportunity.context == "next_substitution":
        if "substitution" in targets:
            target = "substitution"
            label = f"{team_label} made the next substitution" if team_label else "Substitution made"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No substitution before full time"

    elif opportunity.context == "next_free_kick":
        if "free_kick" in targets:
            target = "free_kick"
            label = f"{team_label} won the next free kick" if team_label else "Free kick won"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No free kick before full time"

    elif opportunity.context == "next_yellow_card":
        if "yellow_card" in targets:
            target = "yellow_card"
            label = f"{team_label} got the next yellow card" if team_label else "Yellow card shown"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No yellow card before full time"

    elif opportunity.context == "next_foul":
        if "foul" in targets:
            target = "foul"
            label = f"{team_label} committed the next foul" if team_label else "Foul committed"
            option = outcome_option(opportunity, target, team_scope)
        elif reason == "full_time":
            label = "No foul before full time"

    detail = resolved_outcome_detail(label, minute, reason)
    return {
        "label": label,
        "detail": detail,
        "reason": reason,
        "context": opportunity.context,
        "target": target,
        "teamLabel": team_label,
        "minute": minute,
        "optionId": option.option_id if option else None,
        "optionLabel": option.label if option else None,
        "eventAction": event.get("action") if event else None,
    }


def outcome_option(opportunity: Opportunity, target: str | None, team_scope: str | None = None) -> OpportunityOption | None:
    if target is None:
        return None
    for option in opportunity.options:
        if option.target != target:
            continue
        if team_scope is not None and option.team_scope != team_scope:
            continue
        return option
    for option in opportunity.options:
        if option.target == target:
            return option
    return None


def event_team_label(event: dict[str, Any] | None, opportunity: Opportunity) -> str | None:
    if not event:
        return None
    label = event.get("participantLabel") or event.get("possessionLabel")
    if label:
        return str(label)
    scope = event_team_scope(event, opportunity)
    if scope == "participant1":
        return opportunity.source_event.get("_participant1Label")
    if scope == "participant2":
        return opportunity.source_event.get("_participant2Label")
    return None


def event_team_scope(event: dict[str, Any] | None, opportunity: Opportunity) -> str | None:
    if not event:
        return None
    event_team = event.get("participant") or event.get("possession")
    event_label = event.get("participantLabel") or event.get("possessionLabel")
    participant1 = opportunity.source_event.get("_participant1Label")
    participant2 = opportunity.source_event.get("_participant2Label")
    if str(event_team) == "1" or bool(participant1 and event_label == participant1):
        return "participant1"
    if str(event_team) == "2" or bool(participant2 and event_label == participant2):
        return "participant2"
    return None


def resolved_outcome_detail(label: str, minute: Any, reason: str) -> str:
    if minute is not None:
        return f"Resolved by match event at {minute}'."
    if reason == "full_time":
        return "Resolved at full time."
    if reason == "expired":
        return "Resolved when the market window expired."
    return f"Resolved outcome: {label}."


def evaluate_prediction_event(prediction: Prediction, opportunity: Opportunity, event: dict[str, Any]) -> bool | None:
    if event.get("confirmed") is not None and not truthy(event.get("confirmed")) and not _event_has_text(event, "action_discarded"):
        return None

    targets = event_targets(event)
    if not targets:
        return None

    if opportunity.context == "penalties":
        same_penalty_team = event_matches_team_scope("same_team", event, opportunity)
        if "goal" in targets and same_penalty_team:
            return prediction.option.target == "goal"
        if targets.intersection({"miss", "saved"}) and same_penalty_team:
            return prediction.option.target == "no_goal"
        return None

    if opportunity.context == "goal_next_10":
        if "goal" in targets:
            return prediction.option.target == "goal"
        return None

    if opportunity.context == "next_goal_team":
        if "goal" in targets:
            if prediction.option.target == "no_goal":
                return False
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_corner":
        if "corner" in targets:
            if prediction.option.target == "no_corner":
                return False
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_card":
        if "card" in targets:
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_substitution":
        if "substitution" in targets:
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_free_kick":
        if "free_kick" in targets:
            if prediction.option.target == "no_free_kick":
                return False
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_yellow_card":
        if "yellow_card" in targets:
            if prediction.option.target == "no_yellow_card":
                return False
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if opportunity.context == "next_foul":
        if "foul" in targets:
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if prediction.option.target in targets:
        return True
    if targets.intersection({"goal", "miss", "saved", "cancel", "card", "yellow_card", "confirmed"}):
        return False
    return None


def opportunity_resolved_by_event(opportunity: Opportunity, event: dict[str, Any]) -> bool:
    """Return whether an event supplies the outcome for an unentered market."""

    if event.get("confirmed") is not None and not truthy(event.get("confirmed")) and not _event_has_text(event, "action_discarded"):
        return False
    targets = event_targets(event)
    target_by_context = {
        "penalties": {"goal", "miss", "saved", "cancel"},
        "goal_next_10": {"goal"},
        "next_goal_team": {"goal"},
        "next_corner": {"corner"},
        "next_card": {"card"},
        "next_substitution": {"substitution"},
        "next_free_kick": {"free_kick"},
        "next_yellow_card": {"yellow_card"},
        "next_foul": {"foul"},
    }
    expected_targets = target_by_context.get(opportunity.context, set())
    if not targets.intersection(expected_targets):
        return False
    if opportunity.context == "penalties" and "cancel" not in targets:
        return event_matches_team_scope("same_team", event, opportunity)
    return True


def penalty_cancelled_for_opportunity(opportunity: Opportunity, event: dict[str, Any]) -> bool:
    if opportunity.context != "penalties" or "cancel" not in event_targets(event):
        return False
    if event_team_scope(event, opportunity) is None:
        return True
    return event_matches_team_scope("same_team", event, opportunity)


def event_targets(event: dict[str, Any]) -> set[str]:
    targets: set[str] = set()
    flags = set(event.get("highlights") or [])
    action = _event_token(event.get("action"))
    cancelled = "discarded" in flags or _event_has_text(
        event,
        "action_discarded",
        "annule",
        "overturned",
        "cancel",
        "no goal",
        "no_goal",
    )
    if cancelled:
        targets.add("cancel")
    var_review_without_score = action in {"var", "var_start"} and not _event_score_has_value(event)
    if not cancelled and (
        "goal" in flags
        or (_event_has_text(event, "goal", "but") and not _event_has_text(event, "goal_kick", "goal kick", "goalkick"))
    ) and not var_review_without_score:
        targets.add("goal")
    if _event_has_text(event, "miss", "missed", "off target", "off_target", "wide"):
        targets.add("miss")
    if _event_has_text(event, "saved", "save", "stopped", "arrêt", "arrete"):
        targets.add("saved")
    if "yellow_card" in flags or _event_has_text(event, "yellow_card", "yellow card", "carton jaune"):
        targets.add("yellow_card")
        targets.add("card")
    if "red_card" in flags or _event_has_text(event, "red_card", "red card", "carton rouge"):
        targets.add("card")
        targets.add("red_card")
    if "foul" in flags or _event_has_text(event, "foul", "faute"):
        targets.add("foul")
    if event.get("confirmed") is not None and truthy(event.get("confirmed")):
        targets.add("confirmed")
    if "corner" in flags or _event_has_text(event, "corner"):
        targets.add("corner")
        targets.add("set_piece")
    if "free_kick" in flags or _event_has_text(event, "free_kick", "free kick", "coup franc"):
        targets.add("free_kick")
        targets.add("set_piece")
    if "substitution" in flags or _event_has_text(
        event,
        "substitution",
        "substitute",
        "player_on",
        "player_off",
        "player on",
        "player off",
        "remplacement",
        "changement",
    ):
        targets.add("substitution")
    if _event_has_text(event, "shot", "tir"):
        targets.add("shot")
    if _event_has_text(event, "high_danger", "danger_possession", "attack_possession"):
        targets.add("pressure")
    return targets


def _event_score_has_value(event: dict[str, Any]) -> bool:
    score = event.get("score")
    return isinstance(score, dict) and (score.get("participant1") is not None or score.get("participant2") is not None)


def event_matches_team_scope(team_scope: str, event: dict[str, Any], opportunity: Opportunity) -> bool:
    if team_scope == "any":
        return True

    event_team = event.get("participant") or event.get("possession")
    event_label = event.get("participantLabel") or event.get("possessionLabel")

    if team_scope == "same_team":
        if opportunity.team is not None and event_team is not None:
            return str(event_team) == str(opportunity.team)
        return bool(opportunity.team_label and event_label == opportunity.team_label)

    if team_scope == "participant1":
        expected_label = opportunity.source_event.get("_participant1Label")
        return str(event_team) == "1" or bool(expected_label and event_label == expected_label)

    if team_scope == "participant2":
        expected_label = opportunity.source_event.get("_participant2Label")
        return str(event_team) == "2" or bool(expected_label and event_label == expected_label)

    return False


def public_vote(vote: dict[str, Any]) -> dict[str, Any]:
    predictions = {}
    for option_id, items in vote["predictions"].items():
        predictions[option_id] = {
            "count": len(items),
            "weight": round(sum(float(item.get("weight") or 0) for item in items), 2),
        }
    top_count = max((item["count"] for item in predictions.values()), default=0)
    tied = len([item for item in predictions.values() if item["count"] == top_count]) > 1
    active_count = max(0, int(vote.get("activeCount") or 0))
    public = {
        "activeCount": active_count,
        "neutralCount": vote["neutralCount"],
        "infoRequestCount": len(vote["infoRequests"]),
        "predictions": predictions,
        "topVoteCount": top_count,
        "consensus": top_count / active_count if active_count else 0.0,
        "supportFraction": top_count / active_count if active_count else 0.0,
        "tie": tied,
    }
    if vote.get("source"):
        public["source"] = vote.get("source")
    if vote.get("agentDecisionCount") is not None:
        public["agentDecisionCount"] = vote.get("agentDecisionCount")
        public["agentCoverage"] = vote.get("agentCoverage")
        public["aliveCount"] = vote.get("aliveCount")
        public["engagedCount"] = vote.get("engagedCount")
        public["woundedCount"] = vote.get("woundedCount")
        public["market"] = vote.get("market", {})
        public["voteCounts"] = vote.get("voteCounts", {})
        public["voteLabels"] = vote.get("voteLabels", {})
        public["roleVoteCounts"] = vote.get("roleVoteCounts", {})
        public["roleAntCounts"] = vote.get("roleAntCounts", {})
        public["reliabilitySummary"] = vote.get("reliabilitySummary", {})
        public["agentSamples"] = vote.get("agentSamples", [])
    return public


def reliability_summary(reliability: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(reliability, dict):
        return {}
    return {
        "level": reliability.get("level"),
        "qualityScore": reliability.get("qualityScore"),
        "issueCodes": list(reliability.get("issueCodes") or []),
        "sampleSize": reliability.get("sampleSize"),
        "signalSampleSize": reliability.get("signalSampleSize"),
        "recentSampleSize": reliability.get("recentSampleSize"),
        "recentSignalSampleSize": reliability.get("recentSignalSampleSize"),
        "unresolvedVar": bool(reliability.get("unresolvedVar")),
    }


def agent_reliability_context(reliability: dict[str, Any] | None) -> dict[str, Any]:
    """Expose source quality without leaking another role's sample volumes."""

    if not isinstance(reliability, dict):
        return {}
    return {
        "level": reliability.get("level"),
        "qualityScore": reliability.get("qualityScore"),
        "issueCodes": list(reliability.get("issueCodes") or []),
        "unresolvedVar": bool(reliability.get("unresolvedVar")),
        "confirmedFalseCount": reliability.get("confirmedFalseCount"),
        "discardedCount": reliability.get("discardedCount"),
        "amendedCount": reliability.get("amendedCount"),
        "confirmedMissingIsNeutral": True,
    }


def build_market_signal_pack(
    match_state: MatchState | None,
    opportunity: Opportunity,
) -> dict[str, Any]:
    """Build one deterministic TXLine-derived evidence packet for a market.

    The packet contains all three lenses, but callers must select exactly one
    with :func:`role_evidence_from_signal_pack` before creating an ant payload.
    Reliability is deliberately factual: only explicit bad or missing source
    states are reported, and ``confirmed=None`` remains neutral.
    """

    source_event = opportunity.source_event if isinstance(opportunity.source_event, dict) else {}
    raw_events = list(match_state.recent_events) if match_state else []
    if source_event and not any(_same_signal_record(source_event, item) for item in raw_events):
        raw_events.append(source_event)
    canonical_events = canonicalize_signal_events(raw_events)

    history_clock = max(
        (clock for event in canonical_events if (clock := _signal_clock_seconds(event)) is not None),
        default=None,
    )
    source_clock = _signal_clock_seconds(source_event)
    current_clock = source_clock if source_clock is not None else history_clock
    source_minute = parse_int(source_event.get("minute"))
    current_minute = source_minute
    if current_minute is None and current_clock is not None:
        current_minute = current_clock // 60

    score = _signal_score_from_canonical_events(canonical_events)
    raw_history_has_score = any(_event_score_has_value(event) for event in raw_events)
    if score is None and not raw_history_has_score:
        score = match_state.score if match_state and isinstance(match_state.score, dict) else None
    score_context = _signal_score_context(score, current_minute, current_clock)

    recent_events = [
        event
        for event in canonical_events
        if current_clock is not None
        and (event_clock := _signal_clock_seconds(event)) is not None
        and current_clock - 300 <= event_clock <= current_clock
    ]

    cumulative_counts = _empty_signal_counts()
    recent_counts = _empty_signal_counts()
    classified_events: list[dict[str, Any]] = []
    recent_classified_events: list[dict[str, Any]] = []
    classified_missing_clock = 0
    classified_missing_team = 0

    for event in canonical_events:
        signal_types = _signal_types(event)
        if not signal_types:
            continue
        if event.get("confirmed") is not None and not truthy(event.get("confirmed")):
            continue
        classified_events.append(event)
        team_key = _signal_team_key(event, match_state)
        event_clock = _signal_clock_seconds(event)
        if team_key == "unknown":
            classified_missing_team += 1
        if event_clock is None:
            classified_missing_clock += 1
        for signal_type in signal_types:
            cumulative_counts[team_key][signal_type] += 1
        if (
            current_clock is not None
            and event_clock is not None
            and current_clock - 300 <= event_clock <= current_clock
        ):
            recent_classified_events.append(event)
            for signal_type in signal_types:
                recent_counts[team_key][signal_type] += 1

    reliability = _signal_reliability(
        raw_events=raw_events,
        canonical_events=canonical_events,
        classified_events=classified_events,
        recent_events=recent_events,
        recent_classified_events=recent_classified_events,
        current_clock=current_clock,
        score_available=bool(score_context["scoreAvailable"]),
        missing_clock_count=classified_missing_clock,
        missing_team_count=classified_missing_team,
    )
    team_labels = {
        "participant1": match_state.participant1 if match_state else None,
        "participant2": match_state.participant2 if match_state else None,
        "unknown": "Unknown team",
    }
    recent_event_sample = [
        _signal_event_brief(event, match_state, current_clock)
        for event in recent_classified_events[-8:]
    ]
    role_evidence = {
        "reactive": {
            "role": "reactive",
            "windowMinutes": 5,
            "sampleSize": len(recent_events),
            "signalSampleSize": len(recent_classified_events),
            "countsByTeam": recent_counts,
            "teamLabels": team_labels,
            "recentEvents": recent_event_sample,
        },
        "statistical": {
            "role": "statistical",
            "scope": "full_match_so_far",
            "sampleSize": len(canonical_events),
            "signalSampleSize": len(classified_events),
            "eventCount": len(canonical_events),
            "countsByTeam": cumulative_counts,
            "teamLabels": team_labels,
        },
        "situational": {
            "role": "situational",
            "scoreMinuteContext": score_context,
            "marketContext": opportunity.context,
            "riskSugar": MARKET_RISK_SUGAR,
            "options": [
                {
                    "optionId": option.option_id,
                    "rewardSugar": option.reward_sugar,
                    "risk": option.risk,
                }
                for option in opportunity.options
            ],
        },
    }
    return {
        "fixtureId": match_state.fixture_id if match_state else source_event.get("fixtureId"),
        "marketContext": opportunity.context,
        "reliability": reliability,
        "roleEvidence": role_evidence,
    }


def role_evidence_from_signal_pack(signal_pack: dict[str, Any], role: str) -> dict[str, Any]:
    role_key = role if role in VALID_ANALYSIS_ROLES else "situational"
    evidence_by_role = signal_pack.get("roleEvidence")
    if not isinstance(evidence_by_role, dict):
        return {"role": role_key}
    evidence = evidence_by_role.get(role_key)
    return copy.deepcopy(evidence) if isinstance(evidence, dict) else {"role": role_key}


def canonicalize_signal_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate event revisions and apply explicit amendments/discards."""

    canonical: list[dict[str, Any] | None] = []
    sequence_indexes: dict[str, int] = {}
    latest_id_indexes: dict[str, int] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        action = _event_token(event.get("action"))
        event_id = event.get("id")
        id_key = str(event_id) if event_id is not None else None
        if action == "action_discarded":
            if id_key is not None and id_key in latest_id_indexes:
                canonical[latest_id_indexes[id_key]] = None
            continue
        if action in {"action_amend", "action_amended"}:
            if id_key is not None and id_key in latest_id_indexes:
                index = latest_id_indexes[id_key]
                canonical[index] = event
            else:
                index = len(canonical)
                canonical.append(event)
            amended_sequence = event.get("seq")
            if amended_sequence is not None:
                sequence_indexes[str(amended_sequence)] = index
            if id_key is not None:
                latest_id_indexes[id_key] = index
            continue

        sequence = event.get("seq")
        sequence_key = str(sequence) if sequence is not None else None
        if id_key is not None and id_key in latest_id_indexes:
            index = latest_id_indexes[id_key]
            canonical[index] = event
        elif sequence_key is not None and sequence_key in sequence_indexes:
            index = sequence_indexes[sequence_key]
            canonical[index] = event
        else:
            index = len(canonical)
            canonical.append(event)
        if sequence_key is not None:
            sequence_indexes[sequence_key] = index
        if id_key is not None:
            latest_id_indexes[id_key] = index
    return [event for event in canonical if isinstance(event, dict)]


def _same_signal_record(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_seq = left.get("seq")
    right_seq = right.get("seq")
    if left_seq is not None and right_seq is not None:
        return str(left_seq) == str(right_seq)
    return left is right


def _empty_signal_counts() -> dict[str, dict[str, int]]:
    return {
        team: {signal_type: 0 for signal_type in SIGNAL_COUNT_KEYS}
        for team in ("participant1", "participant2", "unknown")
    }


def _signal_types(event: dict[str, Any]) -> set[str]:
    flags = {_event_token(value) for value in event.get("highlights") or []}
    targets = event_targets(event)
    signal_types: set[str] = set()
    if "goal" in targets:
        signal_types.add("goal")
    if "shot" in targets:
        signal_types.add("shot")
    if "corner" in targets:
        signal_types.add("corner")
    if "free_kick" in targets:
        signal_types.add("free_kick")
    if "foul" in targets:
        signal_types.add("foul")
    if "substitution" in targets:
        signal_types.add("substitution")
    if "yellow_card" in targets:
        signal_types.add("yellow")
    if "red_card" in targets:
        signal_types.add("red")
    penalty_tokens = {
        _event_token(event.get(key))
        for key in ("action", "type", "outcome", "goalType")
    }
    penalty_event = (
        "penalty" in flags
        or _event_is_penalty_award(event)
        or bool(
            penalty_tokens.intersection(
                {
                    "penalty",
                    "penalty_scored",
                    "penalty_saved",
                    "penalty_missed",
                    "penalty_failed",
                    "spot_kick",
                }
            )
        )
    )
    if penalty_event:
        signal_types.add("penalty")
        if "goal" in targets:
            signal_types.add("penalty_scored")
        elif targets.intersection({"miss", "saved"}):
            signal_types.add("penalty_missed")
    if "high_danger" in flags or _event_has_text(event, "high_danger", "high danger", "danger_possession"):
        signal_types.add("danger")
    if "attack" in flags or _event_has_text(event, "attack_possession", "attack possession"):
        signal_types.add("attack")
    return signal_types


def _signal_requires_confirmation(event: dict[str, Any]) -> bool:
    return bool(
        _signal_types(event).intersection(
            {"goal", "penalty", "penalty_scored", "penalty_missed"}
        )
    )


def _signal_clock_seconds(event: dict[str, Any]) -> int | None:
    clock = parse_int(event.get("clockSeconds"))
    if clock is not None and clock >= 0:
        return clock
    minute = parse_int(event.get("minute"))
    return minute * 60 if minute is not None and minute >= 0 else None


def _signal_team_key(event: dict[str, Any], match_state: MatchState | None) -> str:
    participant = event.get("participant")
    possession = event.get("possession")
    for value in (participant, possession):
        if str(value) == "1":
            return "participant1"
        if str(value) == "2":
            return "participant2"

    labels = [event.get("participantLabel"), event.get("possessionLabel")]
    participant1 = str(match_state.participant1 or "").strip().casefold() if match_state else ""
    participant2 = str(match_state.participant2 or "").strip().casefold() if match_state else ""
    for label in labels:
        normalized = str(label or "").strip().casefold()
        if normalized and participant1 and normalized == participant1:
            return "participant1"
        if normalized and participant2 and normalized == participant2:
            return "participant2"
    return "unknown"


def _signal_score_from_canonical_events(
    events: Iterable[dict[str, Any]],
) -> dict[str, int | None] | None:
    """Rebuild the latest score without trusting an event later discarded."""

    score: dict[str, int | None] = {"participant1": None, "participant2": None}
    found = False
    for event in events:
        if event.get("confirmed") is not None and not truthy(event.get("confirmed")):
            continue
        event_score = event.get("score")
        if not isinstance(event_score, dict):
            continue
        for participant in ("participant1", "participant2"):
            value = parse_int(event_score.get(participant))
            if value is None:
                continue
            score[participant] = value
            found = True
    if not found:
        return None
    return {
        "participant1": score["participant1"],
        "participant2": score["participant2"],
    }


def _signal_score_context(
    score: dict[str, Any] | None,
    minute: int | None,
    clock_seconds: int | None,
) -> dict[str, Any]:
    participant1 = parse_int(score.get("participant1")) if isinstance(score, dict) else None
    participant2 = parse_int(score.get("participant2")) if isinstance(score, dict) else None
    score_available = participant1 is not None and participant2 is not None
    time_available = minute is not None or clock_seconds is not None
    available = score_available and time_available
    if not score_available:
        leader = "unknown"
    elif participant1 == participant2:
        leader = "tied"
    elif participant1 > participant2:
        leader = "participant1"
    else:
        leader = "participant2"
    return {
        "available": available,
        "scoreAvailable": score_available,
        "timeAvailable": time_available,
        "score": {
            "participant1": participant1,
            "participant2": participant2,
        },
        "minute": minute,
        "clockSeconds": clock_seconds,
        "leader": leader,
    }


def _signal_reliability(
    *,
    raw_events: list[dict[str, Any]],
    canonical_events: list[dict[str, Any]],
    classified_events: list[dict[str, Any]],
    recent_events: list[dict[str, Any]],
    recent_classified_events: list[dict[str, Any]],
    current_clock: int | None,
    score_available: bool,
    missing_clock_count: int,
    missing_team_count: int,
) -> dict[str, Any]:
    scoped_raw_events = _recent_reliability_events(raw_events, current_clock)
    scoped_canonical_events = _recent_reliability_events(canonical_events, current_clock)
    unconfirmed_count = len(
        [
            event
            for event in scoped_canonical_events
            if event.get("confirmed") is not None and not truthy(event.get("confirmed"))
            and _signal_requires_confirmation(event)
        ]
    )
    discarded_count = len(
        [event for event in scoped_raw_events if _event_token(event.get("action")) == "action_discarded"]
    )
    amended_count = len(
        [
            event
            for event in scoped_raw_events
            if _event_token(event.get("action")) in {"action_amend", "action_amended"}
        ]
    )
    unresolved_var = _has_unresolved_var(raw_events)
    latest_event_clock = max(
        (clock for event in canonical_events if (clock := _signal_clock_seconds(event)) is not None),
        default=None,
    )

    issues: list[dict[str, Any]] = []

    def add_issue(code: str, count: int | None = None) -> None:
        issue: dict[str, Any] = {"code": code}
        if count is not None:
            issue["count"] = count
        issues.append(issue)

    if unconfirmed_count:
        add_issue("explicitly_unconfirmed", unconfirmed_count)
    if unresolved_var:
        add_issue("unresolved_var")
    if discarded_count:
        add_issue("discarded_action", discarded_count)
    if amended_count:
        add_issue("amended_action", amended_count)
    if current_clock is None:
        add_issue("missing_current_clock")
    if missing_clock_count:
        add_issue("missing_event_clock", missing_clock_count)
    if missing_team_count:
        add_issue("missing_event_team", missing_team_count)
    if not score_available:
        add_issue("missing_score")
    if not canonical_events:
        add_issue("missing_sample")
    elif len(recent_events) < 2:
        add_issue("small_recent_sample", len(recent_events))
    if (
        current_clock is not None
        and latest_event_clock is not None
        and current_clock - latest_event_clock > 300
    ):
        add_issue("stale_event_clock")

    critical_codes = {"explicitly_unconfirmed", "unresolved_var"}
    issue_codes = [str(issue["code"]) for issue in issues]
    if any(code in critical_codes for code in issue_codes):
        level = "poor"
    elif issues:
        level = "limited"
    else:
        level = "good"
    quality_score = max(
        0.0,
        1.0
        - sum(0.3 if code in critical_codes else 0.1 for code in issue_codes),
    )
    return {
        "level": level,
        "qualityScore": round(quality_score, 2),
        "issues": issues,
        "issueCodes": issue_codes,
        "eventCount": len(canonical_events),
        "sampleSize": len(canonical_events),
        "signalSampleSize": len(classified_events),
        "recentSampleSize": len(recent_events),
        "recentSignalSampleSize": len(recent_classified_events),
        "unresolvedVar": unresolved_var,
        "confirmedFalseCount": unconfirmed_count,
        "discardedCount": discarded_count,
        "amendedCount": amended_count,
        "confirmedMissingIsNeutral": True,
    }


def _recent_reliability_events(
    events: list[dict[str, Any]],
    current_clock: int | None,
) -> list[dict[str, Any]]:
    if current_clock is None:
        return events[-12:]
    recent = [
        event
        for event in events
        if (clock := _signal_clock_seconds(event)) is not None
        and current_clock - 300 <= clock <= current_clock
    ]
    return recent or events[-12:]


def _has_unresolved_var(events: list[dict[str, Any]]) -> bool:
    unresolved = False
    for event in events:
        action = _event_token(event.get("action"))
        if action in {"var_end", "var_complete", "var_completed"}:
            unresolved = False
            continue
        if action not in {"var", "var_start"}:
            continue
        has_explicit_resolution = _event_has_text(
            event,
            "var end",
            "overturned",
            "confirmed goal",
            "goal confirmed",
            "penalty confirmed",
            "no penalty",
            "review complete",
        )
        unresolved = not has_explicit_resolution
    return unresolved


def _signal_event_brief(
    event: dict[str, Any],
    match_state: MatchState | None,
    current_clock: int | None,
) -> dict[str, Any]:
    event_clock = _signal_clock_seconds(event)
    return {
        "secondsAgo": (
            max(0, current_clock - event_clock)
            if current_clock is not None and event_clock is not None
            else None
        ),
        "action": event.get("action"),
        "team": _signal_team_key(event, match_state),
        "signalTypes": sorted(_signal_types(event)),
    }


def recent_event_brief(match_state: MatchState | None) -> list[dict[str, Any]]:
    if not match_state:
        return []
    items = []
    for event in list(match_state.recent_events)[-8:]:
        items.append(
            {
                "minute": event.get("minute"),
                "action": event.get("action"),
                "team": event.get("participantLabel") or event.get("possessionLabel"),
                "confirmed": event.get("confirmed"),
                "score": event.get("score"),
                "description": event.get("description"),
            }
        )
    return items


def agent_squad_context(colony: ColonyState, event_index: int) -> list[dict[str, Any]]:
    archetypes = Counter(ant.archetype for ant in colony.active_ants(event_index))
    squads = [
        {
            "squad": "data",
            "ants": archetypes.get("data_first", 0) + max(0, archetypes.get("cautious", 0) // 2),
            "objective": "Check info, score, confirmation, memory and avoid false signals.",
        },
        {
            "squad": "momentum",
            "ants": archetypes.get("momentum", 0) + max(0, archetypes.get("balanced", 0) // 2),
            "objective": "Read recent pressure, dangerous possession, shots and corners.",
        },
        {
            "squad": "risk",
            "ants": archetypes.get("opportunist", 0) + max(0, archetypes.get("balanced", 0) // 2),
            "objective": "Look for good multipliers without committing too many ants.",
        },
        {
            "squad": "survival",
            "ants": max(1, archetypes.get("cautious", 0)),
            "objective": "Preserve resources when the colony is fragile.",
        },
        {
            "squad": "chaos",
            "ants": archetypes.get("chaos", 0),
            "objective": "Spot cards, VAR, rare calls and volatile swings.",
        },
    ]
    return [squad for squad in squads if squad["ants"] > 0]


def describe_vote(colony: ColonyState, vote: dict[str, Any], *, after_info: bool = False) -> str:
    if vote.get("source") == "deepseek_ant_agents":
        prefix = "After info, " if after_info else ""
        vote_summary = format_market_vote_summary(vote)
        top_label = top_voted_option_label(vote)
        proposition = (vote.get("market") or {}).get("proposition") or "market"
        return f"{prefix}{colony.name}: {proposition} | {vote_summary}. Top: {top_label}."

    counts = {option_id: len(items) for option_id, items in vote["predictions"].items()}
    top_option, top_count = max(counts.items(), key=lambda item: item[1]) if counts else ("-", 0)
    prefix = "After info, " if after_info else ""
    return f"{prefix}{colony.name}: {top_count} ants lean toward {top_option}, {len(vote['infoRequests'])} ask for more info."


def describe_ant_agent_vote(colony: ColonyState, vote: dict[str, Any]) -> str:
    coverage = round(float(vote.get("agentCoverage", 0.0)) * 100)
    proposition = (vote.get("market") or {}).get("proposition") or "market"
    answered_count = int(vote.get("agentDecisionCount", 0) or 0)
    active_count = int(vote.get("activeCount", 0) or 0)
    alive_count = vote.get("aliveCount")
    wounded_count = int(vote.get("woundedCount", 0) or 0)
    answer_label = (
        f"{answered_count} voting ants answered"
        if answered_count == active_count
        else f"{answered_count}/{active_count} voting ants answered"
    )
    status_parts = [f"{coverage}%"]
    if alive_count is not None:
        status_parts.append(f"{alive_count} alive")
    if wounded_count:
        status_parts.append(f"{wounded_count} wounded")
    return f"DeepSeek vote from {colony.name}: {answer_label} ({'; '.join(status_parts)}) on {proposition}: {format_market_vote_summary(vote)}."


def format_market_vote_summary(vote: dict[str, Any]) -> str:
    counts = vote.get("voteCounts") or {}
    order = ["yes", "no", "option_a", "option_b", "option_c", "option_d", "abstain"]
    keys = [key for key in order if key in counts] + [key for key in counts if key not in order]
    return ", ".join(f"{key}={counts.get(key, 0)}" for key in keys)


def top_voted_option_label(vote: dict[str, Any]) -> str:
    counts = {
        option_id: len(items)
        for option_id, items in vote["predictions"].items()
    }
    best_count = max(counts.values(), default=0)
    best_option_ids = [option_id for option_id, count in counts.items() if count == best_count]
    if best_count <= 0:
        return "no prediction"
    if len(best_option_ids) != 1:
        return "tied vote — observe"
    best_option_id = best_option_ids[0]
    for market_vote, label in (vote.get("voteLabels") or {}).items():
        for item in vote["predictions"].get(best_option_id, []):
            if item.get("vote") == market_vote:
                return f"{best_count} ants on {label}"
    return f"{best_count} ants on {best_option_id}"


def describe_agent_decision(colony: ColonyState, decision: ColonyAgentDecision) -> str:
    model = str(decision.raw.get("_model") or "")
    source = "DeepSeek" if decision.source == "openrouter" and "deepseek" in model.casefold() else "Agent"
    if decision.source not in {"openrouter", "test"}:
        source = "Agent"
    squad_summary = describe_squad_votes(decision)
    if decision.action == "observe":
        suffix = f" | {squad_summary}" if squad_summary else ""
        return f"{source} {colony.name}: observes ({round(decision.confidence * 100)}% confidence).{suffix}"
    if decision.buy_info and decision.stage == "pre_info":
        suffix = f" | {squad_summary}" if squad_summary else ""
        return f"{source} {colony.name}: asks for an info packet before deciding.{suffix}"
    if decision.action == "predict" and decision.option_id:
        percent = round(decision.stake_fraction * 100)
        suffix = f" | {squad_summary}" if squad_summary else ""
        return f"{source} {colony.name}: plays {decision.option_id} with {percent}% of active ants.{suffix}"
    suffix = f" | {squad_summary}" if squad_summary else ""
    return f"{source} {colony.name}: no usable decision.{suffix}"


def describe_squad_votes(decision: ColonyAgentDecision) -> str:
    if not decision.squad_votes:
        return ""
    parts = []
    for vote in decision.squad_votes[:4]:
        action = vote.get("action")
        if action == "predict":
            call = vote.get("optionId") or "predict"
        elif action == "info":
            call = "info"
        else:
            call = "observe"
        parts.append(f"{vote.get('squad')}:{call}")
    return "squads " + ", ".join(parts)


def describe_agent_usage_cost(usage: dict[str, Any] | None) -> str | None:
    if not usage:
        return None
    api_calls = int(usage.get("apiCalls") or 0)
    budgeted_calls = int(usage.get("budgetedCalls") or 0)
    if api_calls <= 0 and budgeted_calls <= 0:
        return None
    if api_calls <= 0:
        return f"AI cost unavailable: no OpenRouter usage received for {budgeted_calls} calls."

    cost = float(usage.get("costUsd") or 0.0)
    input_tokens = int(usage.get("inputTokens") or 0)
    output_tokens = int(usage.get("outputTokens") or 0)
    calls_label = api_calls if api_calls > 0 else budgeted_calls
    message = (
        f"AI cost: {format_usd(cost)} · {calls_label} calls · "
        f"{input_tokens} input / {output_tokens} output tokens."
    )
    if not usage.get("costComplete", True):
        missing = int(usage.get("missingUsageResponses") or 0)
        message += f" Incomplete usage: {missing} response(s) without tokens."
    return message


def format_usd(value: float) -> str:
    if value == 0:
        return "$0.0000"
    if abs(value) < 0.01:
        return f"${value:.6f}".rstrip("0").rstrip(".")
    if abs(value) < 1:
        return f"${value:.4f}"
    return f"${value:.2f}"


def find_ant(colony: ColonyState, ant_id: str) -> AntState | None:
    for ant in colony.ants:
        if ant.ant_id == ant_id:
            return ant
    return None


def _event_has_text(event: dict[str, Any], *needles: str) -> bool:
    parts = [
        event.get("action"),
        event.get("type"),
        event.get("outcome"),
        event.get("freeKickType"),
        event.get("goalType"),
        event.get("possessionType"),
        event.get("description"),
        " ".join(event.get("details") or []),
        " ".join(event.get("highlights") or []),
    ]
    text = " ".join(str(part) for part in parts if part is not None).casefold()
    return any(needle.casefold() in text for needle in needles)


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "y", "confirmed"}
    return bool(value)


def parse_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None
