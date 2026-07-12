import asyncio
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.game.agents import AgentDecisionError, OpenRouterColonyAgent, OpenRouterSettings
from app.main import (
    app,
    _finish_live_game,
    _fetch_score_sources,
    _live_auto_finish_reached,
    _live_timeline_active,
    _live_timeline_finished,
    _merge_restored_events,
    _open_live_baseline_markets,
    _pick_live_target_fixture,
    _prime_live_catchup,
    _process_live_events,
    _replay_delay_after_event,
    _restore_room_from_stored_row,
    _stored_game_can_resume_live,
    _sync_live_match_state_from_timeline,
    game_manager,
)
from app.game.harness import (
    BASELINE_MARKET_CONTEXTS,
    GameHarness,
    GameManager,
    STARTING_COLONY_ANTS,
    STARTING_COLONY_FOOD,
    ant_bet_history,
    build_info_packet,
    build_opportunity,
    build_opportunities,
    create_prediction,
    food_drain_for_colony,
    info_cost_for_colony,
    run_vote,
    should_buy_info,
)


def penalty_event(**overrides):
    event = {
        "fixtureId": 42,
        "id": 1,
        "seq": 1,
        "action": "penalty",
        "highlights": ["penalty"],
        "minute": 63,
        "clockSeconds": 3780,
        "participant": 1,
        "participantLabel": "France",
        "possession": 1,
        "possessionLabel": "France",
        "confirmed": True,
        "score": {"participant1": 0, "participant2": 0},
        "description": "Penalty - 63' - France - confirmed",
        "details": ["Team: France", "Confirmed"],
    }
    event.update(overrides)
    return event


class FakeDeepSeekAntAgent:
    def __init__(self, vote="yes", usage: dict | None = None):
        self.vote = vote
        self.calls = []
        self.usage = usage or {
            "model": "deepseek/deepseek-v4-flash",
            "budgetedCalls": 0,
            "apiCalls": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "inputCostUsd": 0.0,
            "outputCostUsd": 0.0,
            "costUsd": 0.0,
            "costComplete": True,
            "missingUsageResponses": 0,
        }

    def decide(self, *, game_id, stage, context):
        return None

    def decide_ants(self, *, game_id, stage, context, ants):
        self.calls.append({"stage": stage, "context": context, "ants": ants})
        return [
            {
                "antId": ant["antId"],
                "vote": self.vote(ant, context) if callable(self.vote) else self.vote,
                "reason": f"{ant.get('archetype', 'ant')} test vote",
            }
            for ant in ants
        ]

    def usage_for_game(self, game_id):
        return self.usage


