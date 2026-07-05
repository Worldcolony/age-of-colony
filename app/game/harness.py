from __future__ import annotations

import hashlib
import math
import random
import re
import time
import uuid
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Iterable

from .agents import ColonyAgentDecision, ColonyDecisionAgent


VALID_SIZES = {10, 20, 50}
VALID_STYLES = {"cautious", "balanced", "aggressive"}
VALID_CONTEXTS = {"penalties", "corners", "momentum", "chaos", "balanced"}
VALID_INFO_NEEDS = {"low", "medium", "high"}
JOINABLE_STATUSES = {"created", "waiting_kickoff", "running_live"}
STARTING_COLONY_ANTS = 20
STARTING_COLONY_FOOD = 20
STYLE_ALIASES = {
    "prudent": "cautious",
    "cautious": "cautious",
    "equilibre": "balanced",
    "balanced": "balanced",
    "agressif": "aggressive",
    "aggressive": "aggressive",
}
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

FOOD_DRAIN_BY_SIZE = {10: 1, 20: 1, 50: 1}
FOOD_DRAIN_INTERVAL_EVENTS = 24
LARVAE_INCUBATION_EVENTS = 18
GOAL_NEXT_10_SECONDS = 10 * 60
ROLLING_WINDOW_CONTEXTS = {"goal_next_10", "next_goal_team", "next_foul"}
NO_DEADLINE_CONTEXTS = {"penalties", "next_goal_team", "next_foul"}


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
    alive = len(colony.alive_ants)
    if alive <= 0:
        return 0
    return max(1, math.ceil(alive / 50))


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
    influence: float = 1.0
    alive: bool = True
    wounded_until_event: int = 0
    engaged_prediction_ids: set[str] = field(default_factory=set)
    memory: AntMemory = field(default_factory=AntMemory)

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


@dataclass
class PlayerState:
    player_id: str
    name: str
    anonymous_id: str | None = None

    def public_state(self) -> dict[str, Any]:
        state = {
            "playerId": self.player_id,
            "name": self.name,
        }
        if self.anonymous_id:
            state["anonymousId"] = self.anonymous_id
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
    ants: list[AntState] = field(default_factory=list)
    food: int = 0
    larvae: int = 0
    larvae_ready_events: list[int] = field(default_factory=list)
    last_food_event_index: int = 0
    memory: ColonyMemory = field(default_factory=ColonyMemory)

    @property
    def alive_ants(self) -> list[AntState]:
        return [ant for ant in self.ants if ant.alive]

    def active_ants(self, event_index: int) -> list[AntState]:
        return [ant for ant in self.ants if ant.is_active(event_index)]

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
        score_breakdown = {
            "base": 100,
            "survival": round((alive / base_size) * 30, 2),
            "growth": round(growth_rate * 60 + (larvae / base_size) * 20, 2),
            "foodNet": round((self.memory.food_net / base_size) * 40, 2),
            "foodReserve": round((self.food / base_size) * 10, 2),
            "accuracy": round(self.memory.accuracy * 80, 2),
            "lossPenalty": round(-mortality_rate * 70, 2),
        }
        score = round(sum(score_breakdown.values()), 2)
        state = {
            "colonyId": self.colony_id,
            "name": self.name,
            "size": self.size,
            "style": self.style,
            "favoriteContext": self.favorite_context,
            "infoNeed": self.info_need,
            "antsAlive": alive,
            "antsActive": ant_counts["activeCount"],
            "antsEngaged": ant_counts["engagedCount"],
            "antsWounded": wounded,
            "antsDead": dead,
            "antsBorn": born,
            "food": self.food,
            "larvae": larvae,
            "score": score,
            "scoreBreakdown": score_breakdown,
            "accuracy": round(self.memory.accuracy, 3),
            "growthRate": round(growth_rate, 3),
            "mortalityRate": round(mortality_rate, 3),
            "foodNet": self.memory.food_net,
            "wins": self.memory.wins,
            "losses": self.memory.losses,
            "infoPurchases": self.memory.info_purchases,
            "archetypes": dict(Counter(ant.archetype for ant in self.ants)),
        }
        if self.player_id:
            state["playerId"] = self.player_id
        if self.player_anonymous_id:
            state["playerAnonymousId"] = self.player_anonymous_id
        return state


@dataclass(frozen=True)
class OpportunityOption:
    option_id: str
    label: str
    risk: str
    multiplier: float
    target: str
    team_scope: str = "same_team"


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
        return 8 if any(option.risk in {"wild", "chaos"} for option in self.options) else 5

    def public_state(self) -> dict[str, Any]:
        return {
            "opportunityId": self.opportunity_id,
            "fixtureId": self.fixture_id,
            "context": self.context,
            "label": self.label,
            "teamLabel": self.team_label,
            "minute": self.minute,
            "infoCost": self.info_cost,
            "options": [
                {
                    "optionId": option.option_id,
                    "label": option.label,
                    "risk": option.risk,
                    "multiplier": option.multiplier,
                }
                for option in self.options
            ],
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
    resolved: bool = False


@dataclass
class MatchState:
    fixture_id: Any
    participant1: str | None = None
    participant2: str | None = None
    score: dict[str, Any] | None = None
    possession_label: str | None = None
    recent_events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=30))

    def update(self, event: dict[str, Any]) -> None:
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
            "data": self.data,
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
    owner_anonymous_id: str | None = None
    owner_name: str | None = None
    seed: int = 7
    status: str = "created"
    mode: str | None = None
    event_index: int = 0
    players: list[PlayerState] = field(default_factory=list)
    colonies: dict[str, ColonyState] = field(default_factory=dict)
    match_state: MatchState | None = None
    opportunities: dict[str, Opportunity] = field(default_factory=dict)
    predictions: dict[str, Prediction] = field(default_factory=dict)
    last_opportunity_event_index_by_key: dict[str, int] = field(default_factory=dict)
    log: list[GameLogEvent] = field(default_factory=list)
    agent_usage: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        self.match_state = MatchState(self.fixture_id, self.participant1, self.participant2)

    def add_log(self, kind: str, message: str, data: dict[str, Any] | None = None) -> None:
        self.log.append(GameLogEvent(len(self.log), kind, message, data or {}))

    def public_state(self) -> dict[str, Any]:
        colonies = [colony.public_state(self.event_index) for colony in self.colonies.values()]
        colonies.sort(key=lambda item: item["score"], reverse=True)
        player_colonies = self._player_colonies()
        return {
            "gameId": self.game_id,
            "roomCode": self.room_code,
            "fixtureId": self.fixture_id,
            "participant1": self.participant1,
            "participant2": self.participant2,
            "competition": self.competition,
            "startTime": self.start_time,
            "startTimeIso": self.start_time_iso,
            "owner": {
                "anonymousId": self.owner_anonymous_id,
                "name": self.owner_name,
            }
            if self.owner_anonymous_id or self.owner_name
            else None,
            "status": self.status,
            "mode": self.mode,
            "eventIndex": self.event_index,
            "players": [self._public_player_state(player, player_colonies) for player in self.players],
            "match": {
                "score": self.match_state.score if self.match_state else None,
                "possessionLabel": self.match_state.possession_label if self.match_state else None,
            },
            "colonies": colonies,
            "activeOpportunities": [opportunity.public_state() for opportunity in self.opportunities.values()],
            "agentUsage": self.agent_usage,
            "logCount": len(self.log),
        }

    def _player_colonies(self) -> dict[str, ColonyState]:
        linked: dict[str, ColonyState] = {}
        for colony in self.colonies.values():
            if colony.player_id:
                linked[f"player:{colony.player_id}"] = colony
            if colony.player_anonymous_id:
                linked[f"anonymous:{colony.player_anonymous_id}"] = colony
        return linked

    def _public_player_state(self, player: PlayerState, player_colonies: dict[str, ColonyState]) -> dict[str, Any]:
        state = player.public_state()
        if player.anonymous_id and player.anonymous_id == self.owner_anonymous_id:
            state["isHost"] = True
        elif not self.owner_anonymous_id and player.name == self.owner_name:
            state["isHost"] = True
        colony = player_colonies.get(f"player:{player.player_id}")
        if not colony and player.anonymous_id:
            colony = player_colonies.get(f"anonymous:{player.anonymous_id}")
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
        clean_player_id = (player_id or "").strip()[:80] or None
        player = self._find_player(clean_player_id, clean_anonymous_id)
        if clean_anonymous_id and not player:
            raise ValueError("join the room before creating a colony")
        if player:
            for existing in self.room.colonies.values():
                if existing.player_id and existing.player_id == player.player_id:
                    raise ValueError("this player already has a colony")
                if player.anonymous_id and existing.player_anonymous_id == player.anonymous_id:
                    raise ValueError("this player already has a colony")
            clean_player_id = player.player_id
            clean_anonymous_id = player.anonymous_id

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
            food=STARTING_COLONY_FOOD,
        )
        colony.ants = generate_ants(colony)
        self.room.colonies[colony_id] = colony
        self.room.add_log(
            "colony_created",
            f"{colony.name} enters the game with {STARTING_COLONY_ANTS} ants and {STARTING_COLONY_FOOD} food.",
            {
                "colonyId": colony_id,
                "size": STARTING_COLONY_ANTS,
                "requestedSize": size,
                "startingFood": STARTING_COLONY_FOOD,
                "style": style,
                "favoriteContext": favorite_context,
                "infoNeed": info_need,
            },
        )
        return colony

    def join_player(self, name: str, anonymous_id: str | None = None) -> PlayerState:
        if self.room.status not in JOINABLE_STATUSES:
            raise ValueError("room is closed; new players can no longer join")
        clean_name = name.strip()[:32] or f"Player {len(self.room.players) + 1}"
        clean_anonymous_id = (anonymous_id or "").strip()[:80] or None
        if clean_anonymous_id:
            for player in self.room.players:
                if player.anonymous_id == clean_anonymous_id:
                    if player.name != clean_name:
                        player.name = clean_name
                        for colony in self.room.colonies.values():
                            if colony.player_id == player.player_id or (
                                player.anonymous_id and colony.player_anonymous_id == player.anonymous_id
                            ):
                                colony.name = clean_name
                        self.room.add_log(
                            "player_updated",
                            f"{player.name} updated their player name.",
                            {"playerId": player.player_id, "name": player.name, "anonymousId": player.anonymous_id},
                        )
                    return player
        player = PlayerState(player_id=f"player_{uuid.uuid4().hex[:8]}", name=clean_name, anonymous_id=clean_anonymous_id)
        self.room.players.append(player)
        self.room.add_log(
            "player_joined",
            f"{player.name} joined the room.",
            {"playerId": player.player_id, "name": player.name, "anonymousId": player.anonymous_id},
        )
        return player

    def _find_player(self, player_id: str | None = None, anonymous_id: str | None = None) -> PlayerState | None:
        for player in self.room.players:
            if player_id and player.player_id == player_id:
                return player
            if anonymous_id and player.anonymous_id == anonymous_id:
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
        if self.room.status != "created":
            raise ValueError("room is locked; strategies can no longer be changed")
        colony = self.room.colonies.get(colony_id)
        if not colony:
            raise ValueError("colony not found")

        if style is not None:
            style = normalize_style(style)
            if style not in VALID_STYLES:
                raise ValueError("style must be cautious, balanced or aggressive")
            colony.style = style
        if favorite_context is not None:
            favorite_context = normalize_context(favorite_context)
            if favorite_context not in VALID_CONTEXTS:
                raise ValueError("favorite_context must be penalties, corners, momentum, chaos or balanced")
            colony.favorite_context = favorite_context
        if info_need is not None:
            info_need = normalize_info_need(info_need)
            if info_need not in VALID_INFO_NEEDS:
                raise ValueError("info_need must be low, medium or high")
            colony.info_need = info_need

        self.room.add_log(
            "strategy_updated",
            f"{colony.name} strategy updated: {colony.style}, {colony.favorite_context}, info {colony.info_need}.",
            {
                "colonyId": colony.colony_id,
                "style": colony.style,
                "favoriteContext": colony.favorite_context,
                "infoNeed": colony.info_need,
            },
        )
        return colony

    def process_events(self, events: Iterable[dict[str, Any]]) -> None:
        self.room.status = "running_replay"
        for event in events:
            self.process_event(event)
        self.finish_game(mode="replay")

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
        self._settle_predictions(event)
        self._expire_predictions(event)
        if self.room.match_state:
            self.room.match_state.update(event)
        for colony in self.room.colonies.values():
            self._apply_colony_upkeep(colony)

        opportunities = build_opportunities(event, self.room.event_index, self.room.match_state)
        for opportunity in opportunities:
            if not self._claim_opportunity_slot(opportunity):
                continue
            self.room.opportunities[opportunity.opportunity_id] = opportunity
            self.room.add_log("opportunity", opportunity.label, {"opportunity": opportunity.public_state()})
            for colony in self.room.colonies.values():
                self._decide_for_colony(colony, opportunity)

        self._clear_old_opportunities()

    def _decide_for_colony(self, colony: ColonyState, opportunity: Opportunity) -> None:
        if not colony.alive_ants:
            return
        if not colony.active_ants(self.room.event_index):
            self.room.add_log(
                "observe",
                f"{colony.name} has no active ants for this window.",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id},
            )
            return

        first_vote = self._run_vote(colony, opportunity)
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
            colony.memory.info_purchases += 1
            opportunity.info_bought_by.add(colony.colony_id)
            bought_info = True
            self.room.add_log(
                "info",
                f"{colony.name} spends {info_packet.cost} food on an info packet.",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id, "info": info_packet.__dict__},
            )
            self.room.add_log(
                "info_result",
                f"Info received: {info_packet.summary}",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id},
            )
            final_vote = self._run_vote(colony, opportunity, info_packet=info_packet)
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
        )
        if not prediction:
            self.room.add_log(
                "observe",
                f"{colony.name} watches this window without committing ants.",
                {"colonyId": colony.colony_id, "opportunityId": opportunity.opportunity_id},
            )
            return

        self.room.predictions[prediction.prediction_id] = prediction
        self.room.add_log(
            "prediction",
            f"{colony.name} stakes {len(prediction.ant_ids)} ants on {prediction.option.label}.",
            {
                "colonyId": colony.colony_id,
                "opportunityId": opportunity.opportunity_id,
                "predictionId": prediction.prediction_id,
                "option": prediction.option.__dict__,
                "ants": len(prediction.ant_ids),
                "infoBought": bought_info,
            },
        )

    def _run_vote(
        self,
        colony: ColonyState,
        opportunity: Opportunity,
        *,
        info_packet: InfoPacket | None = None,
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
        agent_vote = self._ant_agent_vote(colony, opportunity, info_packet=info_packet)
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
    ) -> dict[str, Any] | None:
        decide_ants = getattr(self.decision_agent, "decide_ants", None)
        if not callable(decide_ants):
            raise RuntimeError("DeepSeek agent required: no local policy is allowed.")

        active_ants = colony.active_ants(self.room.event_index)
        if not active_ants:
            return None

        ant_counts = colony_ant_counts(colony, self.room.event_index)
        stage = "post_info" if info_packet else "pre_info"
        context = {
            "match": {
                "fixtureId": self.room.fixture_id,
                "participant1": self.room.participant1,
                "participant2": self.room.participant2,
                "score": self.room.match_state.score if self.room.match_state else None,
                "possessionLabel": self.room.match_state.possession_label if self.room.match_state else None,
                "recentEvents": recent_event_brief(self.room.match_state),
            },
            "colony": {
                "name": colony.name,
                "style": colony.style,
                "favoriteContext": colony.favorite_context,
                "infoNeed": colony.info_need,
                "food": colony.food,
                "antsAlive": ant_counts["aliveCount"],
                "antsActive": ant_counts["activeCount"],
                "antsEngaged": ant_counts["engagedCount"],
                "antsWounded": ant_counts["woundedCount"],
                "accuracy": round(colony.memory.accuracy, 3),
                "contextRate": round(colony.memory.context_rate(opportunity.context), 3),
            },
            "rules": {
                "stage": stage,
                "decisionFormat": "Each ant must answer with one vote from market.availableVotes.",
                "confidenceDisabled": True,
                "infoFeatureEnabled": False,
                "infoFeatureReason": "Paid info is disabled for now and will return later with concrete info types.",
                "oneDecisionPerAnt": True,
            },
            "opportunity": opportunity.public_state(),
            "market": agent_market_context(opportunity),
            "infoPacket": info_packet.__dict__ if info_packet else None,
        }
        ants = [ant_agent_context(ant, opportunity) for ant in active_ants]
        decisions = decide_ants(game_id=self.room.game_id, stage=stage, context=context, ants=ants)
        self._sync_agent_usage()
        vote = vote_from_ant_agent_decisions(colony, opportunity, self.room.event_index, decisions or [], info_packet=info_packet)
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
        self._consume_food(colony)
        self._hatch_larvae(colony)

    def _consume_food(self, colony: ColonyState) -> None:
        ticks = (self.room.event_index - colony.last_food_event_index) // FOOD_DRAIN_INTERVAL_EVENTS
        if ticks <= 0:
            return
        colony.last_food_event_index += ticks * FOOD_DRAIN_INTERVAL_EVENTS
        drain = food_drain_for_colony(colony) * ticks
        colony.food -= drain
        colony.memory.food_net -= drain
        if colony.food >= 0:
            return

        deficit = abs(colony.food)
        colony.food = 0
        deaths = min(deficit, len(colony.alive_ants))
        for ant in colony.alive_ants[:deaths]:
            ant.alive = False
            ant.engaged_prediction_ids.clear()
        if deaths:
            self.room.add_log(
                "starvation",
                f"{colony.name} loses {deaths} ants due to food shortage.",
                {"colonyId": colony.colony_id, "deaths": deaths},
            )

    def _hatch_larvae(self, colony: ColonyState) -> None:
        if not colony.larvae_ready_events:
            return
        ready = [event_index for event_index in colony.larvae_ready_events if event_index <= self.room.event_index]
        if not ready or colony.food <= 0:
            return

        hatch_count = min(len(ready), colony.food)
        remaining_ready = hatch_count
        next_queue: list[int] = []
        for ready_event_index in colony.larvae_ready_events:
            if ready_event_index <= self.room.event_index and remaining_ready > 0:
                remaining_ready -= 1
                continue
            next_queue.append(ready_event_index)
        colony.larvae_ready_events = next_queue
        colony.larvae = max(0, colony.larvae - hatch_count)
        colony.food -= hatch_count
        colony.memory.food_net -= hatch_count

        rng = random.Random(stable_seed(colony.seed, self.room.event_index, "hatch", len(colony.ants)))
        for _ in range(hatch_count):
            colony.ants.append(spawn_ant(colony, len(colony.ants), rng))
        self.room.add_log(
            "hatch",
            f"{colony.name}: {hatch_count} larvae hatch into new ants.",
            {"colonyId": colony.colony_id, "hatched": hatch_count, "foodCost": hatch_count},
        )

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
        cooldown_by_context = {
            "penalties": 2,
            "goal_next_10": 24,
            "next_goal_team": 24,
            "next_foul": 18,
        }
        key = self._opportunity_slot_key(opportunity)
        if opportunity.context in ROLLING_WINDOW_CONTEXTS.union({"penalties"}) and self._has_open_slot_prediction(key):
            return False
        last_event_index = self.room.last_opportunity_event_index_by_key.get(key, -10_000)
        if self.room.event_index - last_event_index < cooldown_by_context[opportunity.context]:
            return False
        self.room.last_opportunity_event_index_by_key[key] = self.room.event_index
        return True

    def _has_open_slot_prediction(self, key: str) -> bool:
        for prediction in self.room.predictions.values():
            if prediction.resolved:
                continue
            opportunity = self.room.opportunities.get(prediction.opportunity_id)
            if opportunity and self._opportunity_slot_key(opportunity) == key:
                return True
        return False

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
        colony.memory.attempts += 1
        colony.memory.context_attempts[opportunity.context] = colony.memory.context_attempts.get(opportunity.context, 0) + 1
        for ant_id in prediction.ant_ids:
            ant = find_ant(colony, ant_id)
            if ant:
                ant.memory.attempts_by_context[opportunity.context] = ant.memory.attempts_by_context.get(opportunity.context, 0) + 1

        stake = len(prediction.ant_ids)
        if win:
            food_gain = int(round(stake * prediction.option.multiplier))
            colony.food += food_gain
            colony.memory.wins += 1
            colony.memory.food_net += food_gain
            colony.memory.context_wins[opportunity.context] = colony.memory.context_wins.get(opportunity.context, 0) + 1
            for ant_id in prediction.ant_ids:
                ant = find_ant(colony, ant_id)
                if ant:
                    ant.influence = clamp(ant.influence + 0.04 * prediction.option.multiplier, 0.35, 2.25)
                    ant.memory.wins_by_context[opportunity.context] = ant.memory.wins_by_context.get(opportunity.context, 0) + 1
                    ant.memory.recent_losses = 0
                    if prediction.info_bought:
                        ant.memory.info_successes += 1
            message = f"Result {colony.name}: +{food_gain} resources on {prediction.option.label}."
            data = {"win": True, "food": food_gain, "resourceDelta": food_gain, "reason": reason}
        else:
            food_loss = max(1, int(round(stake * RESOURCE_LOSS_MULTIPLIER[prediction.option.risk])))
            actual_loss = min(colony.food, food_loss)
            colony.food -= actual_loss
            colony.memory.food_net -= actual_loss
            selected = [find_ant(colony, ant_id) for ant_id in prediction.ant_ids]
            selected = [ant for ant in selected if ant is not None]
            for ant in selected:
                ant.influence = clamp(ant.influence * 0.94, 0.35, 2.25)
                ant.memory.losses_by_context[opportunity.context] = ant.memory.losses_by_context.get(opportunity.context, 0) + 1
                ant.memory.recent_losses += 1
            colony.memory.losses += 1
            message = f"Result {colony.name}: -{actual_loss} resources on {prediction.option.label}."
            data = {"win": False, "food": -actual_loss, "resourceDelta": -actual_loss, "resourceLoss": actual_loss, "reason": reason}

        self.room.add_log(
            "settlement",
            message,
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "option": prediction.option.__dict__,
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
            if opportunity.context in {"goal_next_10", "next_goal_team"}:
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
        self.room.add_log(
            "void",
            f"{colony.name}: prediction voided on {prediction.option.label}.",
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "option": prediction.option.__dict__,
                "reason": reason,
                "ants": len(prediction.ant_ids),
            },
        )

    def _clear_old_opportunities(self) -> None:
        for opportunity_id, opportunity in list(self.room.opportunities.items()):
            has_open_prediction = any(
                prediction.opportunity_id == opportunity_id and not prediction.resolved
                for prediction in self.room.predictions.values()
            )
            if not has_open_prediction and self.room.event_index > opportunity.created_event_index:
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
        owner_name: str | None = None,
        room_code: str | None = None,
        competition: str | None = None,
        start_time: Any = None,
        start_time_iso: str | None = None,
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
            owner_anonymous_id=(owner_anonymous_id or "").strip()[:80] or None,
            owner_name=(owner_name or "").strip()[:32] or None,
            seed=seed if seed is not None else stable_seed(game_id, fixture_id) % 1_000_000,
        )
        room.add_log(
            "game_created",
            f"Room {clean_room_code} created for fixture {fixture_id}.",
            {
                "gameId": game_id,
                "roomCode": clean_room_code,
                "fixtureId": fixture_id,
                "ownerAnonymousId": room.owner_anonymous_id,
                "ownerName": room.owner_name,
            },
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
    return [spawn_ant(colony, index, rng) for index in range(colony.size)]


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


def build_opportunities(event: dict[str, Any], event_index: int, match_state: MatchState | None = None) -> list[Opportunity]:
    contexts = event_contexts(event)
    if not contexts:
        return []
    fixture_id = event.get("fixtureId")
    team = event.get("participant") or event.get("possession")
    team_label = event.get("participantLabel") or event.get("possessionLabel")
    minute = event.get("minute")
    clock = event.get("clockSeconds")
    participant1 = match_state.participant1 if match_state and match_state.participant1 else "A"
    participant2 = match_state.participant2 if match_state and match_state.participant2 else "B"
    source_event = dict(event)
    source_event["_participant1Label"] = participant1
    source_event["_participant2Label"] = participant2
    opportunities = []
    for context in contexts:
        options = opportunity_options(context, participant1, participant2, team_label)
        deadline_seconds = opportunity_deadline_seconds(context)
        deadline_events = opportunity_deadline_events(context)
        opportunities.append(
            Opportunity(
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
        )
    return opportunities


def event_context(event: dict[str, Any]) -> str | None:
    contexts = event_contexts(event)
    return contexts[0] if contexts else None


def event_contexts(event: dict[str, Any]) -> list[str]:
    flags = set(event.get("highlights") or [])
    if _event_is_penalty_award(event):
        targets = event_targets(event)
        if targets.intersection({"goal", "miss", "saved", "cancel"}):
            return []
        return ["penalties"]
    targets = event_targets(event)
    if targets.intersection({"goal", "yellow_card", "red_card", "foul", "cancel"}):
        return []
    if (
        "corner" in flags
        or "free_kick" in flags
        or _event_has_text(event, "high_danger", "danger_possession", "attack_possession", "corner", "free_kick", "free kick", "coup franc", "shot", "tir")
    ):
        return ["goal_next_10", "next_goal_team", "next_foul"]
    return []


def _event_is_penalty_award(event: dict[str, Any]) -> bool:
    action = _event_token(event.get("action"))
    event_type = _event_token(event.get("type"))
    flags = set(event.get("highlights") or [])
    award_tokens = {"penalty", "penalties", "penalty_awarded", "penalty_given", "penalty_kick", "spot_kick"}
    confirmation_tokens = {"penalty_confirmed", "confirmed_penalty"}
    result_tokens = {"penalty_scored", "penalty_saved", "penalty_missed", "penalty_failed", "penalty_cancelled"}
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


def opportunity_deadline_seconds(context: str) -> int | None:
    return {
        "penalties": None,
        "goal_next_10": GOAL_NEXT_10_SECONDS,
        "next_goal_team": None,
        "next_foul": None,
    }[context]


def opportunity_deadline_events(context: str) -> int | None:
    return {
        "penalties": None,
        "goal_next_10": 56,
        "next_goal_team": None,
        "next_foul": None,
    }[context]


def opportunity_options(context: str, participant1: str = "A", participant2: str = "B", team_label: str | None = None) -> list[OpportunityOption]:
    if context == "penalties":
        return [
            OpportunityOption("penalty_goal", "yes, penalty scored", "safe", 1.35, "goal"),
            OpportunityOption("penalty_no_goal", "no, missed or saved", "wild", 5.5, "no_goal", "any"),
        ]
    if context == "goal_next_10":
        return [
            OpportunityOption("goal_next_10_yes", "yes, goal in the next 10 min", "risky", 2.4, "goal", "any"),
            OpportunityOption("goal_next_10_no", "no goal in the next 10 min", "safe", 1.35, "no_goal", "any"),
        ]
    if context == "next_goal_team":
        return [
            OpportunityOption("next_goal_p1", f"{participant1} scores the next goal", "wild", 4.4, "goal", "participant1"),
            OpportunityOption("next_goal_p2", f"{participant2} scores the next goal", "wild", 4.4, "goal", "participant2"),
            OpportunityOption("next_goal_none", "no goal before full time", "safe", 1.35, "no_goal", "any"),
        ]
    if context == "next_foul":
        return [
            OpportunityOption("next_foul_p1", f"yes, {participant1} commits the next foul", "risky", 2.2, "foul", "participant1"),
            OpportunityOption("next_foul_p2", f"no, {participant2} commits the next foul", "risky", 2.2, "foul", "participant2"),
        ]
    return []


def opportunity_label(context: str, event: dict[str, Any], team_label: str | None) -> str:
    minute = f"{event.get('minute')}' - " if event.get("minute") is not None else ""
    team = f" for {team_label}" if context == "penalties" and team_label else ""
    labels = {
        "penalties": "Penalty: goal or no goal?",
        "goal_next_10": "Market: goal in the next 10 minutes?",
        "next_goal_team": "Market: who scores the next goal?",
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
        if colony.food < food_drain_for_colony(colony) * 2:
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


def ant_agent_context(ant: AntState, opportunity: Opportunity) -> dict[str, Any]:
    attempts = ant.memory.attempts_by_context.get(opportunity.context, 0)
    wins = ant.memory.wins_by_context.get(opportunity.context, 0)
    losses = ant.memory.losses_by_context.get(opportunity.context, 0)
    return {
        "antId": ant.ant_id,
        "archetype": ant.archetype,
        "objective": (
            "Help your colony win across the match: earn resources, avoid bad resource losses, "
            "take good multipliers when the risk is worth it, and learn from your own results."
        ),
        "personality": {
            "riskAppetite": round(ant.risk_appetite, 3),
            "favoriteContext": ant.favorite_context,
            "lossSensitivity": round(ant.loss_sensitivity, 3),
            "momentumBias": round(ant.momentum_bias, 3),
            "chaosBias": round(ant.chaos_bias, 3),
            "influence": round(ant.influence, 3),
        },
        "memory": {
            "context": opportunity.context,
            "attempts": attempts,
            "wins": wins,
            "losses": losses,
            "successRate": round(ant.memory.success_rate(opportunity.context), 3),
            "recentLosses": ant.memory.recent_losses,
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
        proposition = f"Who scores the next goal before full time: {participant1}, {participant2}, or no goal?"
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
            }
        )
    items.append(
        {
            "vote": "abstain",
            "meaning": "do not commit this ant to this market",
            "optionId": None,
            "risk": "none",
            "multiplier": 0,
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

    for ant in active_ants:
        decision = decision_by_ant_id.get(ant.ant_id)
        if not decision:
            vote_counts["abstain"] += 1
            neutral += 1
            continue

        vote = normalize_agent_vote(_ant_decision_value(decision, "vote", "vote", None))
        if not vote:
            vote = normalize_agent_vote(_ant_decision_value(decision, "choice", "choice", None))
        if vote not in vote_counts:
            vote = "abstain"
        vote_counts[vote] += 1
        option_id = _ant_decision_value(decision, "option_id", "optionId", vote_option_ids.get(vote))
        raw_action = _ant_decision_value(decision, "action", default=None)
        action = str(raw_action or ("predict" if option_id in predictions else "neutral"))
        reason = str(_ant_decision_value(decision, "reason", default="") or "").strip()
        if len(samples) < 8:
            samples.append(
                {
                    "antId": ant.ant_id,
                    "archetype": ant.archetype,
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
    food_pressure = 0.12 if colony.food < len(colony.alive_ants) * 0.35 else 0.0
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
    if opportunity.context in {"goal_next_10", "next_goal_team"}:
        score += ant.momentum_bias * 0.12
    if opportunity.context == "next_foul":
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
    if colony.food < info_cost_for_colony(colony, opportunity):
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
) -> Prediction | None:
    best_option = None
    best_votes: list[dict[str, Any]] = []
    if agent_decision and agent_decision.authoritative:
        if agent_decision.action == "observe":
            return None
        agent_option = next((option for option in opportunity.options if option.option_id == agent_decision.option_id), None)
        agent_votes = vote["predictions"].get(agent_option.option_id, []) if agent_option else []
        voted_option, voted_option_votes = top_voted_option(opportunity, vote)
        if agent_option and agent_votes:
            best_option = agent_option
            best_votes = agent_votes
        else:
            best_option = voted_option
            best_votes = voted_option_votes
    else:
        best_option, best_votes = top_voted_option(opportunity, vote)
    if not best_option or not best_votes:
        return None

    active_count = max(1, vote["activeCount"])
    if agent_decision and agent_decision.authoritative:
        support_fraction = len(best_votes) / active_count
        stake_fraction = min(clamp(agent_decision.stake_fraction, 0.02, 0.80), max(0.02, support_fraction))
        stake = max(1, int(round(active_count * stake_fraction)))
    else:
        threshold = {"cautious": 0.16, "balanced": 0.12, "aggressive": 0.09}[colony.style]
        if len(best_votes) / active_count < threshold:
            return None

        stake_factor = {"cautious": 0.42, "balanced": 0.58, "aggressive": 0.76}[colony.style]
        risk_boost = {"safe": 0.90, "risky": 0.80, "wild": 0.66, "chaos": 0.55}[best_option.risk]
        if colony.food < food_drain_for_colony(colony) * 2:
            stake_factor += 0.14
        stake = max(1, int(round(len(best_votes) * stake_factor * risk_boost)))
    stake = min(stake, len(best_votes))
    chosen_votes = sorted(best_votes, key=lambda item: item["weight"], reverse=True)[:stake]
    return Prediction(
        prediction_id=f"pred_{uuid.uuid4().hex[:10]}",
        colony_id=colony.colony_id,
        opportunity_id=opportunity.opportunity_id,
        option=best_option,
        ant_ids=[item["antId"] for item in chosen_votes],
        created_event_index=event_index,
        deadline_clock=opportunity.deadline_clock,
        deadline_event_index=opportunity.deadline_event_index,
        info_bought=bought_info,
    )


def top_voted_option(opportunity: Opportunity, vote: dict[str, Any]) -> tuple[OpportunityOption | None, list[dict[str, Any]]]:
    best_option = None
    best_votes: list[dict[str, Any]] = []
    for option in opportunity.options:
        votes = vote["predictions"].get(option.option_id, [])
        if sum(item["weight"] for item in votes) > sum(item["weight"] for item in best_votes):
            best_option = option
            best_votes = votes
    return best_option, best_votes


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
            target = "no_goal"
            label = "No goal before full time"
            option = outcome_option(opportunity, target)

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

    if opportunity.context == "next_foul":
        if "foul" in targets:
            return event_matches_team_scope(prediction.option.team_scope, event, opportunity)
        return None

    if prediction.option.target in targets:
        return True
    if targets.intersection({"goal", "miss", "saved", "cancel", "card", "yellow_card", "confirmed"}):
        return False
    return None


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
    if "corner" in flags or "free_kick" in flags or _event_has_text(event, "corner", "free_kick", "free kick"):
        targets.add("set_piece")
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
        predictions[option_id] = {"count": len(items), "weight": round(sum(item["weight"] for item in items), 2)}
    public = {
        "activeCount": vote["activeCount"],
        "neutralCount": vote["neutralCount"],
        "infoRequestCount": len(vote["infoRequests"]),
        "predictions": predictions,
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
        public["agentSamples"] = vote.get("agentSamples", [])
    return public


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
    best_option_id = None
    best_count = -1
    for option_id, items in vote["predictions"].items():
        if len(items) > best_count:
            best_option_id = option_id
            best_count = len(items)
    if best_option_id is None or best_count <= 0:
        return "no prediction"
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