class GameHarnessTest(unittest.TestCase):
    def test_score_source_fetch_uses_successful_sources_when_one_fails(self):
        class PartialClient:
            async def score_historical(self, fixture_id):
                request = httpx.Request("GET", f"https://txline.test/historical/{fixture_id}")
                response = httpx.Response(404, request=request)
                raise httpx.HTTPStatusError("not found", request=request, response=response)

            async def score_updates(self, fixture_id):
                return [{"FixtureId": fixture_id, "Seq": 1, "Action": "corner"}]

            async def score_snapshot(self, fixture_id):
                return []

        sources = asyncio.run(_fetch_score_sources(PartialClient(), 42))

        self.assertEqual(sources["historical"], [])
        self.assertEqual(sources["updates"][0]["Action"], "corner")
        self.assertEqual(sources["snapshot"], [])

    def make_room(self):
        manager = GameManager()
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        return room, GameHarness(room)

    def test_penalty_event_creates_risk_reward_opportunity(self):
        opportunity = build_opportunity(penalty_event(), 1)

        self.assertIsNotNone(opportunity)
        self.assertEqual(opportunity.context, "penalties")
        self.assertIsNone(opportunity.deadline_clock)
        self.assertIsNone(opportunity.deadline_event_index)
        self.assertEqual(opportunity.info_cost, 3)
        labels = {option.label: option.multiplier for option in opportunity.options}
        self.assertEqual(labels["yes, penalty scored"], 1.35)
        self.assertEqual(labels["no, missed or saved"], 5.5)

    def test_unconfirmed_penalty_does_not_create_penalty_market(self):
        opportunity = build_opportunity(penalty_event(confirmed=False, description="Penalty - pending confirmation"), 1)

        self.assertIsNone(opportunity)

    def test_penalty_result_does_not_open_new_penalty_market(self):
        opportunity = build_opportunity(
            penalty_event(
                action="penalty_scored",
                highlights=["penalty"],
                description="Penalty scored",
                confirmed=True,
            ),
            1,
        )

        self.assertIsNone(opportunity)

    def test_confirmed_var_penalty_creates_penalty_market(self):
        opportunity = build_opportunity(
            penalty_event(
                action="var",
                highlights=["var"],
                description="VAR - penalty confirmed",
                details=["Confirmed"],
                confirmed=True,
            ),
            1,
        )

        self.assertIsNotNone(opportunity)
        self.assertEqual(opportunity.context, "penalties")

    def test_var_no_penalty_does_not_create_penalty_market(self):
        opportunity = build_opportunity(
            penalty_event(
                action="var",
                highlights=["var"],
                description="VAR - no penalty confirmed",
                details=["Confirmed"],
                confirmed=True,
            ),
            1,
        )

        self.assertIsNone(opportunity)

    def test_penalty_market_stays_unique_until_penalty_result(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="Brazil", participant2="Norway", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Penalty Watch", 20, "balanced", "penalties", "medium")

        harness.process_event(
            penalty_event(
                seq=1,
                minute=98,
                clockSeconds=5880,
                participant=2,
                participantLabel="Norway",
                possession=2,
                possessionLabel="Norway",
                description="Penalty - Norway - confirmed",
            )
        )
        first_penalty_opportunities = [
            opportunity
            for opportunity in room.opportunities.values()
            if opportunity.context == "penalties"
        ]
        self.assertEqual(len(first_penalty_opportunities), 1)
        first_penalty_id = first_penalty_opportunities[0].opportunity_id

        for seq, clock_seconds in [(2, 5940), (3, 5990)]:
            harness.process_event(
                {
                    "fixtureId": 42,
                    "seq": seq,
                    "action": "clock",
                    "highlights": [],
                    "minute": clock_seconds // 60,
                    "clockSeconds": clock_seconds,
                    "description": "Clock tick",
                }
            )

        harness.process_event(
            penalty_event(
                seq=4,
                action="penalty_confirmed",
                minute=100,
                clockSeconds=6000,
                participant=2,
                participantLabel="Norway",
                possession=2,
                possessionLabel="Norway",
                description="Penalty confirmed - Norway",
            )
        )
        penalty_opportunities = [
            opportunity
            for opportunity in room.opportunities.values()
            if opportunity.context == "penalties"
        ]
        penalty_opportunity_logs = [
            event
            for event in room.log
            if event.kind == "opportunity"
            and event.data.get("opportunity", {}).get("context") == "penalties"
        ]
        open_penalty_predictions = [
            prediction
            for prediction in room.predictions.values()
            if not prediction.resolved
            and room.opportunities[prediction.opportunity_id].context == "penalties"
        ]

        self.assertEqual([opportunity.opportunity_id for opportunity in penalty_opportunities], [first_penalty_id])
        self.assertEqual(len(penalty_opportunity_logs), 1)
        self.assertTrue(open_penalty_predictions)

        harness.process_event(
            penalty_event(
                seq=5,
                action="penalty_saved",
                minute=101,
                clockSeconds=6060,
                participant=2,
                participantLabel="Norway",
                possession=2,
                possessionLabel="Norway",
                description="Penalty saved - Norway",
            )
        )
        penalty_settlements = [
            event
            for event in room.log
            if event.kind == "settlement"
            and event.data.get("opportunityId") == first_penalty_id
        ]

        self.assertTrue(penalty_settlements)
        self.assertTrue(all(prediction.resolved for prediction in open_penalty_predictions))
        self.assertEqual(
            {(event.data.get("resolvedOutcome") or {}).get("label") for event in penalty_settlements},
            {"Norway penalty missed or saved"},
        )

    def test_cancelled_penalty_voids_market_without_reward_or_penalty(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("no"))
        room = manager.create_room(fixture_id=42, participant1="Brazil", participant2="Norway", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Penalty Void Watch", 20, "balanced", "penalties", "medium")

        harness.process_event(
            penalty_event(
                seq=1,
                minute=40,
                clockSeconds=2400,
                participant=2,
                participantLabel="Norway",
                possession=2,
                possessionLabel="Norway",
                description="Penalty - Norway - confirmed",
            )
        )
        open_penalty_predictions = [
            prediction
            for prediction in room.predictions.values()
            if not prediction.resolved
            and room.opportunities[prediction.opportunity_id].context == "penalties"
        ]
        self.assertTrue(open_penalty_predictions)

        harness.process_event(
            penalty_event(
                seq=2,
                action="penalty_cancelled",
                highlights=["penalty"],
                minute=41,
                clockSeconds=2460,
                participant=2,
                participantLabel="Norway",
                possession=2,
                possessionLabel="Norway",
                description="Penalty cancelled - Norway",
            )
        )

        self.assertTrue(all(prediction.resolved for prediction in open_penalty_predictions))
        self.assertEqual(colony.memory.wins, 0)
        self.assertEqual(colony.memory.losses, 0)
        self.assertFalse(
            [
                event
                for event in room.log
                if event.kind == "settlement"
                and event.data.get("opportunityId") in {prediction.opportunity_id for prediction in open_penalty_predictions}
            ]
        )
        self.assertTrue(
            [
                event
                for event in room.log
                if event.kind == "void"
                and event.data.get("reason") == "penalty_cancelled"
                and event.data.get("opportunityId") in {prediction.opportunity_id for prediction in open_penalty_predictions}
            ]
        )

    def test_pressure_event_creates_safe_precision_and_chaos_markets(self):
        room, _ = self.make_room()
        opportunities = build_opportunities(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            1,
            room.match_state,
        )

        self.assertEqual([opportunity.context for opportunity in opportunities], list(BASELINE_MARKET_CONTEXTS))
        goal_market = opportunities[0]
        precision_market = opportunities[1]
        corner_market = opportunities[2]
        free_kick_market = opportunities[3]
        yellow_card_market = opportunities[4]
        self.assertEqual([option.option_id for option in goal_market.options], [
            "goal_next_10_yes",
            "goal_next_10_no",
        ])
        self.assertEqual(goal_market.options[0].label, "yes, goal in the next 10 min")
        self.assertEqual(goal_market.options[1].label, "no goal in the next 10 min")
        self.assertEqual([option.option_id for option in precision_market.options], [
            "next_goal_p1",
            "next_goal_p2",
            "next_goal_none",
        ])
        self.assertEqual(precision_market.options[0].label, "France scores the next goal")
        self.assertEqual(precision_market.options[1].label, "Belgium scores the next goal")
        self.assertEqual(precision_market.options[2].label, "no goal before full time")
        self.assertEqual([option.option_id for option in corner_market.options], [
            "next_corner_p1",
            "next_corner_p2",
            "next_corner_none",
        ])
        self.assertEqual(corner_market.options[0].label, "France wins the next corner")
        self.assertEqual(corner_market.options[1].label, "Belgium wins the next corner")
        self.assertEqual(corner_market.options[2].label, "no corner before full time")
        self.assertEqual([option.option_id for option in free_kick_market.options], [
            "next_free_kick_p1",
            "next_free_kick_p2",
            "next_free_kick_none",
        ])
        self.assertEqual(free_kick_market.options[0].label, "France wins the next free kick")
        self.assertEqual(free_kick_market.options[1].label, "Belgium wins the next free kick")
        self.assertEqual(free_kick_market.options[2].label, "no free kick before full time")
        self.assertEqual([option.option_id for option in yellow_card_market.options], [
            "next_yellow_card_p1",
            "next_yellow_card_p2",
            "next_yellow_card_none",
        ])
        self.assertEqual(yellow_card_market.options[0].label, "France gets the next yellow card")
        self.assertEqual(yellow_card_market.options[1].label, "Belgium gets the next yellow card")
        self.assertEqual(yellow_card_market.options[2].label, "no yellow card before full time")

    def test_penalty_area_pressure_does_not_create_penalty_market(self):
        room, _ = self.make_room()
        opportunities = build_opportunities(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "attack_possession",
                "highlights": ["penalty"],
                "minute": 11,
                "clockSeconds": 660,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "possessionType": "Penalty area",
                "description": "France attacks inside the penalty area",
            },
            1,
            room.match_state,
        )

        self.assertEqual([opportunity.context for opportunity in opportunities], list(BASELINE_MARKET_CONTEXTS))

    def test_user_config_creates_diverse_ant_distribution(self):
        _, harness = self.make_room()
        colony = harness.add_colony(
            name="Careful Nest",
            size=50,
            style="cautious",
            favorite_context="penalties",
            info_need="high",
        )

        archetypes = {ant.archetype for ant in colony.ants}

        self.assertEqual(colony.size, STARTING_COLONY_ANTS)
        self.assertEqual(colony.food, STARTING_COLONY_FOOD)
        self.assertEqual(len(colony.ants), STARTING_COLONY_ANTS)
        self.assertEqual(colony.ants[0].ant_id, "ant_0000")
        self.assertEqual(colony.ants[-1].ant_id, "ant_0019")
        self.assertTrue(all(not ant.ant_id.startswith(colony.colony_id) for ant in colony.ants))
        self.assertIn("cautious", archetypes)
        self.assertIn("data_first", archetypes)
        self.assertGreater(len(archetypes), 3)
        self.assertTrue(any(ant.risk_appetite > 0.55 for ant in colony.ants))

    def test_open_bets_do_not_block_future_votes(self):
        _, harness = self.make_room()
        colony = harness.add_colony(
            name="Risk Nest",
            size=10,
            style="balanced",
            favorite_context="momentum",
            info_need="medium",
        )
        colony.ants[0].engaged_prediction_ids.add("pred_open")
        colony.ants[1].wounded_until_event = 2
        colony.ants[2].alive = False

        active_ids = [ant.ant_id for ant in colony.active_ants(1)]
        public = colony.public_state(1)

        self.assertIn("ant_0000", active_ids)
        self.assertNotIn("ant_0001", active_ids)
        self.assertNotIn("ant_0002", active_ids)
        self.assertEqual(public["antsAlive"], STARTING_COLONY_ANTS - 1)
        self.assertEqual(public["antsActive"], STARTING_COLONY_ANTS - 2)
        self.assertEqual(public["antsEngaged"], 0)
        self.assertEqual(public["antsWounded"], 1)

    def test_same_ant_can_vote_on_multiple_markets(self):
        def first_available_vote(_ant, context):
            return context["market"]["availableVotes"][0]["vote"]

        manager = GameManager(decision_agent=FakeDeepSeekAntAgent(first_available_vote))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Multi Market Nest", 20, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )

        predictions = [prediction for prediction in room.predictions.values() if prediction.colony_id == colony.colony_id]
        self.assertGreaterEqual(len(predictions), 2)
        ant_usage = Counter(ant_id for prediction in predictions for ant_id in prediction.ant_ids)
        self.assertTrue(any(count > 1 for count in ant_usage.values()))
        self.assertEqual(colony.public_state(room.event_index)["antsEngaged"], 0)

    def test_legacy_french_config_values_are_normalized(self):
        _, harness = self.make_room()
        colony = harness.add_colony(
            name="Legacy Nest",
            size=10,
            style="equilibre",
            favorite_context="equilibre",
            info_need="moyen",
        )

        self.assertEqual(colony.style, "balanced")
        self.assertEqual(colony.favorite_context, "balanced")
        self.assertEqual(colony.info_need, "medium")

    def test_room_players_and_strategy_updates_are_public(self):
        room, harness = self.make_room()
        player = harness.join_player(" Tanguy ")
        colony = harness.add_colony("Lobby Nest", 20, "balanced", "momentum", "medium")

        harness.update_colony_strategy(
            colony.colony_id,
            style="aggressive",
            favorite_context="chaos",
            info_need="low",
        )
        public = room.public_state()

        self.assertEqual(public["players"], [{"playerId": player.player_id, "name": "Tanguy"}])
        self.assertEqual(public["colonies"][0]["style"], "aggressive")
        self.assertEqual(public["colonies"][0]["favoriteContext"], "chaos")
        self.assertEqual(public["colonies"][0]["infoNeed"], "low")
        self.assertTrue(any(event.kind == "player_joined" for event in room.log))
        self.assertTrue(any(event.kind == "strategy_updated" for event in room.log))

    def test_colony_strategy_can_change_live_but_not_after_finish(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Live Orders", 20, "balanced", "momentum", "medium")
        room.status = "running_live"

        harness.update_colony_strategy(
            colony.colony_id,
            style="aggressive",
            favorite_context="chaos",
            info_need="low",
        )

        self.assertEqual(colony.style, "aggressive")
        self.assertEqual(colony.favorite_context, "chaos")
        self.assertEqual(colony.info_need, "low")
        self.assertEqual(colony.strategy_revision, 1)
        self.assertEqual(room.log[-1].data["strategyRevision"], 1)

        room.status = "finished"
        with self.assertRaisesRegex(ValueError, "before or during a match"):
            harness.update_colony_strategy(colony.colony_id, style="cautious")

        self.assertEqual(colony.style, "aggressive")
        self.assertEqual(colony.strategy_revision, 1)

    def test_ant_strategy_override_and_inherit_reach_agent_payload(self):
        agent = FakeDeepSeekAntAgent("yes")
        manager = GameManager(decision_agent=agent)
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Directed Ants", 20, "balanced", "momentum", "medium")
        room.status = "running_live"
        ant = colony.ants[0]

        harness.update_ant_strategy(
            colony.colony_id,
            ant.ant_id,
            style="aggressive",
            favorite_context="chaos",
            info_need="low",
        )
        harness.process_event(penalty_event())

        first_call = agent.calls[0]
        first_ant = next(item for item in first_call["ants"] if item["antId"] == ant.ant_id)
        inherited_ant = next(item for item in first_call["ants"] if item["antId"] == colony.ants[1].ant_id)
        self.assertEqual(
            first_ant["strategy"],
            {
                "style": "aggressive",
                "favoriteContext": "chaos",
                "infoNeed": "low",
                "inheritsGlobal": False,
                "source": "custom",
            },
        )
        self.assertEqual(inherited_ant["strategy"]["style"], "balanced")
        self.assertTrue(inherited_ant["strategy"]["inheritsGlobal"])
        self.assertEqual(first_call["context"]["colony"]["strategyRevision"], 1)

        harness.update_ant_strategy(colony.colony_id, ant.ant_id, inherit_global=True)
        harness.process_event(
            penalty_event(
                id=2,
                seq=2,
                minute=64,
                participant=2,
                participantLabel="Belgium",
                possession=2,
                possessionLabel="Belgium",
                description="Penalty - 64' - Belgium - confirmed",
            )
        )

        second_call = agent.calls[-1]
        second_ant = next(item for item in second_call["ants"] if item["antId"] == ant.ant_id)
        self.assertEqual(second_ant["strategy"]["style"], "balanced")
        self.assertEqual(second_ant["strategy"]["favoriteContext"], "momentum")
        self.assertEqual(second_ant["strategy"]["infoNeed"], "medium")
        self.assertTrue(second_ant["strategy"]["inheritsGlobal"])
        self.assertEqual(second_call["context"]["colony"]["strategyRevision"], 2)
        self.assertNotIn(ant.ant_id, colony.public_state(room.event_index)["antStrategies"])

    def test_dead_ant_cannot_receive_new_strategy_orders(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Silent Nest", 20, "balanced", "momentum", "medium")
        room.status = "running_live"
        ant = colony.ants[0]
        ant.alive = False

        with self.assertRaisesRegex(ValueError, "dead ants"):
            harness.update_ant_strategy(colony.colony_id, ant.ant_id, style="aggressive")

        self.assertEqual(colony.strategy_revision, 0)

    def test_restored_event_log_merges_supabase_events_once(self):
        room, _ = self.make_room()
        room.log.clear()

        _merge_restored_events(
            room,
            [
                {"index": 1, "kind": "game_started", "message": "Started", "data": {"mode": "live"}, "createdAt": 10},
                {"index": 0, "kind": "game_created", "message": "Created", "data": {"roomCode": room.room_code}},
                {"index": 1, "kind": "game_started", "message": "Duplicate", "data": {}},
            ],
        )
        room.add_log("live_sync", "Next live update.")

        self.assertEqual([event.index for event in room.log], [0, 1, 2])
        self.assertEqual(room.log[1].message, "Started")
        self.assertEqual(room.log[2].kind, "live_sync")

    def test_ant_bet_history_survives_restored_event_log(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Archive Nest", 20, "balanced", "momentum", "medium")
        ant_id = colony.ants[0].ant_id
        room.log.clear()
        _merge_restored_events(
            room,
            [
                {
                    "index": 0,
                    "kind": "prediction",
                    "message": "Archive Nest backs France.",
                    "createdAt": 100,
                    "data": {
                        "colonyId": colony.colony_id,
                        "predictionId": "pred_archive",
                        "opportunityId": "opp_archive",
                        "antIds": [ant_id],
                        "ants": 1,
                        "foodReserved": 2,
                        "option": {"option_id": "yes", "label": "France scores", "risk": "risky", "multiplier": 4},
                        "market": {"opportunityId": "opp_archive", "label": "Next goal", "context": "next_goal_team", "minute": 70},
                        "strategyRevision": 3,
                        "antStrategies": {
                            ant_id: {
                                "style": "aggressive",
                                "favoriteContext": "momentum",
                                "infoNeed": "low",
                                "inheritsGlobal": False,
                                "source": "custom",
                            }
                        },
                    },
                },
                {
                    "index": 1,
                    "kind": "void",
                    "message": "Prediction voided.",
                    "createdAt": 110,
                    "data": {
                        "colonyId": colony.colony_id,
                        "predictionId": "pred_archive",
                        "opportunityId": "opp_archive",
                        "antIds": [ant_id],
                        "reason": "full_time",
                    },
                },
            ],
        )

        history = ant_bet_history(room, colony.colony_id, ant_id)

        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["status"], "void")
        self.assertEqual(history[0]["marketLabel"], "Next goal")
        self.assertEqual(history[0]["strategy"]["style"], "aggressive")
        self.assertEqual(history[0]["resolvedAt"], 110)

    def test_anonymous_owner_and_player_identity_are_public(self):
        manager = GameManager()
        room = manager.create_room(
            fixture_id=42,
            participant1="France",
            participant2="Belgium",
            seed=123,
            owner_anonymous_id="anon_browser_1",
            owner_name="Tanguy",
        )
        player = manager.harness(room.game_id).join_player("Tanguy", anonymous_id="anon_browser_1")

        public = room.public_state()

        self.assertEqual(len(public["roomCode"]), 6)
        self.assertTrue(public["roomCode"].isdigit())
        self.assertEqual(public["owner"], {"anonymousId": "anon_browser_1", "name": "Tanguy"})
        self.assertEqual(
            public["players"],
            [{"playerId": player.player_id, "name": "Tanguy", "anonymousId": "anon_browser_1", "isHost": True}],
        )

    def test_rooms_get_private_six_digit_codes(self):
        manager = GameManager()
        first = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium")
        second = manager.create_room(fixture_id=43, participant1="USA", participant2="Japan")

        self.assertEqual(len(first.room_code), 6)
        self.assertTrue(first.room_code.isdigit())
        self.assertNotEqual(first.room_code, second.room_code)
        self.assertIs(manager.get_room_by_code(first.room_code), first)

    def test_join_player_reuses_anonymous_identity(self):
        manager = GameManager()
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium")
        harness = manager.harness(room.game_id)

        first = harness.join_player("Tanguy", anonymous_id="anon_browser_1")
        second = harness.join_player("Tanguy v2", anonymous_id="anon_browser_1")

        self.assertEqual(first.player_id, second.player_id)
        self.assertEqual(len(room.players), 1)
        self.assertEqual(room.players[0].name, "Tanguy v2")

    def test_info_high_colony_buys_one_shared_info_packet(self):
        room, harness = self.make_room()
        colony = harness.add_colony(
            name="Data Nest",
            size=50,
            style="cautious",
            favorite_context="penalties",
            info_need="high",
        )
        opportunity = build_opportunity(penalty_event(player={"name": "Mbappe"}), 1)

        vote = run_vote(colony, opportunity, room.event_index)

        self.assertTrue(should_buy_info(colony, opportunity, vote))
        packet = build_info_packet(opportunity, colony, room.match_state)
        self.assertEqual(packet.cost, 3)
        self.assertIn("involved player: Mbappe", packet.facts)
        opportunity.info_bought_by.add(colony.colony_id)
        self.assertFalse(should_buy_info(colony, opportunity, vote))

    def test_info_cost_is_same_for_every_starting_colony(self):
        _, harness = self.make_room()
        opportunity = build_opportunity(penalty_event(player={"name": "Mbappe"}), 1)
        small = harness.add_colony("Small", 10, "cautious", "penalties", "high")
        medium = harness.add_colony("Medium", 20, "cautious", "penalties", "high")
        large = harness.add_colony("Large", 50, "cautious", "penalties", "high")

        self.assertEqual(small.size, STARTING_COLONY_ANTS)
        self.assertEqual(medium.size, STARTING_COLONY_ANTS)
        self.assertEqual(large.size, STARTING_COLONY_ANTS)
        self.assertEqual(small.food, STARTING_COLONY_FOOD)
        self.assertEqual(medium.food, STARTING_COLONY_FOOD)
        self.assertEqual(large.food, STARTING_COLONY_FOOD)
        self.assertEqual(info_cost_for_colony(small, opportunity), 3)
        self.assertEqual(info_cost_for_colony(medium, opportunity), 3)
        self.assertEqual(info_cost_for_colony(large, opportunity), 3)

    def test_colony_style_changes_default_stake_size(self):
        room, harness = self.make_room()
        opportunity = build_opportunity(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            1,
            room.match_state,
        )
        cautious = harness.add_colony("Careful", 50, "cautious", "momentum", "medium")
        aggressive = harness.add_colony("Bold", 50, "aggressive", "momentum", "medium")

        def vote_for(colony):
            votes = [{"antId": ant.ant_id, "vote": "yes", "weight": 1.0} for ant in colony.active_ants(1)[:20]]
            return {
                "activeCount": STARTING_COLONY_ANTS,
                "predictions": {
                    "goal_next_10_yes": votes,
                    "goal_next_10_no": [],
                },
                "infoRequests": [],
            }

        cautious_prediction = create_prediction(cautious, opportunity, vote_for(cautious), 1, bought_info=False)
        aggressive_prediction = create_prediction(aggressive, opportunity, vote_for(aggressive), 1, bought_info=False)

        self.assertIsNotNone(cautious_prediction)
        self.assertIsNotNone(aggressive_prediction)
        self.assertLess(len(cautious_prediction.ant_ids), len(aggressive_prediction.ant_ids))

    def test_food_drain_uses_alive_ants_not_starting_size(self):
        _, harness = self.make_room()
        colony = harness.add_colony("Large", 50, "aggressive", "chaos", "low")
        for ant in colony.ants[:10]:
            ant.alive = False

        self.assertEqual(len(colony.alive_ants), 10)
        self.assertEqual(food_drain_for_colony(colony), 1)

    def test_late_join_does_not_pay_retroactive_upkeep(self):
        manager = GameManager()
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        room.status = "running_live"
        room.event_index = 600
        harness = manager.harness(room.game_id)

        colony = harness.add_colony("Late Nest", 20, "balanced", "momentum", "medium")

        self.assertEqual(colony.last_food_event_index, 600)
        self.assertEqual(colony.food, STARTING_COLONY_FOOD)
        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 601,
                "action": "clock_tick",
                "minute": 80,
                "clockSeconds": 4800,
                "description": "Clock tick",
            }
        )

        self.assertEqual(colony.food, STARTING_COLONY_FOOD)
        self.assertEqual(len(colony.alive_ants), STARTING_COLONY_ANTS)
        self.assertEqual(colony.last_food_event_index, 600)

    def test_zero_food_colony_cannot_create_prediction(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Empty Nest", 20, "aggressive", "momentum", "low")
        colony.food = 0
        opportunity = build_opportunity(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            1,
            room.match_state,
        )
        votes = [{"antId": ant.ant_id, "vote": "yes", "weight": 1.0} for ant in colony.active_ants(1)]
        vote = {
            "activeCount": len(votes),
            "predictions": {
                opportunity.options[0].option_id: votes,
                opportunity.options[1].option_id: [],
            },
            "infoRequests": [],
        }

        prediction = create_prediction(colony, opportunity, vote, 1, bought_info=False)

        self.assertIsNone(prediction)
        self.assertEqual(colony.food, 0)

    def test_open_prediction_reserves_food_and_blocks_duplicate_exposure(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Collateral Nest", 20, "aggressive", "chaos", "low")
        colony.food = 6
        opportunity = build_opportunity(penalty_event(), 1, room.match_state)
        risky_option = opportunity.options[1]
        risky_votes = [{"antId": ant.ant_id, "weight": 1.0} for ant in colony.active_ants(1)]
        vote = {
            "activeCount": len(risky_votes),
            "predictions": {
                opportunity.options[0].option_id: [],
                risky_option.option_id: risky_votes,
            },
            "infoRequests": [],
        }

        first = create_prediction(colony, opportunity, vote, 1, bought_info=False)
        second = create_prediction(colony, opportunity, vote, 1, bought_info=False)

        self.assertIsNotNone(first)
        self.assertEqual(first.reserved_food, 6)
        self.assertEqual(colony.food_reserved, 6)
        self.assertIsNone(second)
        self.assertEqual(colony.public_state(1)["economy"]["available"], 0)

        room.predictions[first.prediction_id] = first
        room.opportunities[opportunity.opportunity_id] = opportunity
        harness._void_prediction(first, opportunity, reason="test")
        self.assertEqual(colony.food_reserved, 0)
        self.assertEqual(colony.public_state(1)["economy"]["available"], 6)

    def test_rally_and_recall_reconcile_collateral_and_ant_history(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Tactics Nest", 20, "balanced", "penalties", "medium")
        room.status = "running_live"
        opportunity = build_opportunity(penalty_event(), 1, room.match_state)
        safe_option = opportunity.options[0]
        lead_ant = colony.ants[0]
        vote = {
            "activeCount": 1,
            "predictions": {
                safe_option.option_id: [{"antId": lead_ant.ant_id, "weight": 1.0}],
                opportunity.options[1].option_id: [],
            },
            "infoRequests": [],
        }
        prediction = create_prediction(colony, opportunity, vote, 1, bought_info=False)
        self.assertIsNotNone(prediction)
        room.predictions[prediction.prediction_id] = prediction
        room.opportunities[opportunity.opportunity_id] = opportunity
        room.add_log(
            "prediction",
            "Tactics Nest opens a position.",
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "antIds": list(prediction.ant_ids),
                "ants": len(prediction.ant_ids),
                "option": prediction.option.__dict__,
                "market": opportunity.public_state(),
                "foodReserved": prediction.reserved_food,
            },
        )

        added = harness.rally(colony.colony_id, opportunity.opportunity_id)
        rally_event = room.log[-1]
        rallied_ant_id = rally_event.data["antIdsAdded"][0]

        self.assertEqual(added, 5)
        self.assertEqual(prediction.reserved_food, 6)
        self.assertEqual(colony.food_reserved, 6)
        self.assertEqual(colony.food, 17)
        self.assertEqual(colony.memory.food_net, -3)
        self.assertLessEqual(colony.food_reserved, colony.food)

        removed = harness.recall(colony.colony_id, opportunity.opportunity_id)

        self.assertEqual(removed, 5)
        self.assertEqual(room.log[-1].data["antIdsRemoved"], rally_event.data["antIdsAdded"])
        self.assertEqual(prediction.reserved_food, 1)
        self.assertEqual(colony.food_reserved, 1)
        self.assertEqual(colony.public_state(1)["economy"]["available"], 16)
        recalled_history = ant_bet_history(room, colony.colony_id, rallied_ant_id)
        self.assertEqual(len(recalled_history), 1)
        self.assertEqual(recalled_history[0]["status"], "recalled")
        self.assertEqual(recalled_history[0]["resolutionReason"], "recalled")
        self.assertEqual(recalled_history[0]["decisionReason"], "Joined through a live rally.")
        self.assertIsNotNone(recalled_history[0]["strategy"])

    def test_switch_reprices_collateral_and_settles_the_new_option(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Pivot Nest", 20, "balanced", "penalties", "medium")
        colony.food = 4
        room.status = "running_live"
        opportunity = build_opportunity(penalty_event(), 1, room.match_state)
        safe_option, wild_option = opportunity.options
        ant = colony.ants[0]
        vote = {
            "activeCount": 1,
            "predictions": {
                safe_option.option_id: [{"antId": ant.ant_id, "weight": 1.0}],
                wild_option.option_id: [],
            },
            "infoRequests": [],
        }
        prediction = create_prediction(colony, opportunity, vote, 1, bought_info=False)
        self.assertIsNotNone(prediction)
        room.predictions[prediction.prediction_id] = prediction
        room.opportunities[opportunity.opportunity_id] = opportunity
        room.add_log(
            "prediction",
            "Pivot Nest opens a position.",
            {
                "colonyId": colony.colony_id,
                "predictionId": prediction.prediction_id,
                "opportunityId": opportunity.opportunity_id,
                "antIds": list(prediction.ant_ids),
                "ants": len(prediction.ant_ids),
                "option": prediction.option.__dict__,
                "market": opportunity.public_state(),
                "foodReserved": prediction.reserved_food,
            },
        )

        with self.assertRaisesRegex(ValueError, "cover the new risk"):
            harness.switch_call(colony.colony_id, opportunity.opportunity_id, wild_option.option_id)
        self.assertEqual(colony.food, 4)
        self.assertEqual(colony.food_reserved, 1)

        colony.food = 5
        harness.switch_call(colony.colony_id, opportunity.opportunity_id, wild_option.option_id)

        self.assertEqual(prediction.option.option_id, wild_option.option_id)
        self.assertEqual(prediction.reserved_food, 3)
        self.assertEqual(colony.food_reserved, 3)
        self.assertEqual(colony.food, 3)
        self.assertEqual(colony.memory.food_net, -2)
        self.assertEqual(room.log[-1].data["foodReservedDelta"], 2)
        self.assertLessEqual(colony.food_reserved, colony.food)

        harness._apply_settlement(prediction, opportunity, win=False, reason="test")
        history = ant_bet_history(room, colony.colony_id, ant.ant_id)

        self.assertEqual(colony.food, 0)
        self.assertEqual(colony.food_reserved, 0)
        self.assertEqual(colony.memory.food_net, -5)
        self.assertEqual(history[0]["status"], "lost")
        self.assertEqual(history[0]["optionId"], wild_option.option_id)
        self.assertEqual(history[0]["foodAtRisk"], 3.0)
        self.assertEqual(history[0]["colonyFoodDelta"], -3.0)

    def test_public_economy_matches_upkeep_state(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Economy Nest", 20, "balanced", "momentum", "medium")
        initial = colony.public_state(room.event_index)["economy"]

        self.assertEqual(
            initial,
            {
                "currency": "food",
                "balance": STARTING_COLONY_FOOD,
                "reserved": 0,
                "available": STARTING_COLONY_FOOD,
                "net": 0,
                "upkeepCost": 1,
                "upkeepEveryEvents": 24,
                "nextUpkeepInEvents": 24,
                "lastUpkeepEventIndex": 0,
                "runwayUpkeeps": STARTING_COLONY_FOOD,
                "status": "stable",
            },
        )

        room.event_index = 23
        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 24,
                "action": "clock_tick",
                "minute": 12,
                "clockSeconds": 720,
                "description": "Clock tick",
            }
        )
        public = colony.public_state(room.event_index)

        self.assertEqual(colony.food, STARTING_COLONY_FOOD - 1)
        self.assertEqual(colony.memory.food_net, -1)
        self.assertEqual(public["food"], colony.food)
        self.assertEqual(public["foodNet"], colony.memory.food_net)
        self.assertEqual(public["economy"]["balance"], colony.food)
        self.assertEqual(public["economy"]["net"], colony.memory.food_net)
        self.assertEqual(public["economy"]["lastUpkeepEventIndex"], 24)
        self.assertEqual(public["economy"]["nextUpkeepInEvents"], 24)
        self.assertEqual(public["economy"]["runwayUpkeeps"], colony.food)

    def test_restored_room_keeps_economy_population_and_ant_strategy(self):
        game_id = "game_restore_economy_test"
        room_code = "991234"
        game_manager.rooms.pop(game_id, None)
        game_manager.room_codes.pop(room_code, None)
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "fixtureId": 42,
            "participant1": "France",
            "participant2": "Belgium",
            "status": "running_live",
            "mode": "live",
            "eventIndex": 48,
            "players": [],
            "colonies": [
                {
                    "colonyId": "col_restore",
                    "name": "Restored Nest",
                    "simulationSeed": 98765,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "strategyRevision": 2,
                    "food": 18,
                    "foodNet": -2,
                    "larvae": 3,
                    "antsAlive": 12,
                    "wins": 2,
                    "losses": 1,
                    "infoPurchases": 1,
                    "economy": {"net": -2, "lastUpkeepEventIndex": 48},
                    "antStrategies": {
                        "ant_0000": {
                            "style": "aggressive",
                            "favoriteContext": "chaos",
                            "infoNeed": "low",
                        }
                    },
                }
            ],
        }

        room = _restore_room_from_stored_row(
            {"game_id": game_id, "seed": 123, "public_state": public_state},
            events=[],
        )
        colony = room.colonies["col_restore"]

        self.assertEqual(room.event_index, 48)
        self.assertEqual(colony.food, 18)
        self.assertEqual(colony.seed, 98765)
        self.assertEqual(colony.memory.food_net, -2)
        self.assertEqual(colony.last_food_event_index, 48)
        self.assertEqual(len(colony.alive_ants), 12)
        self.assertEqual(colony.public_state(room.event_index)["larvae"], 3)
        self.assertEqual(colony.memory.accuracy, 2 / 3)
        self.assertEqual(colony.memory.info_purchases, 1)
        self.assertEqual(colony.strategy_revision, 2)
        self.assertEqual(colony.ants[0].style_override, "aggressive")
        self.assertEqual(colony.ants[0].favorite_context_override, "chaos")
        self.assertEqual(colony.ants[0].info_need_override, "low")

        game_manager.harness(game_id).process_event(
            {
                "fixtureId": 42,
                "seq": 49,
                "action": "clock_tick",
                "minute": 25,
                "clockSeconds": 1500,
                "description": "Clock tick",
            }
        )

        self.assertEqual(colony.food, 18)
        self.assertEqual(colony.last_food_event_index, 48)

    def test_late_pressure_event_can_create_goal_next_ten_market_for_stoppage_time(self):
        room, _ = self.make_room()
        opportunity = build_opportunity(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "minute": 89,
                "clockSeconds": 5340,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            1,
            room.match_state,
        )

        self.assertIsNotNone(opportunity)
        self.assertEqual(opportunity.context, "goal_next_10")
        self.assertEqual(opportunity.deadline_clock, 5940)

    def test_next_event_markets_have_no_deadline(self):
        room, _ = self.make_room()
        opportunities = build_opportunities(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "minute": 75,
                "clockSeconds": 4500,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            1,
            room.match_state,
        )
        goal_opportunity = next(opportunity for opportunity in opportunities if opportunity.context == "next_goal_team")
        corner_opportunity = next(opportunity for opportunity in opportunities if opportunity.context == "next_corner")
        free_kick_opportunity = next(opportunity for opportunity in opportunities if opportunity.context == "next_free_kick")
        yellow_card_opportunity = next(opportunity for opportunity in opportunities if opportunity.context == "next_yellow_card")

        self.assertIsNone(goal_opportunity.deadline_clock)
        self.assertIsNone(goal_opportunity.deadline_event_index)
        self.assertIsNone(corner_opportunity.deadline_clock)
        self.assertIsNone(corner_opportunity.deadline_event_index)
        self.assertIsNone(free_kick_opportunity.deadline_clock)
        self.assertIsNone(free_kick_opportunity.deadline_event_index)
        self.assertIsNone(yellow_card_opportunity.deadline_clock)
        self.assertIsNone(yellow_card_opportunity.deadline_event_index)

    def test_precision_market_resolves_on_next_goal_team(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_b"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Precision Nest", 20, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 60,
                "clockSeconds": 3600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        precision_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_goal_p2"
        ]
        self.assertTrue(precision_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 63,
                "clockSeconds": 3780,
                "participant": 2,
                "participantLabel": "Belgium",
                "score": {"participant1": 0, "participant2": 1},
                "confirmed": True,
                "description": "Goal - Belgium - confirmed",
            }
        )

        self.assertTrue(precision_predictions[0].resolved)
        self.assertGreaterEqual(colony.memory.wins, 1)
        self.assertTrue(any(event.kind == "settlement" and event.data.get("win") for event in room.log))
        self.assertTrue(
            any(
                event.kind == "settlement"
                and event.data.get("resolvedOutcome", {}).get("label") == "Belgium scored"
                for event in room.log
            )
        )

    def test_next_goal_losing_colony_still_records_actual_outcome(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_c"))
        room = manager.create_room(fixture_id=42, participant1="Brazil", participant2="Norway", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Outcome Watch", 20, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 87,
                "clockSeconds": 5220,
                "participant": 1,
                "participantLabel": "Brazil",
                "possession": 1,
                "possessionLabel": "Brazil",
                "description": "High danger possession - Brazil",
            }
        )
        no_goal_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_goal_none"
        ]
        self.assertTrue(no_goal_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 88,
                "clockSeconds": 5280,
                "participant": 2,
                "participantLabel": "Norway",
                "score": {"participant1": 0, "participant2": 1},
                "confirmed": True,
                "description": "Goal - Norway - confirmed",
            }
        )
        settlement_events = [
            event
            for event in room.log
            if event.kind == "settlement"
            and event.data.get("opportunityId") in {prediction.opportunity_id for prediction in no_goal_predictions}
        ]

        self.assertTrue(settlement_events)
        self.assertTrue(all(not event.data.get("win") for event in settlement_events))
        self.assertEqual({event.data.get("resolvedOutcome", {}).get("label") for event in settlement_events}, {"Norway scored"})

    def test_next_goal_market_waits_until_full_time_without_goal(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_c"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Full Time Watch", 20, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 75,
                "clockSeconds": 4500,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        no_goal_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_goal_none"
        ]
        self.assertTrue(no_goal_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "clock",
                "highlights": [],
                "minute": 86,
                "clockSeconds": 5160,
                "description": "Clock tick",
            }
        )

        self.assertTrue(all(not prediction.resolved for prediction in no_goal_predictions))

        harness.finish_game()

        self.assertTrue(all(prediction.resolved for prediction in no_goal_predictions))
        self.assertTrue(
            [
                event
                for event in room.log
                if event.kind == "settlement"
                and event.data.get("reason") == "full_time"
                and event.data.get("win")
                and event.data.get("resolvedOutcome", {}).get("label") == "No goal before full time"
                and event.data.get("opportunityId") in {prediction.opportunity_id for prediction in no_goal_predictions}
            ]
        )

    def test_overturned_goal_does_not_resolve_goal_market(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="Brazil", participant2="Norway", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("VAR Nest", 20, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 1,
                "clockSeconds": 60,
                "participant": 2,
                "participantLabel": "Norway",
                "possession": 2,
                "possessionLabel": "Norway",
                "description": "High danger possession - Norway",
            }
        )
        goal_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "goal_next_10_yes"
        ]
        self.assertTrue(goal_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "var",
                "type": "Goal",
                "highlights": ["goal", "var"],
                "minute": 4,
                "clockSeconds": 186,
                "confirmed": True,
                "score": {"participant1": None, "participant2": None},
                "description": "VAR - checking possible goal",
            }
        )
        self.assertFalse(goal_predictions[0].resolved)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 3,
                "action": "var_end",
                "outcome": "Overturned",
                "highlights": ["goal", "var"],
                "minute": 4,
                "clockSeconds": 207,
                "confirmed": True,
                "description": "VAR - goal overturned",
            }
        )

        self.assertFalse(goal_predictions[0].resolved)
        self.assertFalse([event for event in room.log if event.kind == "settlement"])

    def test_match_state_merges_partial_score_updates(self):
        room, _ = self.make_room()

        room.match_state.update({"score": {"participant1": None, "participant2": 1}})
        room.match_state.update({"score": {"participant1": 1, "participant2": None}})

        self.assertEqual(room.match_state.score, {"participant1": 1, "participant2": 1})

    def test_next_free_kick_market_resolves_on_first_free_kick_team(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_b"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Free Kick Nest", 20, "balanced", "chaos", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 60,
                "clockSeconds": 3600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        free_kick_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_free_kick_p2"
        ]
        self.assertTrue(free_kick_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "free_kick",
                "highlights": ["free_kick"],
                "minute": 61,
                "clockSeconds": 3660,
                "participant": 2,
                "participantLabel": "Belgium",
                "description": "Free kick - Belgium",
            }
        )

        self.assertTrue(free_kick_predictions[0].resolved)
        self.assertGreaterEqual(colony.memory.wins, 1)
        self.assertTrue(any(event.kind == "settlement" and event.data.get("win") for event in room.log))

    def test_next_corner_market_resolves_on_first_corner_team(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_a"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Corner Nest", 20, "balanced", "corners", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 60,
                "clockSeconds": 3600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        corner_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_corner_p1"
        ]
        self.assertTrue(corner_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "corner",
                "highlights": ["corner"],
                "minute": 61,
                "clockSeconds": 3660,
                "participant": 1,
                "participantLabel": "France",
                "description": "Corner - France",
            }
        )

        self.assertTrue(corner_predictions[0].resolved)
        self.assertGreaterEqual(colony.memory.wins, 1)
        self.assertTrue(any(event.kind == "settlement" and event.data.get("resolvedOutcome", {}).get("target") == "corner" for event in room.log))

    def test_next_yellow_card_market_only_resolves_on_yellow_card(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_a"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Card Nest", 20, "balanced", "chaos", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 60,
                "clockSeconds": 3600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        yellow_card_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_yellow_card_p1"
        ]
        self.assertTrue(yellow_card_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "red_card",
                "highlights": ["red_card"],
                "minute": 61,
                "clockSeconds": 3660,
                "participant": 1,
                "participantLabel": "France",
                "description": "Red card - France",
            }
        )
        self.assertFalse(yellow_card_predictions[0].resolved)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 3,
                "action": "yellow_card",
                "highlights": ["yellow_card"],
                "minute": 62,
                "clockSeconds": 3720,
                "participant": 1,
                "participantLabel": "France",
                "description": "Yellow card - France",
            }
        )

        self.assertTrue(yellow_card_predictions[0].resolved)
        self.assertGreaterEqual(colony.memory.wins, 1)
        self.assertTrue(any(event.kind == "settlement" and event.data.get("resolvedOutcome", {}).get("target") == "yellow_card" for event in room.log))

    def test_next_free_kick_market_waits_until_full_time_without_free_kick(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_c"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Long Free Kick Watch", 20, "balanced", "chaos", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 75,
                "clockSeconds": 4500,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        free_kick_predictions = [
            prediction
            for prediction in room.predictions.values()
            if room.opportunities[prediction.opportunity_id].context == "next_free_kick"
        ]
        self.assertTrue(free_kick_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "clock",
                "highlights": [],
                "minute": 86,
                "clockSeconds": 5160,
                "description": "Clock tick",
            }
        )

        self.assertTrue(all(not prediction.resolved for prediction in free_kick_predictions))

        harness.finish_game()

        self.assertTrue(all(prediction.resolved for prediction in free_kick_predictions))
        self.assertTrue(
            [
                event
                for event in room.log
                if event.kind == "settlement"
                and event.data.get("reason") == "full_time"
                and event.data.get("win")
                and event.data.get("resolvedOutcome", {}).get("target") == "no_free_kick"
                and event.data.get("opportunityId") in {prediction.opportunity_id for prediction in free_kick_predictions}
            ]
        )

    def test_next_free_kick_market_stays_unique_while_window_open(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_a"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Free Kick Guard", 20, "balanced", "chaos", "medium")

        def pressure_event(seq: int) -> dict:
            return {
                "fixtureId": 42,
                "seq": seq,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 75 if seq == 1 else 77,
                "clockSeconds": 4500 if seq == 1 else 4620,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }

        harness.process_event(pressure_event(1))
        first_free_kick_opportunities = [
            opportunity
            for opportunity in room.opportunities.values()
            if opportunity.context == "next_free_kick"
        ]
        self.assertEqual(len(first_free_kick_opportunities), 1)
        first_free_kick_id = first_free_kick_opportunities[0].opportunity_id

        for seq in range(2, 24):
            harness.process_event(pressure_event(seq))

        free_kick_opportunities = [
            opportunity
            for opportunity in room.opportunities.values()
            if opportunity.context == "next_free_kick"
        ]
        open_free_kick_predictions = [
            prediction
            for prediction in room.predictions.values()
            if not prediction.resolved
            and room.opportunities[prediction.opportunity_id].context == "next_free_kick"
        ]

        self.assertEqual([opportunity.opportunity_id for opportunity in free_kick_opportunities], [first_free_kick_id])
        self.assertTrue(open_free_kick_predictions)

    def test_successful_prediction_adds_resources_only(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony(
            name="Momentum Nest",
            size=50,
            style="aggressive",
            favorite_context="momentum",
            info_need="low",
        )

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        starting_food = colony.food
        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 11,
                "clockSeconds": 650,
                "participant": 1,
                "participantLabel": "France",
                "score": {"participant1": 1, "participant2": 0},
                "confirmed": True,
                "description": "Goal - France - confirmed",
            }
        )

        self.assertGreaterEqual(colony.memory.attempts, 1)
        self.assertGreater(colony.food, starting_food)
        self.assertEqual(colony.larvae, 0)
        settlement = next(event for event in room.log if event.kind == "settlement")
        self.assertTrue(settlement.data.get("win"))
        self.assertGreater(settlement.data.get("resourceDelta"), 0)
        self.assertNotIn("dead", settlement.data)
        self.assertNotIn("wounded", settlement.data)

    def test_losing_prediction_removes_resources_only(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("option_c"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony(
            name="Resource Risk Nest",
            size=50,
            style="aggressive",
            favorite_context="momentum",
            info_need="low",
        )

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        starting_food = colony.food
        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 11,
                "clockSeconds": 650,
                "participant": 1,
                "participantLabel": "France",
                "score": {"participant1": 1, "participant2": 0},
                "confirmed": True,
                "description": "Goal - France - confirmed",
            }
        )

        public_state = colony.public_state(room.event_index)
        settlement = next(event for event in room.log if event.kind == "settlement")
        self.assertFalse(settlement.data.get("win"))
        self.assertLess(colony.food, starting_food)
        self.assertLess(settlement.data.get("resourceDelta"), 0)
        self.assertEqual(public_state["antsAlive"], STARTING_COLONY_ANTS)
        self.assertEqual(public_state["antsDead"], 0)
        self.assertEqual(public_state["antsWounded"], 0)
        self.assertNotIn("dead", settlement.data)
        self.assertNotIn("wounded", settlement.data)

    def test_unconfirmed_goal_does_not_resolve_pending_prediction(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony(
            name="Safe Nest",
            size=50,
            style="aggressive",
            favorite_context="momentum",
            info_need="low",
        )

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        pending_before = len([prediction for prediction in room.predictions.values() if not prediction.resolved])

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 11,
                "clockSeconds": 650,
                "participant": 1,
                "participantLabel": "France",
                "confirmed": False,
                "description": "Goal - France - not confirmed",
            }
        )
        pending_after = len([prediction for prediction in room.predictions.values() if not prediction.resolved])

        self.assertGreater(pending_before, 0)
        self.assertEqual(pending_after, pending_before)

    def test_goal_next_ten_market_waits_for_match_clock_not_event_count(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("no"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony(
            name="Clock Nest",
            size=50,
            style="balanced",
            favorite_context="momentum",
            info_need="low",
        )

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )
        goal_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.opportunity_id.endswith("_goal_next_10")
        ]
        self.assertTrue(goal_predictions)

        for offset in range(60):
            clock_seconds = 605 + offset * 5
            harness.process_event(
                {
                    "fixtureId": 42,
                    "seq": 2 + offset,
                    "action": "clock",
                    "highlights": [],
                    "minute": clock_seconds // 60,
                    "clockSeconds": clock_seconds,
                    "description": "Clock tick",
                }
            )

        goal_opportunity_ids = {prediction.opportunity_id for prediction in goal_predictions}
        self.assertTrue(all(not prediction.resolved for prediction in goal_predictions))
        self.assertFalse(
            [
                event
                for event in room.log
                if event.kind == "settlement" and event.data.get("opportunityId") in goal_opportunity_ids
            ]
        )

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 62,
                "action": "clock",
                "highlights": [],
                "minute": 20,
                "clockSeconds": 1200,
                "description": "Clock tick",
            }
        )

        self.assertTrue(all(prediction.resolved for prediction in goal_predictions))
        self.assertTrue(
            [
                event
                for event in room.log
                if event.kind == "settlement" and event.data.get("opportunityId") in goal_opportunity_ids
            ]
        )

    def test_deepseek_agent_is_required_for_game_events(self):
        manager = GameManager(decision_agent=None)
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony(
            name="No Agent Nest",
            size=10,
            style="balanced",
            favorite_context="momentum",
            info_need="low",
        )

        with self.assertRaisesRegex(RuntimeError, "DeepSeek agent required"):
            harness.process_event(
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 10,
                    "clockSeconds": 600,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                }
            )

        self.assertFalse(any(event.kind == "ant_agent_fallback" for event in room.log))

    def test_replay_finishes_with_two_and_three_colonies(self):
        def vote_for_market(ant, context):
            if context["market"]["context"] in {"next_goal_team", "next_corner", "next_free_kick", "next_yellow_card"}:
                return "option_a"
            return "yes"

        colony_configs = [
            ("A", 10, "balanced", "momentum", "medium"),
            ("B", 10, "cautious", "penalties", "high"),
            ("C", 10, "aggressive", "chaos", "low"),
        ]
        events = [
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            },
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 11,
                "clockSeconds": 660,
                "participant": 1,
                "participantLabel": "France",
                "score": {"participant1": 1, "participant2": 0},
                "confirmed": True,
                "description": "Goal - France - confirmed",
            },
            {
                "fixtureId": 42,
                "seq": 3,
                "action": "free_kick",
                "highlights": ["free_kick"],
                "minute": 12,
                "clockSeconds": 720,
                "participant": 1,
                "participantLabel": "France",
                "description": "Free kick - France",
            },
        ]

        for colony_count in (2, 3):
            with self.subTest(colony_count=colony_count):
                agent = FakeDeepSeekAntAgent(vote_for_market)
                manager = GameManager(decision_agent=agent)
                room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
                harness = manager.harness(room.game_id)
                for config in colony_configs[:colony_count]:
                    harness.add_colony(*config)

                harness.process_events(events)

                self.assertEqual(room.status, "finished")
                self.assertEqual(len(room.public_state()["colonies"]), colony_count)
                self.assertFalse([prediction for prediction in room.predictions.values() if not prediction.resolved])
                self.assertEqual(len(agent.calls), colony_count * len(BASELINE_MARKET_CONTEXTS))
                self.assertEqual(len([event for event in room.log if event.kind == "ant_agent_vote"]), colony_count * len(BASELINE_MARKET_CONTEXTS))
                self.assertEqual(len([event for event in room.log if event.kind == "settlement"]), colony_count * len(BASELINE_MARKET_CONTEXTS))

    def test_finish_voids_open_predictions_and_clears_markets(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Open Nest", 50, "aggressive", "momentum", "low")

        harness.process_events(
            [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 70,
                    "clockSeconds": 4200,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                }
            ]
        )

        self.assertEqual(room.status, "finished")
        self.assertEqual(room.opportunities, {})
        self.assertFalse([prediction for prediction in room.predictions.values() if not prediction.resolved])
        self.assertTrue(any(event.kind == "settlement" and event.data.get("reason") == "full_time" for event in room.log))

    def test_live_finish_closes_open_predictions_and_finishes_room(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Live Nest", 50, "aggressive", "momentum", "low")
        room.status = "running_live"

        _process_live_events(
            harness,
            [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 88,
                    "clockSeconds": 5280,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                }
            ],
        )
        self.assertTrue([prediction for prediction in room.predictions.values() if not prediction.resolved])

        final_timeline = {"events": [{"fixtureId": 42, "seq": 2, "action": "full_time", "raw": {"StatusId": 13}}]}
        self.assertTrue(_live_timeline_finished(final_timeline))
        _process_live_events(harness, final_timeline["events"])
        _finish_live_game(harness)

        self.assertEqual(room.status, "finished")
        self.assertFalse([prediction for prediction in room.predictions.values() if not prediction.resolved])
        self.assertTrue(any(event.kind == "game_finished" for event in room.log))

    def test_deepseek_ant_agent_vote_drives_prediction(self):
        class FakeAntAgent:
            def __init__(self):
                self.calls = []

            def decide(self, *, game_id, stage, context):
                return None

            def decide_ants(self, *, game_id, stage, context, ants):
                self.calls.append({"stage": stage, "context": context, "ants": ants})
                vote = "yes" if context["market"]["context"] == "goal_next_10" else "option_a"
                return [
                    {
                        "antId": ant["antId"],
                        "vote": vote,
                        "reason": f"{ant['archetype']} likes pressure",
                    }
                    for ant in ants
                ]

        agent = FakeAntAgent()
        manager = GameManager(decision_agent=agent)
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Ant Agents", 50, "balanced", "momentum", "medium")

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "high_danger_possession",
                "highlights": [],
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "participantLabel": "France",
                "possession": 1,
                "possessionLabel": "France",
                "description": "High danger possession - France",
            }
        )

        self.assertEqual(len(agent.calls), len(BASELINE_MARKET_CONTEXTS))
        self.assertEqual([call["context"]["market"]["context"] for call in agent.calls], list(BASELINE_MARKET_CONTEXTS))
        self.assertEqual(agent.calls[0]["context"]["colony"]["style"], "balanced")
        self.assertEqual(agent.calls[0]["context"]["colony"]["favoriteContext"], "momentum")
        self.assertEqual(agent.calls[0]["context"]["colony"]["infoNeed"], "medium")
        self.assertEqual(agent.calls[0]["context"]["market"]["availableVotes"][0]["vote"], "yes")
        self.assertIn("objective", agent.calls[0]["ants"][0])
        self.assertIn("personality", agent.calls[0]["ants"][0])
        self.assertIn("memory", agent.calls[0]["ants"][0])
        self.assertTrue(any(event.kind == "ant_agent_vote" for event in room.log))
        self.assertTrue(any(prediction.option.option_id == "goal_next_10_yes" for prediction in room.predictions.values()))
        self.assertFalse(any(event.kind == "agent_decision" for event in room.log))

    def test_deepseek_ant_agent_votes_do_not_buy_info(self):
        class FakeAntAgent:
            def decide(self, *, game_id, stage, context):
                return None

            def decide_ants(self, *, game_id, stage, context, ants):
                return [
                    {
                        "antId": ant["antId"],
                        "vote": "abstain",
                        "reason": "skip this penalty window",
                    }
                    for ant in ants
                ]

        manager = GameManager(decision_agent=FakeAntAgent())
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Info Ants", 50, "cautious", "penalties", "high")

        harness.process_event(penalty_event(player={"name": "Mbappe"}))

        self.assertFalse(any(event.kind == "info" for event in room.log))
        self.assertEqual(len([event for event in room.log if event.kind == "ant_agent_vote"]), 1)
        self.assertFalse(room.predictions)

    def test_openrouter_ant_decision_parser_validates_ids_and_options(self):
        agent = OpenRouterColonyAgent(OpenRouterSettings(api_key="test-key", model="deepseek/deepseek-v4-flash"))
        decisions = agent._parse_ant_decisions(
            {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "antDecisions": [
                                    {
                                        "antId": "ant_1",
                                        "vote": "yes",
                                        "reason": "good taker",
                                    },
                                    {
                                        "antId": "ant_2",
                                        "vote": "abstain",
                                        "reason": "neutral option",
                                    },
                                    {
                                        "antId": "intruder",
                                        "vote": "no",
                                        "reason": "ignore",
                                    },
                                ]
                            }
                        }
                    }
                ],
            },
            [{"antId": "ant_1"}, {"antId": "ant_2"}],
            {"yes": "penalty_goal", "no": "penalty_no_goal", "abstain": None},
        )

        self.assertEqual(len(decisions), 2)
        self.assertEqual(decisions[0].ant_id, "ant_1")
        self.assertEqual(decisions[0].action, "predict")
        self.assertEqual(decisions[1].action, "neutral")
        self.assertNotIn("confidence", decisions[0].public_state())

    def test_openrouter_per_ant_mode_calls_api_once_per_ant(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
            )
        )
        calls = []

        def fake_call(*, stage, context, ants):
            calls.append([ant["antId"] for ant in ants])
            ant_id = ants[0]["antId"]
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "antDecisions": [
                                    {
                                        "antId": ant_id,
                                        "vote": "yes",
                                        "reason": "solo call",
                                    }
                                ]
                            }
                        }
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        decisions = agent.decide_ants(
            game_id="game-test",
            stage="pre_info",
            context={
                "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
            },
            ants=[{"antId": "ant_1"}, {"antId": "ant_2"}, {"antId": "ant_3"}],
        )

        self.assertEqual(calls, [["ant_1"], ["ant_2"], ["ant_3"]])
        self.assertEqual(len(decisions), 3)
        self.assertTrue(all(decision.raw.get("_callMode") == "per_ant" for decision in decisions))

    def test_openrouter_per_ant_missing_single_decision_becomes_abstain(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
                max_retries=0,
            )
        )

        def fake_call(*, stage, context, ants):
            ant_id = ants[0]["antId"]
            if ant_id == "ant_2":
                return {
                    "model": "deepseek/deepseek-v4-flash",
                    "choices": [{"finish_reason": "stop", "message": {"content": {"vote": "yes"}}}],
                }
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "antDecisions": [
                                    {
                                        "antId": ant_id,
                                        "vote": "yes",
                                        "reason": "solo call",
                                    }
                                ]
                            }
                        }
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        decisions = agent.decide_ants(
            game_id="game-test",
            stage="pre_info",
            context={
                "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
            },
            ants=[{"antId": "ant_1"}, {"antId": "ant_2"}, {"antId": "ant_3"}],
        )

        self.assertEqual([decision.ant_id for decision in decisions], ["ant_1", "ant_2", "ant_3"])
        self.assertEqual(decisions[1].vote, "abstain")
        self.assertEqual(decisions[1].action, "neutral")
        self.assertTrue(decisions[1].raw.get("_technicalAbstain"))
        self.assertEqual(decisions[1].raw["_failure"]["category"], "missing_ant_decision")

    def test_openrouter_single_ant_payload_uses_minimal_vote_schema(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(api_key="test-key", model="deepseek/deepseek-v4-flash", max_tokens=1200)
        )

        payload = agent._ant_payload(
            stage="pre_info",
            context={
                "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
            },
            ants=[{"antId": "ant_1"}],
        )

        schema = payload["response_format"]["json_schema"]["schema"]
        self.assertEqual(payload["max_tokens"], 96)
        self.assertEqual(payload["response_format"]["json_schema"]["name"], "single_ant_agent_decision")
        self.assertEqual(schema["required"], ["antId", "vote"])
        self.assertNotIn("reason", schema["properties"])

    def test_openrouter_ant_payload_uses_dynamic_market_vote_schema(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(api_key="test-key", model="deepseek/deepseek-v4-flash", max_tokens=1200)
        )

        payload = agent._ant_payload(
            stage="pre_info",
            context={
                "market": {
                    "availableVotes": [
                        {"vote": "option_a", "optionId": "next_goal_p1"},
                        {"vote": "option_b", "optionId": "next_goal_p2"},
                        {"vote": "option_c", "optionId": "next_goal_none"},
                        {"vote": "abstain", "optionId": None},
                    ]
                },
                "opportunity": {
                    "options": [
                        {"optionId": "next_goal_p1"},
                        {"optionId": "next_goal_p2"},
                        {"optionId": "next_goal_none"},
                    ]
                },
            },
            ants=[{"antId": "ant_1"}],
        )

        vote_schema = payload["response_format"]["json_schema"]["schema"]["properties"]["vote"]
        self.assertEqual(vote_schema["enum"], ["option_a", "option_b", "option_c", "abstain"])

    def test_openrouter_per_ant_error_keeps_provider_details(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
            )
        )

        def fake_call(*, stage, context, ants):
            if ants[0]["antId"] == "ant_2":
                raise httpx.ReadTimeout("provider timed out")
            ant_id = ants[0]["antId"]
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "antDecisions": [
                                    {
                                        "antId": ant_id,
                                        "vote": "yes",
                                        "reason": "solo call",
                                    }
                                ]
                            }
                        }
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        with self.assertRaises(AgentDecisionError) as raised:
            agent.decide_ants(
                game_id="game-test",
                stage="pre_info",
                context={
                    "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                    "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
                },
                ants=[{"antId": "ant_1"}, {"antId": "ant_2"}, {"antId": "ant_3"}],
            )

        self.assertIn("First failure: timeout", str(raised.exception))
        self.assertEqual(raised.exception.details[0]["category"], "timeout")
        self.assertEqual(raised.exception.details[0]["antId"], "ant_2")
        self.assertEqual(raised.exception.details[0]["stage"], "pre_info")

    def test_openrouter_invalid_assistant_json_keeps_response_snippet(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
            )
        )

        def fake_call(*, stage, context, ants):
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": '{"antDecisions":[{"antId":"ant_1","vote":"yes","reason":"broken"}',
                        }
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        with self.assertRaises(AgentDecisionError) as raised:
            agent.decide_ants(
                game_id="game-test",
                stage="pre_info",
                context={
                    "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                    "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
                },
                ants=[{"antId": "ant_1"}],
            )

        detail = raised.exception.details[0]
        self.assertEqual(detail["category"], "invalid_assistant_json")
        self.assertEqual(detail["antId"], "ant_1")
        self.assertIn("contentSnippet", detail)
        self.assertIn("broken", detail["contentSnippet"])

    def test_openrouter_missing_ant_decision_keeps_parsed_response_snippet(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
                max_retries=0,
            )
        )

        def fake_call(*, stage, context, ants):
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": {
                                "vote": "yes",
                            }
                        },
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        with self.assertRaises(AgentDecisionError) as raised:
            agent.decide_ants(
                game_id="game-test",
                stage="pre_info",
                context={
                    "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                    "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
                },
                ants=[{"antId": "ant_1"}],
            )

        detail = raised.exception.details[0]
        self.assertEqual(detail["category"], "missing_ant_decision")
        self.assertEqual(detail["antId"], "ant_1")
        self.assertEqual(detail["finishReason"], "stop")
        self.assertEqual(detail["expectedAntIds"], ["ant_1"])
        self.assertEqual(detail["rejectionReason"], "no_ant_decision_object")
        self.assertIn('"vote":"yes"', detail["parsedSnippet"])

    def test_openrouter_single_ant_top_level_array_is_parsed(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="per_ant",
                max_parallel_ant_calls=1,
                max_calls_per_game=10,
                max_retries=0,
            )
        )

        def fake_call(*, stage, context, ants):
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": '[{"antId":"ant_1","vote":"yes"}]',
                        },
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        decisions = agent.decide_ants(
            game_id="game-test",
            stage="pre_info",
            context={
                "market": {"yesOptionId": "penalty_goal", "noOptionId": "penalty_no_goal"},
                "opportunity": {"options": [{"optionId": "penalty_goal"}, {"optionId": "penalty_no_goal"}]},
            },
            ants=[{"antId": "ant_1"}],
        )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].ant_id, "ant_1")
        self.assertEqual(decisions[0].vote, "yes")
        self.assertEqual(decisions[0].option_id, "penalty_goal")

    def test_openrouter_usage_accumulates_deepseek_cost(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                input_price_per_million_usd=0.09,
                output_price_per_million_usd=0.18,
            )
        )

        agent._record_usage(
            "game-cost",
            {
                "model": "deepseek/deepseek-v4-flash",
                "usage": {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200},
            },
        )

        usage = agent.usage_for_game("game-cost")
        self.assertEqual(usage["inputTokens"], 1000)
        self.assertEqual(usage["outputTokens"], 200)
        self.assertEqual(usage["totalTokens"], 1200)
        self.assertEqual(usage["apiCalls"], 1)
        self.assertEqual(usage["costUsd"], 0.000126)
        self.assertTrue(usage["costComplete"])

    def test_game_finished_includes_agent_usage_cost(self):
        class FakeAntAgent:
            def decide(self, *, game_id, stage, context):
                return None

            def decide_ants(self, *, game_id, stage, context, ants):
                return [
                    {
                        "antId": ant["antId"],
                        "vote": "abstain",
                        "reason": "wait",
                    }
                    for ant in ants
                ]

            def usage_for_game(self, game_id):
                return {
                    "model": "deepseek/deepseek-v4-flash",
                    "budgetedCalls": 10,
                    "apiCalls": 10,
                    "inputTokens": 9000,
                    "outputTokens": 600,
                    "totalTokens": 9600,
                    "inputCostUsd": 0.00081,
                    "outputCostUsd": 0.000108,
                    "costUsd": 0.000918,
                    "costComplete": True,
                    "missingUsageResponses": 0,
                }

        manager = GameManager(decision_agent=FakeAntAgent())
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Cost Ants", 10, "balanced", "momentum", "medium")
        harness.process_events(
            [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 10,
                    "clockSeconds": 600,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                }
            ]
        )

        self.assertEqual(room.public_state()["agentUsage"]["costUsd"], 0.000918)
        self.assertEqual(room.log[-1].kind, "game_finished")
        self.assertIn("AI cost: $0.000918", room.log[-1].message)
        self.assertEqual(room.log[-1].data["agentUsage"]["apiCalls"], 10)

    def test_openrouter_decision_exposes_squad_votes(self):
        agent = OpenRouterColonyAgent(OpenRouterSettings(api_key="test-key", model="deepseek/deepseek-v4-flash"))
        decision = agent._parse_decision(
            "pre_info",
            {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "action": "predict",
                                "buyInfo": False,
                                "optionId": "goal_next_10_yes",
                                "stakeFraction": 0.25,
                                "confidence": 0.72,
                                "reason": "Momentum supports a small attack.",
                                "squadVotes": [
                                    {
                                        "squad": "data",
                                        "ants": 24,
                                        "action": "observe",
                                        "optionId": None,
                                        "confidence": 0.41,
                                        "reason": "sample too thin",
                                    },
                                    {
                                        "squad": "momentum",
                                        "ants": 35,
                                        "action": "predict",
                                        "optionId": "goal_next_10_yes",
                                        "confidence": 0.76,
                                        "reason": "pressure rising",
                                    },
                                ],
                            }
                        }
                    }
                ],
            },
            {
                "opportunity": {
                    "options": [
                        {"optionId": "goal_next_10_yes"},
                        {"optionId": "goal_next_10_no"},
                    ]
                }
            },
        )

        self.assertEqual(decision.source, "openrouter")
        self.assertEqual(decision.option_id, "goal_next_10_yes")
        self.assertEqual(len(decision.squad_votes), 2)
        self.assertEqual(decision.public_state()["squadVotes"][1]["squad"], "momentum")


class DemoRunApiTest(unittest.TestCase):
    def test_live_target_prefers_current_match_then_next_fixture(self):
        now = datetime(2026, 7, 1, 18, 0, tzinfo=timezone.utc)
        current, kind = _pick_live_target_fixture(
            [
                {"fixtureId": 1, "startTime": int((now + timedelta(minutes=20)).timestamp())},
                {"fixtureId": 2, "startTime": int((now - timedelta(minutes=35)).timestamp())},
            ],
            now=now,
        )
        self.assertEqual(kind, "current")
        self.assertEqual(current["fixtureId"], 2)

        next_fixture, next_kind = _pick_live_target_fixture(
            [
                {"fixtureId": 3, "startTime": int((now + timedelta(minutes=40)).timestamp())},
                {"fixtureId": 4, "startTime": int((now + timedelta(minutes=10)).timestamp())},
            ],
            now=now,
        )
        self.assertEqual(next_kind, "next")
        self.assertEqual(next_fixture["fixtureId"], 4)

    def test_live_target_endpoint_returns_one_match(self):
        class FakeTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                start = int((datetime.now(timezone.utc) - timedelta(minutes=20)).timestamp())
                return [
                    {
                        "FixtureId": 555,
                        "StartTime": start,
                        "Competition": "World Cup Live",
                        "CompetitionId": competition_id or 72,
                        "Participant1": "Japan",
                        "Participant2": "Brazil",
                    }
                ]

        client = TestClient(app)
        with patch("app.main.TxLineClient", FakeTxLineClient):
            response = client.get("/api/fixtures/live-target?days=1")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "current")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["fixture"]["fixtureId"], 555)
        self.assertEqual(len(payload["fixtures"]), 1)

    def test_room_setup_api_supports_join_and_strategy_patch(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={"fixtureId": 4242, "participant1": "Portugal", "participant2": "Brazil", "seed": 17},
        ).json()

        joined = client.post(f"/api/games/{created['gameId']}/players", json={"name": "Alice"})
        self.assertEqual(joined.status_code, 200)
        self.assertEqual(joined.json()["players"][0]["name"], "Alice")

        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={"name": "A", "size": 20, "style": "balanced", "favoriteContext": "momentum", "infoNeed": "medium"},
        )
        self.assertEqual(colony_response.status_code, 200)
        colony_id = colony_response.json()["colonies"][0]["colonyId"]

        strategy_response = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/strategy",
            json={"style": "cautious", "favoriteContext": "penalties", "infoNeed": "high"},
        )
        self.assertEqual(strategy_response.status_code, 200)
        game = strategy_response.json()
        self.assertEqual(game["players"][0]["name"], "Alice")
        self.assertEqual(game["colonies"][0]["style"], "cautious")
        self.assertEqual(game["colonies"][0]["favoriteContext"], "penalties")
        self.assertEqual(game["colonies"][0]["infoNeed"], "high")

    def test_colony_strategy_patch_requires_matching_anonymous_owner(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={"fixtureId": 4243, "participant1": "Portugal", "participant2": "Brazil", "seed": 18},
        ).json()

        joined = client.post(
            f"/api/games/{created['gameId']}/players",
            json={"name": "Alice", "anonymousId": "anon_owner_alice"},
        )
        self.assertEqual(joined.status_code, 200)

        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "A",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_owner_alice",
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        colony_id = colony_response.json()["colonies"][0]["colonyId"]

        blocked = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/strategy",
            json={"style": "cautious", "anonymousId": "anon_intruder"},
        )
        self.assertEqual(blocked.status_code, 403)

        allowed = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/strategy",
            json={"style": "aggressive", "anonymousId": "anon_owner_alice"},
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.json()["colonies"][0]["style"], "aggressive")

    def test_live_ant_strategy_api_lists_updates_and_resets_owned_ant(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={"fixtureId": 4244, "participant1": "Japan", "participant2": "Brazil", "seed": 19},
        ).json()
        anonymous_id = "anon_ant_orders_owner"
        client.post(
            f"/api/games/{created['gameId']}/players",
            json={"name": "Ant Coach", "anonymousId": anonymous_id},
        )
        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Ant Coach",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": anonymous_id,
            },
        )
        colony_id = colony_response.json()["colonies"][0]["colonyId"]
        room = game_manager.get_room(created["gameId"])
        self.assertIsNotNone(room)
        room.status = "running_live"

        blocked = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants",
            params={"anonymousId": "anon_intruder"},
        )
        self.assertEqual(blocked.status_code, 403)

        roster = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants",
            params={"anonymousId": anonymous_id},
        )
        self.assertEqual(roster.status_code, 200)
        self.assertEqual(len(roster.json()["ants"]), STARTING_COLONY_ANTS)
        ant_id = roster.json()["ants"][0]["antId"]

        updated = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}/strategy",
            json={
                "style": "aggressive",
                "favoriteContext": "chaos",
                "infoNeed": "low",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["ant"]["strategy"]["style"], "aggressive")
        self.assertFalse(updated.json()["ant"]["strategy"]["inheritsGlobal"])

        reset = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}/strategy",
            json={"inheritGlobal": True, "anonymousId": anonymous_id},
        )
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(reset.json()["ant"]["strategy"]["style"], "balanced")
        self.assertTrue(reset.json()["ant"]["strategy"]["inheritsGlobal"])

        detail = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}",
            params={"anonymousId": anonymous_id},
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["summary"]["total"], 0)
        self.assertEqual(len(detail.json()["strategyHistory"]), 2)
        self.assertTrue(detail.json()["strategyHistory"][0]["strategy"]["inheritsGlobal"])

    def test_ant_detail_api_returns_durable_bet_ledger_with_strategy_and_reason(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={"fixtureId": 4245, "participant1": "France", "participant2": "Belgium", "seed": 20},
        ).json()
        anonymous_id = "anon_ant_history_owner"
        client.post(
            f"/api/games/{created['gameId']}/players",
            json={"name": "Ledger Queen", "anonymousId": anonymous_id},
        )
        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Ledger Queen",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "penalties",
                "infoNeed": "low",
                "anonymousId": anonymous_id,
            },
        )
        colony_id = colony_response.json()["colonies"][0]["colonyId"]
        room = game_manager.get_room(created["gameId"])
        self.assertIsNotNone(room)
        room.status = "running_live"
        harness = GameHarness(room, FakeDeepSeekAntAgent(vote="yes"))

        harness.process_event(penalty_event(id=10, seq=10))
        prediction = next(iter(room.predictions.values()))
        ant_id = prediction.ant_ids[0]
        harness.process_event(
            penalty_event(
                id=11,
                seq=11,
                action="goal",
                highlights=["goal"],
                minute=64,
                clockSeconds=3840,
                score={"participant1": 1, "participant2": 0},
            )
        )

        blocked = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}",
            params={"anonymousId": "anon_intruder"},
        )
        self.assertEqual(blocked.status_code, 403)

        detail = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}",
            params={"anonymousId": anonymous_id},
        )
        self.assertEqual(detail.status_code, 200)
        payload = detail.json()
        self.assertEqual(
            payload["summary"],
            {"total": 1, "open": 0, "won": 1, "lost": 0, "void": 0, "recalled": 0},
        )
        bet = payload["bets"][0]
        self.assertEqual(bet["predictionId"], prediction.prediction_id)
        self.assertEqual(bet["status"], "won")
        self.assertEqual(bet["context"], "penalties")
        self.assertEqual(bet["strategy"]["style"], "balanced")
        self.assertIn("test vote", bet["decisionReason"])
        self.assertGreater(bet["foodAtRisk"], 0)
        self.assertGreater(bet["colonyFoodDelta"], 0)

    def test_private_room_code_endpoint_supports_join(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 818181,
                "participant1": "USA",
                "participant2": "Japan",
                "competition": "World Cup",
                "startTime": 1782950400000,
                "startTimeIso": "2026-07-02T00:00:00+00:00",
                "seed": 3,
            },
        ).json()
        room_code = created["roomCode"]

        self.assertEqual(len(room_code), 6)
        self.assertTrue(room_code.isdigit())
        self.assertEqual(created["competition"], "World Cup")
        self.assertEqual(created["startTimeIso"], "2026-07-02T00:00:00+00:00")

        found = client.get(f"/api/rooms/{room_code}")
        self.assertEqual(found.status_code, 200)
        self.assertEqual(found.json()["gameId"], created["gameId"])
        self.assertEqual(found.json()["startTime"], 1782950400000)

        joined = client.post(f"/api/rooms/{room_code}/players", json={"name": "Alice", "anonymousId": "anon_alice"})
        self.assertEqual(joined.status_code, 200)
        self.assertEqual(joined.json()["players"][0]["name"], "Alice")

        joined_again = client.post(f"/api/rooms/{room_code}/players", json={"name": "Alice 2", "anonymousId": "anon_alice"})
        self.assertEqual(joined_again.status_code, 200)
        self.assertEqual(len(joined_again.json()["players"]), 1)
        self.assertEqual(joined_again.json()["players"][0]["name"], "Alice 2")

    def test_creator_auto_joins_and_player_creates_one_colony(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 919191,
                "participant1": "France",
                "participant2": "Spain",
                "creatorName": "Host Alice",
                "anonymousId": "anon_host_alice",
            },
        ).json()

        self.assertEqual(len(created["players"]), 1)
        self.assertEqual(created["players"][0]["name"], "Host Alice")
        self.assertTrue(created["players"][0]["isHost"])

        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Alice Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_host_alice",
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        game = colony_response.json()
        self.assertTrue(game["players"][0]["ready"])
        self.assertEqual(game["players"][0]["colonyName"], "Host Alice")
        self.assertEqual(game["colonies"][0]["playerAnonymousId"], "anon_host_alice")

        duplicate = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Second Nest",
                "size": 10,
                "style": "cautious",
                "favoriteContext": "penalties",
                "infoNeed": "high",
                "anonymousId": "anon_host_alice",
            },
        )
        self.assertEqual(duplicate.status_code, 422)
        self.assertIn("already has a colony", duplicate.json()["detail"])

    def test_public_match_room_is_unique_per_fixture(self):
        client = TestClient(app)
        first = client.post(
            "/api/games",
            json={
                "fixtureId": 929291,
                "participant1": "France",
                "participant2": "Canada",
                "creatorName": "Alice",
                "anonymousId": "anon_single_alice",
            },
        )
        second = client.post(
            "/api/games",
            json={
                "fixtureId": 929291,
                "participant1": "France",
                "participant2": "Canada",
                "creatorName": "Bob",
                "anonymousId": "anon_single_bob",
            },
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_game = first.json()
        second_game = second.json()
        self.assertEqual(second_game["gameId"], first_game["gameId"])
        self.assertEqual(second_game["roomCode"], first_game["roomCode"])
        self.assertEqual({player["name"] for player in second_game["players"]}, {"Alice", "Bob"})
        self.assertEqual(second_game["mode"], "live")

    def test_player_name_controls_linked_colony_name(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 929293,
                "participant1": "Mexico",
                "participant2": "England",
                "creatorName": "Host Alice",
                "anonymousId": "anon_name_link",
            },
        ).json()
        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Different Colony",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_name_link",
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        self.assertEqual(colony_response.json()["colonies"][0]["name"], "Host Alice")

        renamed = client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Blue Nest", "anonymousId": "anon_name_link"},
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["players"][0]["name"], "Blue Nest")
        self.assertEqual(renamed.json()["colonies"][0]["name"], "Blue Nest")

    def test_live_room_auto_waits_for_future_kickoff_and_stays_joinable(self):
        client = TestClient(app)
        kickoff = datetime.now(timezone.utc) + timedelta(minutes=15)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 929292,
                "participant1": "USA",
                "participant2": "Japan",
                "startTimeIso": kickoff.isoformat(),
                "creatorName": "Host Alice",
                "anonymousId": "anon_wait_host",
            },
        ).json()
        with patch("app.main._schedule_kickoff_start") as schedule:
            colony_response = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Kickoff Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "anonymousId": "anon_wait_host",
                },
            )
        self.assertEqual(colony_response.status_code, 200)
        self.assertEqual(colony_response.json()["status"], "waiting_kickoff")
        schedule.assert_called_once()

        joined_after_lock = client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Late Bob", "anonymousId": "anon_late_bob"},
        )
        self.assertEqual(joined_after_lock.status_code, 200)

        colony_after_lock = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Late Nest",
                "size": 10,
                "style": "cautious",
                "favoriteContext": "penalties",
                "infoNeed": "high",
                "anonymousId": "anon_late_bob",
            },
        )
        self.assertEqual(colony_after_lock.status_code, 200)
        self.assertEqual(len(colony_after_lock.json()["colonies"]), 2)

    def test_live_room_auto_starts_for_match_in_progress(self):
        client = TestClient(app)
        kickoff = datetime.now(timezone.utc) - timedelta(minutes=25)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 959595,
                "participant1": "Australia",
                "participant2": "Egypt",
                "startTimeIso": kickoff.isoformat(),
                "creatorName": "Host Alice",
                "anonymousId": "anon_live_host",
            },
        ).json()
        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")), patch("app.main._ensure_live_task") as live_task:
            colony_response = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Live Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "anonymousId": "anon_live_host",
                },
            )

        self.assertEqual(colony_response.status_code, 200)
        self.assertEqual(colony_response.json()["status"], "running_live")
        live_task.assert_called_once()

        late_join = client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Late Live", "anonymousId": "anon_late_live"},
        )
        self.assertEqual(late_join.status_code, 200)

        with patch("app.main._ensure_live_task") as resumed_live_task:
            late_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Live Late Nest",
                    "size": 10,
                    "style": "aggressive",
                    "favoriteContext": "chaos",
                    "infoNeed": "low",
                    "anonymousId": "anon_late_live",
                },
            )
        self.assertEqual(late_colony.status_code, 200)
        self.assertEqual(late_colony.json()["status"], "running_live")
        self.assertEqual(len(late_colony.json()["colonies"]), 2)
        resumed_live_task.assert_called_once()

    def test_error_live_room_recovers_when_state_is_loaded(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 949494,
                "participant1": "Spain",
                "participant2": "Canada",
                "creatorName": "Host Alice",
                "anonymousId": "anon_recover_host",
            },
        ).json()
        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Recover Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_recover_host",
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        room = game_manager.get_room(created["gameId"])
        self.assertIsNotNone(room)
        room.mode = "live"
        room.status = "error"

        with patch("app.main._ensure_live_task") as live_task:
            response = client.get(f"/api/games/{created['gameId']}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "running_live")
        live_task.assert_called_once()
        self.assertTrue(any(event.kind == "live_sync" and event.data.get("recovered") for event in room.log))

    def test_stored_error_live_game_can_resume(self):
        self.assertTrue(_stored_game_can_resume_live({"status": "waiting_kickoff"}))
        self.assertTrue(_stored_game_can_resume_live({"status": "running_live"}))
        self.assertTrue(_stored_game_can_resume_live({"status": "error", "mode": "live"}))
        self.assertFalse(_stored_game_can_resume_live({"status": "error", "mode": "replay"}))
        self.assertFalse(_stored_game_can_resume_live({"status": "finished", "mode": "live"}))

    def test_live_catchup_does_not_create_retroactive_markets(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Catchup Nest", 20, "balanced", "momentum", "medium")
        seen: set[tuple] = set()

        count = _prime_live_catchup(
            room,
            seen,
            [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 10,
                    "clockSeconds": 600,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                },
                {
                    "fixtureId": 42,
                    "seq": 2,
                    "action": "goal",
                    "highlights": ["goal"],
                    "minute": 12,
                    "clockSeconds": 720,
                    "participant": 1,
                    "participantLabel": "France",
                    "score": {"participant1": 1, "participant2": 0},
                    "confirmed": True,
                    "description": "Goal - France - confirmed",
                },
            ],
            {"resolvedSource": "updates", "rawCount": 2, "score": {"participant1": 1, "participant2": 0}},
        )

        self.assertEqual(count, 2)
        self.assertEqual(room.event_index, 0)
        self.assertEqual(room.opportunities, {})
        self.assertEqual(room.predictions, {})
        self.assertFalse(any(event.kind == "settlement" for event in room.log))
        self.assertEqual(room.match_state.score, {"participant1": 1, "participant2": 0})
        self.assertTrue(any(event.kind == "live_sync" and event.data.get("processedAsMarkets") is False for event in room.log))

    def test_live_baseline_markets_open_after_catchup(self):
        def first_available_vote(_ant, context):
            return context["market"]["availableVotes"][0]["vote"]

        manager = GameManager(decision_agent=FakeDeepSeekAntAgent(first_available_vote))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Live Nest", 20, "balanced", "momentum", "medium")
        seen: set[tuple] = set()
        catchup_events = [
            {
                "fixtureId": 42,
                "seq": 1,
                "action": "clock",
                "highlights": [],
                "minute": 5,
                "clockSeconds": 300,
                "score": {"participant1": 0, "participant2": 0},
                "description": "Clock tick",
            }
        ]

        _prime_live_catchup(
            room,
            seen,
            catchup_events,
            {"resolvedSource": "updates", "rawCount": 1, "score": {"participant1": 0, "participant2": 0}},
        )
        opened = _open_live_baseline_markets(harness, catchup_events)

        self.assertEqual(opened, len(BASELINE_MARKET_CONTEXTS))
        self.assertEqual({opportunity.context for opportunity in room.opportunities.values()}, set(BASELINE_MARKET_CONTEXTS))
        self.assertEqual(len([prediction for prediction in room.predictions.values() if not prediction.resolved]), len(BASELINE_MARKET_CONTEXTS))
        self.assertTrue(any(event.kind == "live_sync" and event.data.get("source") == "baseline" for event in room.log))

    def test_scheduled_txline_state_waits_before_live_markets(self):
        scheduled_timeline = {
            "events": [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "gameState": "scheduled",
                    "statusId": 1,
                    "action": "lineups",
                }
            ]
        }
        active_timeline = {
            "events": [
                {
                    "fixtureId": 42,
                    "seq": 2,
                    "gameState": "inplay",
                    "statusId": 2,
                    "action": "connected",
                }
            ]
        }

        self.assertFalse(_live_timeline_active(scheduled_timeline))
        self.assertTrue(_live_timeline_active(active_timeline))

    def test_final_latest_state_finishes_live_timeline_without_full_time_event(self):
        status_id_timeline = {
            "latestState": {
                "fixtureId": 42,
                "gameState": "finished",
                "statusId": 13,
                "action": "score_update",
            },
            "events": [],
        }
        text_state_timeline = {
            "latestState": {
                "fixtureId": 42,
                "gameState": "Full Time",
                "statusId": None,
                "action": "score_update",
            },
            "events": [{"fixtureId": 42, "seq": 99, "action": "clock"}],
        }

        self.assertTrue(_live_timeline_finished(status_id_timeline))
        self.assertFalse(_live_timeline_active(status_id_timeline))
        self.assertTrue(_live_timeline_finished(text_state_timeline))
        self.assertFalse(_live_timeline_active(text_state_timeline))

    def test_stale_scheduled_latest_state_does_not_hide_live_activity(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="Portugal", participant2="Spain", seed=123)
        timeline = {
            "latestState": {
                "fixtureId": 42,
                "gameState": "scheduled",
                "statusId": 1,
                "action": "coverage_update",
            },
            "score": {"participant1": 0, "participant2": 1},
            "events": [
                {
                    "fixtureId": 42,
                    "seq": 330,
                    "gameState": "scheduled",
                    "statusId": 1,
                    "action": "free_kick",
                    "highlights": ["free_kick"],
                    "minute": 88,
                    "clockSeconds": 5280,
                    "participant": 2,
                    "participantLabel": "Spain",
                    "score": {"participant1": 0, "participant2": 1},
                }
            ],
        }

        self.assertTrue(_live_timeline_active(timeline))
        _prime_live_catchup(room, set(), timeline["events"], timeline)

        self.assertEqual(room.match_state.score, {"participant1": 0, "participant2": 1})
        self.assertEqual(room.match_state.game_state, "inplay")
        self.assertNotEqual(room.public_state()["match"]["gameState"], "scheduled")

    def test_live_catchup_resets_stale_score_when_no_official_score_exists(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="Brazil", participant2="Norway", seed=123)
        room.match_state.score = {"participant1": 0, "participant2": 1}
        seen: set[tuple] = set()

        count = _prime_live_catchup(
            room,
            seen,
            [
                {
                    "fixtureId": 42,
                    "seq": 59,
                    "action": "goal",
                    "highlights": ["goal"],
                    "minute": 3,
                    "clockSeconds": 160,
                    "participant": 2,
                    "participantLabel": "Norway",
                    "confirmed": False,
                    "score": {"participant1": None, "participant2": None},
                    "description": "Goal - Norway - not confirmed",
                },
                {
                    "fixtureId": 42,
                    "seq": 64,
                    "action": "var_end",
                    "highlights": ["var"],
                    "outcome": "Overturned",
                    "minute": 4,
                    "clockSeconds": 207,
                    "score": {"participant1": None, "participant2": None},
                    "description": "VAR - goal overturned",
                },
            ],
            {"resolvedSource": "updates", "rawCount": 2, "score": None},
        )

        self.assertEqual(count, 2)
        self.assertEqual(room.match_state.score, {"participant1": 0, "participant2": 0})

    def test_resilient_live_processing_skips_failed_event_and_continues(self):
        class FailingAntAgent:
            def decide_ants(self, *, game_id, stage, context, ants):
                raise AgentDecisionError("missing_ant_decision")

        manager = GameManager(decision_agent=FailingAntAgent())
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        harness.add_colony("Live Nest", 20, "balanced", "momentum", "medium")

        processed = _process_live_events(
            harness,
            [
                {
                    "fixtureId": 42,
                    "seq": 1,
                    "action": "high_danger_possession",
                    "highlights": [],
                    "minute": 10,
                    "clockSeconds": 600,
                    "participant": 1,
                    "participantLabel": "France",
                    "possession": 1,
                    "possessionLabel": "France",
                    "description": "High danger possession - France",
                },
                {
                    "fixtureId": 42,
                    "seq": 2,
                    "action": "clock",
                    "highlights": [],
                    "minute": 11,
                    "clockSeconds": 660,
                    "description": "Clock tick",
                },
            ],
            resilient=True,
        )

        self.assertEqual(processed, 1)
        self.assertEqual(room.event_index, 2)
        self.assertTrue(any(event.kind == "game_error" and "Live update skipped" in event.message for event in room.log))

    def test_live_host_can_manually_finish_stuck_room(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 939393,
                "participant1": "Spain",
                "participant2": "Austria",
                "creatorName": "Host Alice",
                "anonymousId": "anon_finish_host",
            },
        ).json()
        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Finish Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_finish_host",
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        room = game_manager.get_room(created["gameId"])
        self.assertIsNotNone(room)
        room.status = "running_live"

        blocked = client.post(f"/api/games/{created['gameId']}/finish", json={"anonymousId": "anon_someone_else"})
        self.assertEqual(blocked.status_code, 403)

        finished = client.post(f"/api/games/{created['gameId']}/finish", json={"anonymousId": "anon_finish_host"})
        self.assertEqual(finished.status_code, 200)
        self.assertEqual(finished.json()["status"], "finished")
        self.assertTrue(any(event.kind == "game_finished" for event in room.log))

    def test_replay_endpoint_resumes_running_live_room(self):
        client = TestClient(app)
        room = game_manager.create_room(fixture_id=939394, participant1="Portugal", participant2="Spain", seed=123)
        room.mode = "live"
        room.status = "running_live"
        room.add_log("game_started", "Live game connected to TXLine updates.", {"mode": "live"})

        with patch("app.main._ensure_live_task") as live_task:
            response = client.get(f"/api/games/{room.game_id}/replay")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["game"]["status"], "running_live")
        live_task.assert_called_once_with(room)

    def test_live_auto_finish_falls_back_to_game_started_age(self):
        manager = GameManager()
        room = manager.create_room(fixture_id=42, participant1="Portugal", participant2="Spain", seed=123)
        room.mode = "live"
        room.status = "running_live"
        room.start_time = None
        room.start_time_iso = None
        room.add_log("game_started", "Live game connected to TXLine updates.", {"mode": "live"})
        room.log[-1].created_at = (datetime.now(timezone.utc) - timedelta(hours=4)).timestamp()

        self.assertTrue(_live_auto_finish_reached(room))

    def test_demo_run_requires_deepseek_agent(self):
        client = TestClient(app)

        with patch("app.main.game_manager.decision_agent", None):
            response = client.post("/api/demo/run", json={"seed": 99})

        self.assertEqual(response.status_code, 503)
        self.assertIn("DeepSeek", response.json()["detail"])

    def test_demo_run_finishes_without_txline_credentials(self):
        client = TestClient(app)

        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")):
            response = client.post("/api/demo/run", json={"seed": 99})

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertEqual(game["fixtureId"], "demo-sandbox-previous")
        self.assertEqual(game["status"], "finished")
        self.assertEqual(len(game["colonies"]), 3)
        self.assertGreater(game["eventIndex"], 10)

        replay = client.get(f"/api/games/{game['gameId']}/replay").json()
        kinds = {event["kind"] for event in replay["events"]}
        self.assertIn("opportunity", kinds)
        self.assertIn("prediction", kinds)
        self.assertIn("settlement", kinds)

    def test_admin_debug_tools_remain_open_when_legacy_token_is_configured(self):
        client = TestClient(app)

        with patch.dict("os.environ", {"AOC_ADMIN_TOKEN": "secret"}):
            created = client.post(
                "/api/games",
                json={
                    "fixtureId": 515151,
                    "participant1": "Norway",
                    "participant2": "Canada",
                    "creatorName": "Host",
                    "anonymousId": "anon_admin_guard_host",
                },
            ).json()
            public_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Player Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "anonymousId": "anon_admin_guard_host",
                },
            )
            self.assertEqual(public_colony.status_code, 200)

            open_admin_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Admin Only Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                },
            )
            self.assertEqual(open_admin_colony.status_code, 200)

            with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")):
                open_demo = client.post("/api/demo/run", json={"seed": 99})
            self.assertEqual(open_demo.status_code, 200)

            health = client.get("/health").json()
            self.assertFalse(health["adminToolsProtected"])
            self.assertTrue(health["adminAuthenticated"])
            self.assertEqual(client.get("/api/admin/games").status_code, 200)

            admin_room_payload = {
                "fixtureId": 616161,
                "participant1": "France",
                "participant2": "Japan",
                "competition": "Admin replay",
                "colonies": [
                    {
                        "name": "Admin Scout",
                        "size": 20,
                        "style": "balanced",
                        "favoriteContext": "momentum",
                        "infoNeed": "medium",
                    },
                    {
                        "name": "Admin Guard",
                        "size": 10,
                        "style": "cautious",
                        "favoriteContext": "penalties",
                        "infoNeed": "high",
                    },
                    {
                        "name": "Admin Rush",
                        "size": 50,
                        "style": "aggressive",
                        "favoriteContext": "chaos",
                        "infoNeed": "low",
                    }
                ],
            }
            open_admin_room = client.post("/api/admin/rooms", json=admin_room_payload)
            self.assertEqual(open_admin_room.status_code, 200)
            admin_room = open_admin_room.json()
            self.assertEqual(admin_room["fixtureId"], 616161)
            self.assertEqual(len(admin_room["colonies"]), 3)
            self.assertEqual([colony["name"] for colony in admin_room["colonies"]], ["Admin Scout", "Admin Guard", "Admin Rush"])

    def test_admin_replay_fixtures_only_returns_matches_with_score_data(self):
        class FakeTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                start = int((datetime.now(timezone.utc) - timedelta(hours=3)).timestamp())
                return [
                    {
                        "FixtureId": 701,
                        "StartTime": start,
                        "Competition": "World Cup Demo",
                        "CompetitionId": competition_id or 1,
                        "Participant1": "France",
                        "Participant2": "Brazil",
                    },
                    {
                        "FixtureId": 702,
                        "StartTime": start - 60,
                        "Competition": "World Cup Demo",
                        "CompetitionId": competition_id or 1,
                        "Participant1": "Japan",
                        "Participant2": "Ghana",
                    },
                ]

            async def score_historical(self, fixture_id):
                if fixture_id == 702:
                    return [{"FixtureId": fixture_id, "Seq": 1, "Action": "goal"}]
                return []

            async def score_updates(self, fixture_id):
                return []

            async def score_snapshot(self, fixture_id):
                return []

        client = TestClient(app)
        with patch("app.main.TxLineClient", FakeTxLineClient):
            response = client.get("/api/admin/replay-fixtures?days=1&limit=5&scan_limit=5")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["fixtures"][0]["fixtureId"], 702)
        self.assertEqual(data["fixtures"][0]["eventCount"], 1)
        self.assertEqual(data["fixtures"][0]["source"], "historical")

    def test_previous_tx_run_uses_latest_fixture_with_score_data(self):
        class FakeTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                start = int((datetime.now(timezone.utc) - timedelta(hours=3)).timestamp())
                return [
                    {
                        "FixtureId": 777,
                        "StartTime": start,
                        "Competition": "World Cup Demo",
                        "CompetitionId": competition_id or 1,
                        "Participant1": "Argentina",
                        "Participant2": "Morocco",
                    }
                ]

            async def score_historical(self, fixture_id):
                return [
                    {
                        "FixtureId": fixture_id,
                        "Seq": 1,
                        "Action": "high_danger_possession",
                        "Participant": 1,
                        "Possession": 1,
                        "Clock": {"seconds": 600},
                    },
                    {
                        "FixtureId": fixture_id,
                        "Seq": 2,
                        "Action": "goal",
                        "Participant": 1,
                        "Confirmedd": True,
                        "Clock": {"seconds": 650},
                        "Score": {"Participant1": {"Total": {"Goals": 1}}, "Participant2": {"Total": {"Goals": 0}}},
                    },
                ]

            async def score_updates(self, fixture_id):
                return []

            async def score_snapshot(self, fixture_id):
                return []

        client = TestClient(app)
        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")), patch("app.main.TxLineClient", FakeTxLineClient):
            response = client.post("/api/games/run-previous", json={"days": 1, "limit": 5, "competitionId": 42, "seed": 11})

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertEqual(game["fixtureId"], 777)
        self.assertEqual(game["participant1"], "Argentina")
        self.assertEqual(game["participant2"], "Morocco")
        self.assertEqual(game["status"], "finished")
        self.assertEqual(len(game["colonies"]), 3)

    def test_previous_tx_run_can_stream_replay_events(self):
        class FakeTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                start = int((datetime.now(timezone.utc) - timedelta(hours=3)).timestamp())
                return [
                    {
                        "FixtureId": 778,
                        "StartTime": start,
                        "Competition": "World Cup Demo",
                        "CompetitionId": competition_id or 1,
                        "Participant1": "Japan",
                        "Participant2": "Ghana",
                    }
                ]

            async def score_historical(self, fixture_id):
                return [
                    {
                        "FixtureId": fixture_id,
                        "Seq": 1,
                        "Action": "high_danger_possession",
                        "Participant": 1,
                        "Possession": 1,
                        "Clock": {"seconds": 600},
                    },
                    {
                        "FixtureId": fixture_id,
                        "Seq": 2,
                        "Action": "goal",
                        "Participant": 1,
                        "Confirmedd": True,
                        "Clock": {"seconds": 650},
                        "Score": {"Participant1": {"Total": {"Goals": 1}}, "Participant2": {"Total": {"Goals": 0}}},
                    },
                ]

            async def score_updates(self, fixture_id):
                return []

            async def score_snapshot(self, fixture_id):
                return []

        scheduled = []

        def fake_schedule(room, events, *, delay_seconds=0.0, time_scale=None):
            scheduled.append(
                {
                    "gameId": room.game_id,
                    "events": events,
                    "delaySeconds": delay_seconds,
                    "timeScale": time_scale,
                    "colonyNames": [colony.name for colony in room.colonies.values()],
                }
            )

        client = TestClient(app)
        with (
            patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")),
            patch("app.main.TxLineClient", FakeTxLineClient),
            patch("app.main._schedule_replay_task", fake_schedule),
        ):
            response = client.post(
                "/api/games/run-previous",
                json={
                    "days": 1,
                    "limit": 5,
                    "competitionId": 42,
                    "seed": 11,
                    "stream": True,
                    "replayDelaySeconds": 0.8,
                    "replayTimeScale": 120,
                    "colonies": [
                        {
                            "name": "Admin Scout",
                            "size": 20,
                            "style": "balanced",
                            "favoriteContext": "momentum",
                            "infoNeed": "medium",
                        }
                    ],
                },
            )

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertEqual(game["fixtureId"], 778)
        self.assertEqual(game["status"], "running_replay")
        self.assertEqual(game["eventIndex"], 0)
        self.assertEqual(len(game["colonies"]), 1)
        self.assertEqual(game["colonies"][0]["name"], "Admin Scout")
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(len(scheduled[0]["events"]), 2)
        self.assertEqual(scheduled[0]["delaySeconds"], 0.8)
        self.assertEqual(scheduled[0]["timeScale"], 120)
        self.assertEqual(scheduled[0]["colonyNames"], ["Admin Scout"])

    def test_replay_delay_uses_scaled_match_clock_with_fixed_fallback(self):
        self.assertAlmostEqual(
            _replay_delay_after_event(
                [{"clockSeconds": 600}, {"clockSeconds": 660}],
                0,
                delay_seconds=0.8,
                time_scale=120,
            ),
            0.5,
        )
        self.assertEqual(
            _replay_delay_after_event(
                [{"clockSeconds": 600}, {"clockSeconds": 5000}],
                0,
                delay_seconds=0.8,
                time_scale=1,
            ),
            8.0,
        )
        self.assertEqual(
            _replay_delay_after_event(
                [{"action": "attack"}, {"action": "goal"}],
                0,
                delay_seconds=0.8,
                time_scale=120,
            ),
            0.8,
        )

    def test_rerun_clones_colonies_and_starts_new_replay(self):
        class FakeTxLineClient:
            async def score_historical(self, fixture_id):
                return [
                    {
                        "FixtureId": fixture_id,
                        "Seq": 1,
                        "Action": "high_danger_possession",
                        "Participant": 1,
                        "Possession": 1,
                        "Clock": {"seconds": 600},
                    },
                    {
                        "FixtureId": fixture_id,
                        "Seq": 2,
                        "Action": "goal",
                        "Participant": 1,
                        "Confirmedd": True,
                        "Clock": {"seconds": 650},
                        "Score": {"Participant1": {"Total": {"Goals": 1}}, "Participant2": {"Total": {"Goals": 0}}},
                    },
                ]

            async def score_updates(self, fixture_id):
                return []

            async def score_snapshot(self, fixture_id):
                return []

        client = TestClient(app)
        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")), patch("app.main.TxLineClient", FakeTxLineClient):
            created = client.post(
                "/api/games",
                json={"fixtureId": 777, "participant1": "Argentina", "participant2": "Morocco", "seed": 11},
            ).json()
            client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={"name": "A", "size": 50, "style": "cautious", "favoriteContext": "penalties", "infoNeed": "medium"},
            )
            response = client.post(f"/api/games/{created['gameId']}/rerun", json={"mode": "replay", "source": "historical"})

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertNotEqual(game["gameId"], created["gameId"])
        self.assertEqual(game["fixtureId"], 777)
        self.assertEqual(len(game["colonies"]), 1)
        self.assertIn(game["status"], {"running_replay", "finished"})


if __name__ == "__main__":
    unittest.main()
