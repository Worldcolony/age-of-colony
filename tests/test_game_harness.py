import asyncio
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.game.agents import AgentDecisionError, OpenRouterColonyAgent, OpenRouterSettings
from app.main import (
    StartGameRequest,
    _admin_room_request_cache,
    app,
    _finish_live_game,
    _fetch_score_sources,
    _ensure_room_log_hydrated,
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
    _start_replay_room,
    _stored_game_can_resume_live,
    _sync_live_match_state_from_timeline,
    game_manager,
)
from app.game.harness import (
    BASELINE_MARKET_CONTEXTS,
    PRIVATE_SNAPSHOT_KEY,
    GameHarness,
    GameManager,
    MARKET_RISK_SUGAR,
    MAX_RESERVED_SUGAR,
    STARTING_COLONY_ANTS,
    STARTING_COLONY_FOOD,
    STARTING_COLONY_SUGAR,
    STYLE_ENTRY_THRESHOLDS,
    ant_bet_history,
    build_info_packet,
    build_opportunity,
    build_opportunities,
    create_prediction,
    info_cost_for_colony,
    opportunity_options,
    run_vote,
    should_buy_info,
)
from app.persistence import SupabaseGameStore, SupabasePersistenceSettings


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


def vote_for_option(colony, opportunity, *, option_index=0, support_count=20, active_count=20, weight=1.0):
    """Build a raw ant ballot for deterministic Sugar V0 entry tests."""
    predictions = {option.option_id: [] for option in opportunity.options}
    predictions[opportunity.options[option_index].option_id] = [
        {"antId": ant.ant_id, "weight": weight}
        for ant in colony.ants[:support_count]
    ]
    return {
        "activeCount": active_count,
        "predictions": predictions,
        "infoRequests": [],
    }


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
        rewards = {option.label: option.reward_sugar for option in opportunity.options}
        self.assertEqual(rewards["yes, penalty scored"], 1)
        self.assertEqual(rewards["no, missed or saved"], 5)
        self.assertTrue(all(option.risk_sugar == MARKET_RISK_SUGAR for option in opportunity.options))
        public_options = opportunity.public_state()["options"]
        self.assertTrue(all(option["riskSugar"] == MARKET_RISK_SUGAR for option in public_options))
        self.assertEqual([option["rewardSugar"] for option in public_options], [1, 5])

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
        public = colony.public_state(0)

        self.assertEqual(colony.size, STARTING_COLONY_ANTS)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)
        self.assertEqual(len(colony.ants), STARTING_COLONY_ANTS)
        self.assertEqual(colony.ants[0].ant_id, "ant_0000")
        self.assertEqual(colony.ants[-1].ant_id, "ant_0019")
        self.assertTrue(all(not ant.ant_id.startswith(colony.colony_id) for ant in colony.ants))
        self.assertEqual(public["sugar"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["food"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["score"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["sugarReserved"], 0)
        self.assertEqual(public["sugarAvailable"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["economy"]["currency"], "sugar")
        self.assertEqual(
            archetypes,
            {"cautious", "balanced", "data_first", "opportunist", "momentum", "chaos"},
        )
        self.assertTrue(any(ant.risk_appetite > 0.55 for ant in colony.ants))

    def test_sugar_v0_keeps_all_twenty_ants_active_without_wounds_or_deaths(self):
        _, harness = self.make_room()
        colony = harness.add_colony(
            name="Risk Nest",
            size=10,
            style="balanced",
            favorite_context="momentum",
            info_need="medium",
        )
        colony.ants[0].engaged_prediction_ids.add("pred_open")

        active_ids = [ant.ant_id for ant in colony.active_ants(1)]
        public = colony.public_state(1)

        self.assertIn("ant_0000", active_ids)
        self.assertEqual(len(active_ids), STARTING_COLONY_ANTS)
        self.assertEqual(public["antsAlive"], STARTING_COLONY_ANTS)
        self.assertEqual(public["antsActive"], STARTING_COLONY_ANTS)
        self.assertEqual(public["antsEngaged"], 0)
        self.assertEqual(public["antsWounded"], 0)
        self.assertEqual(public["antsDead"], 0)
        self.assertEqual(public["antsBorn"], 0)
        self.assertEqual(public["larvae"], 0)

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
        self.assertEqual(len(predictions), 5)
        ant_usage = Counter(ant_id for prediction in predictions for ant_id in prediction.ant_ids)
        self.assertTrue(any(count > 1 for count in ant_usage.values()))
        self.assertTrue(all(prediction.reserved_food == MARKET_RISK_SUGAR for prediction in predictions))
        self.assertEqual(colony.food_reserved, MAX_RESERVED_SUGAR)
        prediction_logs = [event for event in room.log if event.kind == "prediction"]
        self.assertEqual(len(prediction_logs), 5)
        self.assertTrue(all(event.data["riskSugar"] == MARKET_RISK_SUGAR for event in prediction_logs))
        self.assertTrue(all(event.data["entryThreshold"] == STYLE_ENTRY_THRESHOLDS["balanced"] for event in prediction_logs))
        self.assertTrue(all(event.data["consensus"] == 1.0 for event in prediction_logs))
        self.assertEqual(colony.public_state(room.event_index)["antsEngaged"], 0)

    def test_sugar_v0_has_no_upkeep_starvation_or_larvae_progression(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Stable Nest", 20, "balanced", "momentum", "medium")

        for seq in range(1, 121):
            harness.process_event(
                {
                    "fixtureId": 42,
                    "seq": seq,
                    "action": "clock_tick",
                    "minute": seq // 2,
                    "clockSeconds": seq * 30,
                    "description": "Clock tick",
                }
            )

        public = colony.public_state(room.event_index)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)
        self.assertEqual(public["sugar"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["score"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["antsAlive"], STARTING_COLONY_ANTS)
        self.assertEqual(public["antsDead"], 0)
        self.assertEqual(public["antsWounded"], 0)
        self.assertEqual(public["antsBorn"], 0)
        self.assertEqual(public["larvae"], 0)
        self.assertFalse([event for event in room.log if event.kind in {"starvation", "hatch"}])

    def test_style_entry_thresholds_use_raw_vote_counts_and_are_inclusive(self):
        room, harness = self.make_room()
        opportunity = build_opportunities(
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
        )[0]
        minimum_support = {"cautious": 14, "balanced": 12, "aggressive": 11}

        self.assertEqual(
            STYLE_ENTRY_THRESHOLDS,
            {"cautious": 0.70, "balanced": 0.60, "aggressive": 0.51},
        )
        for style, support_count in minimum_support.items():
            with self.subTest(style=style):
                colony = harness.add_colony(f"{style} threshold", 20, style, "momentum", "medium")
                below = create_prediction(
                    colony,
                    opportunity,
                    vote_for_option(colony, opportunity, support_count=support_count - 1),
                    1,
                    bought_info=False,
                )
                at_or_above = create_prediction(
                    colony,
                    opportunity,
                    vote_for_option(colony, opportunity, support_count=support_count),
                    1,
                    bought_info=False,
                )
                self.assertIsNone(below)
                self.assertIsNotNone(at_or_above)
                self.assertEqual(len(at_or_above.ant_ids), support_count)
                self.assertEqual(at_or_above.reserved_food, MARKET_RISK_SUGAR)
                self.assertEqual(at_or_above.entry_threshold, STYLE_ENTRY_THRESHOLDS[style])
                self.assertAlmostEqual(at_or_above.support_fraction, support_count / STARTING_COLONY_ANTS)

        raw_count_colony = harness.add_colony("Raw Count", 20, "balanced", "momentum", "medium")
        raw_vote = vote_for_option(raw_count_colony, opportunity, support_count=12, weight=0.01)
        raw_vote["predictions"][opportunity.options[1].option_id] = [
            {"antId": ant.ant_id, "weight": 100.0}
            for ant in raw_count_colony.ants[12:20]
        ]
        raw_prediction = create_prediction(
            raw_count_colony,
            opportunity,
            raw_vote,
            1,
            bought_info=False,
        )
        self.assertIsNotNone(raw_prediction)
        self.assertEqual(raw_prediction.option.option_id, opportunity.options[0].option_id)
        self.assertEqual(len(raw_prediction.ant_ids), 12)

    def test_market_entry_reserves_two_sugar_caps_at_ten_and_void_releases(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Five Markets", 20, "balanced", "momentum", "medium")
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

        opened = []
        for opportunity in opportunities:
            prediction = create_prediction(
                colony,
                opportunity,
                vote_for_option(colony, opportunity, support_count=12),
                1,
                bought_info=False,
            )
            self.assertIsNotNone(prediction)
            self.assertEqual(prediction.reserved_food, MARKET_RISK_SUGAR)
            room.opportunities[opportunity.opportunity_id] = opportunity
            room.predictions[prediction.prediction_id] = prediction
            opened.append((prediction, opportunity))

        self.assertEqual(MARKET_RISK_SUGAR, 2)
        self.assertEqual(MAX_RESERVED_SUGAR, 10)
        self.assertEqual(colony.food_reserved, MAX_RESERVED_SUGAR)
        self.assertEqual(colony.public_state(1)["sugarAvailable"], 10)
        self.assertEqual(len([prediction for prediction in room.predictions.values() if not prediction.resolved]), 5)

        extra_opportunity = build_opportunity(penalty_event(seq=2), 2, room.match_state)
        blocked = create_prediction(
            colony,
            extra_opportunity,
            vote_for_option(colony, extra_opportunity, support_count=12),
            2,
            bought_info=False,
        )
        self.assertIsNone(blocked)

        first_prediction, first_opportunity = opened[0]
        harness._void_prediction(first_prediction, first_opportunity, reason="test")
        self.assertEqual(colony.food_reserved, MAX_RESERVED_SUGAR - MARKET_RISK_SUGAR)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)
        self.assertEqual(colony.public_state(2)["score"], STARTING_COLONY_SUGAR)
        self.assertEqual(room.log[-1].kind, "void")
        self.assertEqual(room.log[-1].data["riskSugar"], MARKET_RISK_SUGAR)
        self.assertEqual(room.log[-1].data["sugarReserved"], MARKET_RISK_SUGAR)

        replacement = create_prediction(
            colony,
            extra_opportunity,
            vote_for_option(colony, extra_opportunity, support_count=12),
            2,
            bought_info=False,
        )
        self.assertIsNotNone(replacement)
        self.assertEqual(colony.food_reserved, MAX_RESERVED_SUGAR)

    def test_supporting_ant_count_does_not_scale_sugar_reward_or_loss(self):
        room, harness = self.make_room()
        opportunity = build_opportunities(
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
        )[0]

        winners = [
            harness.add_colony("Twelve Supporters", 20, "balanced", "momentum", "medium"),
            harness.add_colony("Twenty Supporters", 20, "balanced", "momentum", "medium"),
        ]
        winner_predictions = [
            create_prediction(
                colony,
                opportunity,
                vote_for_option(colony, opportunity, support_count=support_count),
                1,
                bought_info=False,
            )
            for colony, support_count in zip(winners, (12, 20))
        ]
        self.assertEqual([len(prediction.ant_ids) for prediction in winner_predictions], [12, 20])
        for prediction in winner_predictions:
            harness._apply_settlement(prediction, opportunity, win=True, reason="test")
        self.assertEqual([colony.food for colony in winners], [24, 24])
        self.assertEqual([colony.public_state(1)["score"] for colony in winners], [24, 24])

        losers = [
            harness.add_colony("Twelve Losers", 20, "balanced", "momentum", "medium"),
            harness.add_colony("Twenty Losers", 20, "balanced", "momentum", "medium"),
        ]
        loser_predictions = [
            create_prediction(
                colony,
                opportunity,
                vote_for_option(colony, opportunity, support_count=support_count),
                1,
                bought_info=False,
            )
            for colony, support_count in zip(losers, (12, 20))
        ]
        self.assertEqual([len(prediction.ant_ids) for prediction in loser_predictions], [12, 20])
        for prediction in loser_predictions:
            harness._apply_settlement(prediction, opportunity, win=False, reason="test")
        self.assertEqual([colony.food for colony in losers], [18, 18])
        self.assertEqual([colony.public_state(1)["score"] for colony in losers], [18, 18])

    def test_market_reward_sugar_table_is_integer_and_risk_is_fixed(self):
        expected = {
            "penalties": {"penalty_goal": 1, "penalty_no_goal": 5},
            "goal_next_10": {"goal_next_10_yes": 4, "goal_next_10_no": 1},
            "next_goal_team": {"next_goal_p1": 4, "next_goal_p2": 4, "next_goal_none": 1},
            "next_corner": {"next_corner_p1": 2, "next_corner_p2": 2, "next_corner_none": 1},
            "next_free_kick": {"next_free_kick_p1": 2, "next_free_kick_p2": 2, "next_free_kick_none": 1},
            "next_yellow_card": {
                "next_yellow_card_p1": 3,
                "next_yellow_card_p2": 3,
                "next_yellow_card_none": 1,
            },
            "next_foul": {"next_foul_p1": 2, "next_foul_p2": 2},
        }

        for context, rewards in expected.items():
            with self.subTest(context=context):
                options = opportunity_options(context, "France", "Belgium")
                self.assertEqual({option.option_id: option.reward_sugar for option in options}, rewards)
                self.assertTrue(all(isinstance(option.reward_sugar, int) for option in options))
                self.assertTrue(all(option.risk_sugar == MARKET_RISK_SUGAR for option in options))

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
        room.agent_call_mode = "batch"
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
        self.assertEqual(first_call["context"]["rules"]["agentCallMode"], "batch")
        self.assertEqual(room.public_state()["agentCallMode"], "batch")

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

    def test_anonymous_owner_and_player_identity_are_not_public(self):
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
        self.assertEqual(
            public["owner"],
            {"wallet": None, "name": "Tanguy"},
        )
        self.assertEqual(
            public["players"],
            [{"playerId": player.player_id, "name": "Tanguy", "isHost": True}],
        )
        self.assertEqual(room.owner_anonymous_id, "anon_browser_1")
        self.assertEqual(player.anonymous_id, "anon_browser_1")

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

    def test_live_tactics_are_unavailable_and_cannot_change_sugar_v0_position(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Tactics Nest", 20, "balanced", "penalties", "medium")
        room.status = "running_live"
        opportunity = build_opportunity(penalty_event(), 1, room.match_state)
        prediction = create_prediction(
            colony,
            opportunity,
            vote_for_option(colony, opportunity, support_count=12),
            1,
            bought_info=False,
        )
        self.assertIsNotNone(prediction)
        room.predictions[prediction.prediction_id] = prediction
        room.opportunities[opportunity.opportunity_id] = opportunity
        starting_ant_ids = list(prediction.ant_ids)

        for action in (
            lambda: harness.rally(colony.colony_id, opportunity.opportunity_id),
            lambda: harness.recall(colony.colony_id, opportunity.opportunity_id),
            lambda: harness.switch_call(colony.colony_id, opportunity.opportunity_id, opportunity.options[1].option_id),
        ):
            with self.assertRaisesRegex(ValueError, "unavailable in Sugar V0"):
                action()

        self.assertEqual(prediction.ant_ids, starting_ant_ids)
        self.assertEqual(prediction.reserved_food, MARKET_RISK_SUGAR)
        self.assertEqual(colony.food_reserved, MARKET_RISK_SUGAR)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)

    def test_public_economy_uses_sugar_aliases_and_score_is_current_balance(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Economy Nest", 20, "balanced", "momentum", "medium")
        initial = colony.public_state(room.event_index)

        self.assertEqual(initial["sugar"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["food"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["score"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["sugarReserved"], 0)
        self.assertEqual(initial["sugarAvailable"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["sugarNet"], 0)
        self.assertEqual(initial["economy"]["currency"], "sugar")
        self.assertEqual(initial["economy"]["balance"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["economy"]["reserved"], 0)
        self.assertEqual(initial["economy"]["available"], STARTING_COLONY_SUGAR)
        self.assertEqual(initial["economy"]["net"], 0)
        self.assertFalse(initial["economy"]["upkeepEnabled"])
        self.assertEqual(initial["economy"]["upkeepCost"], 0)
        self.assertEqual(initial["economy"]["riskPerMarket"], MARKET_RISK_SUGAR)
        self.assertEqual(initial["economy"]["maxReserved"], MAX_RESERVED_SUGAR)

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

        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)
        self.assertEqual(colony.memory.food_net, 0)
        self.assertEqual(public["sugar"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["food"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["score"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["economy"]["balance"], STARTING_COLONY_SUGAR)
        self.assertEqual(public["economy"]["net"], 0)

    def test_restored_room_keeps_sugar_and_strategy_but_resets_v0_population(self):
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
            "agentCallMode": "per_ant",
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
                    "sugar": 18,
                    "sugarNet": -2,
                    "food": 18,
                    "foodNet": -2,
                    "larvae": 0,
                    "antsAlive": 20,
                    "wins": 2,
                    "losses": 1,
                    "infoPurchases": 1,
                    "economy": {"currency": "sugar", "balance": 18, "net": -2},
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
        self.assertEqual(room.agent_call_mode, "per_ant")
        self.assertEqual(room.public_state()["agentCallMode"], "per_ant")
        self.assertEqual(colony.food, 18)
        self.assertEqual(colony.seed, 98765)
        self.assertEqual(colony.memory.food_net, -2)
        self.assertEqual(len(colony.alive_ants), STARTING_COLONY_ANTS)
        self.assertEqual(colony.public_state(room.event_index)["sugar"], 18)
        self.assertEqual(colony.public_state(room.event_index)["score"], 18)
        self.assertEqual(colony.public_state(room.event_index)["larvae"], 0)
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

    def test_terminal_restored_room_keeps_original_public_snapshot(self):
        game_id = "game_restore_terminal_snapshot"
        room_code = "991235"
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "fixtureId": 43,
            "participant1": "France",
            "participant2": "Japan",
            "status": "stopped",
            "mode": "live",
            "eventIndex": 72,
            "players": [],
            "colonies": [
                {
                    "colonyId": "col_terminal",
                    "name": "Snapshot Nest",
                    "size": 20,
                    "antsAlive": 22,
                    "antsBorn": 4,
                    "antsWounded": 3,
                    "food": 15,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                }
            ],
            "activeOpportunities": [{"opportunityId": "opp_terminal", "label": "Stored market"}],
            "match": {"score": {"participant1": 2, "participant2": 1}, "gameState": "second_half"},
            "agentUsage": {"apiCalls": 42},
            "logCount": 18,
        }
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)

        room = _restore_room_from_stored_row({"game_id": game_id, "public_state": public_state}, events=[])
        restored = room.public_state()

        self.assertEqual(restored["match"], public_state["match"])
        self.assertEqual(restored["colonies"], public_state["colonies"])
        self.assertEqual(restored["activeOpportunities"], public_state["activeOpportunities"])
        self.assertEqual(restored["agentUsage"], public_state["agentUsage"])
        self.assertEqual(restored["eventIndex"], 72)
        self.assertEqual(restored["logCount"], 18)

    def test_explicit_start_clears_restored_terminal_snapshot(self):
        game_id = "game_restart_terminal_snapshot"
        room_code = "991236"
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "roomKind": "admin",
            "fixtureId": "demo-sandbox-previous",
            "participant1": "Old Home",
            "participant2": "Old Away",
            "status": "stopped",
            "mode": "live",
            "eventIndex": 10,
            "players": [],
            "colonies": [
                {
                    "colonyId": "col_restart",
                    "name": "Restart Nest",
                    "size": 20,
                    "antsAlive": 20,
                    "food": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                }
            ],
            "activeOpportunities": [],
            "match": {"score": {"participant1": 1, "participant2": 0}},
            "logCount": 3,
        }
        room = _restore_room_from_stored_row({"game_id": game_id, "public_state": public_state}, events=[])
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)
        self.addCleanup(game_manager.replay_tasks.pop, game_id, None)
        room.match_state.score = {"participant1": 3, "participant2": 2}

        async def fake_sync(target_room):
            return {"stored": True, "gameId": target_room.game_id, "eventCount": len(target_room.log)}

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._sync_room_to_supabase_async", fake_sync),
            patch("app.main._schedule_replay_task") as schedule,
        ):
            response = TestClient(app).post(f"/api/games/{game_id}/start", json={"mode": "replay", "source": "demo"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "running_replay")
        self.assertEqual(response.json()["match"]["score"], {"participant1": 3, "participant2": 2})
        schedule.assert_called_once()
        self.assertFalse(hasattr(room, "_aoc_restored_terminal"))
        self.assertFalse(hasattr(room, "_aoc_restored_public_state"))

    def test_failed_start_keeps_restored_terminal_snapshot(self):
        game_id = "game_failed_restart_snapshot"
        room_code = "991237"
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "roomKind": "admin",
            "fixtureId": "no-demo-for-this-fixture",
            "participant1": "Home",
            "participant2": "Away",
            "status": "stopped",
            "mode": "live",
            "eventIndex": 8,
            "players": [],
            "colonies": [
                {
                    "colonyId": "col_failed_restart",
                    "name": "Preserved Nest",
                    "size": 20,
                    "antsAlive": 20,
                    "food": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                }
            ],
            "activeOpportunities": [],
            "match": {"score": {"participant1": 2, "participant2": 0}},
            "logCount": 2,
        }
        room = _restore_room_from_stored_row({"game_id": game_id, "public_state": public_state}, events=[])
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)

        with patch("app.main._ensure_deepseek_agent"):
            response = TestClient(app).post(f"/api/games/{game_id}/start", json={"mode": "replay", "source": "demo"})

        self.assertEqual(response.status_code, 422)
        self.assertTrue(hasattr(room, "_aoc_restored_terminal"))
        self.assertTrue(hasattr(room, "_aoc_restored_public_state"))
        self.assertEqual(room.public_state()["match"], public_state["match"])

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

    def test_goal_next_ten_expires_before_boundary_goal_but_next_goal_still_resolves(self):
        for goal_clock, expected_window_reason, expected_window_win in (
            (1199, "resolved", True),
            (1200, "expired", False),
            (1201, "expired", False),
        ):
            with self.subTest(goal_clock=goal_clock):
                room, harness = self.make_room()
                colony = harness.add_colony("Boundary Nest", 20, "balanced", "momentum", "medium")
                source_event = {
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
                opportunities = build_opportunities(source_event, 1, room.match_state)
                goal_window = next(item for item in opportunities if item.context == "goal_next_10")
                next_goal = next(item for item in opportunities if item.context == "next_goal_team")
                room.event_index = 1

                predictions = {}
                for opportunity in (goal_window, next_goal):
                    room.opportunities[opportunity.opportunity_id] = opportunity
                    prediction = create_prediction(
                        colony,
                        opportunity,
                        vote_for_option(colony, opportunity, option_index=0, support_count=12),
                        1,
                        bought_info=False,
                    )
                    self.assertIsNotNone(prediction)
                    room.predictions[prediction.prediction_id] = prediction
                    predictions[opportunity.context] = prediction

                harness.process_event(
                    {
                        "fixtureId": 42,
                        "seq": 2,
                        "action": "goal",
                        "highlights": ["goal"],
                        "minute": goal_clock // 60,
                        "clockSeconds": goal_clock,
                        "participant": 1,
                        "participantLabel": "France",
                        "score": {"participant1": 1, "participant2": 0},
                        "confirmed": True,
                        "description": "Goal - France - confirmed",
                    }
                )

                settlements = {
                    event.data.get("predictionId"): event
                    for event in room.log
                    if event.kind == "settlement"
                }
                window_settlement = settlements[predictions["goal_next_10"].prediction_id]
                next_goal_settlement = settlements[predictions["next_goal_team"].prediction_id]
                self.assertEqual(window_settlement.data.get("reason"), expected_window_reason)
                self.assertEqual(window_settlement.data.get("win"), expected_window_win)
                self.assertEqual(next_goal_settlement.data.get("reason"), "resolved")
                self.assertTrue(next_goal_settlement.data.get("win"))

    def test_goal_next_ten_event_fallback_expires_before_exact_deadline_event(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Event Boundary Nest", 20, "balanced", "momentum", "medium")
        source_event = {
            "fixtureId": 42,
            "seq": 1,
            "action": "high_danger_possession",
            "highlights": [],
            "minute": 10,
            "participant": 1,
            "participantLabel": "France",
            "possession": 1,
            "possessionLabel": "France",
            "description": "High danger possession - France",
        }
        goal_window = next(
            item
            for item in build_opportunities(source_event, 1, room.match_state)
            if item.context == "goal_next_10"
        )
        room.opportunities[goal_window.opportunity_id] = goal_window
        prediction = create_prediction(
            colony,
            goal_window,
            vote_for_option(colony, goal_window, option_index=0, support_count=12),
            1,
            bought_info=False,
        )
        self.assertIsNotNone(prediction)
        room.predictions[prediction.prediction_id] = prediction
        room.event_index = prediction.deadline_event_index - 1

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 57,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 20,
                "participant": 1,
                "participantLabel": "France",
                "score": {"participant1": 1, "participant2": 0},
                "confirmed": True,
                "description": "Goal - France - confirmed",
            }
        )

        settlement = next(
            event
            for event in room.log
            if event.kind == "settlement" and event.data.get("predictionId") == prediction.prediction_id
        )
        self.assertEqual(settlement.data.get("reason"), "expired")
        self.assertFalse(settlement.data.get("win"))

    def test_unentered_markets_log_closure_and_do_not_block_a_later_slot(self):
        room, harness = self.make_room()
        colony = harness.add_colony("Multi Market Nest", 20, "balanced", "momentum", "medium")
        source_event = {
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
        opportunities = build_opportunities(source_event, 1, room.match_state)
        selected = {
            opportunity.context: opportunity
            for opportunity in opportunities
            if opportunity.context in {"goal_next_10", "next_goal_team", "next_corner"}
        }
        room.event_index = 1
        for opportunity in selected.values():
            self.assertTrue(harness._claim_opportunity_slot(opportunity))
            room.opportunities[opportunity.opportunity_id] = opportunity
            room.add_log("opportunity", opportunity.label, {"opportunity": opportunity.public_state()})

        backed_market = selected["next_goal_team"]
        backed_prediction = create_prediction(
            colony,
            backed_market,
            vote_for_option(colony, backed_market, option_index=0, support_count=12),
            1,
            bought_info=False,
        )
        self.assertIsNotNone(backed_prediction)
        room.predictions[backed_prediction.prediction_id] = backed_prediction
        self.assertEqual(len(room.public_state()["activeOpportunities"]), 3)

        room.event_index = 2
        harness._clear_old_opportunities()

        self.assertEqual(
            {item["opportunityId"] for item in room.public_state()["activeOpportunities"]},
            {backed_market.opportunity_id},
        )
        closures = [event for event in room.log if event.kind == "market_closed"]
        self.assertEqual(
            {event.data.get("opportunityId") for event in closures},
            {
                selected["goal_next_10"].opportunity_id,
                selected["next_corner"].opportunity_id,
            },
        )
        self.assertTrue(all(event.data.get("reason") == "no_entries" for event in closures))
        self.assertTrue(all(event.data.get("positionCount") == 0 for event in closures))
        self.assertTrue(all(event.data.get("market", {}).get("opportunityId") for event in closures))

        room.event_index = 25
        replacement = next(
            item
            for item in build_opportunities({**source_event, "seq": 25, "clockSeconds": 1200}, 25, room.match_state)
            if item.context == "goal_next_10"
        )
        self.assertTrue(harness._claim_opportunity_slot(replacement))

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

    def test_successful_prediction_adds_fixed_sugar_reward_only(self):
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
        starting_sugar = colony.food
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
        self.assertEqual(starting_sugar, STARTING_COLONY_SUGAR)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR + 4)
        self.assertEqual(colony.public_state(room.event_index)["sugar"], STARTING_COLONY_SUGAR + 4)
        self.assertEqual(colony.public_state(room.event_index)["score"], STARTING_COLONY_SUGAR + 4)
        self.assertEqual(colony.larvae, 0)
        settlement = next(event for event in room.log if event.kind == "settlement")
        self.assertTrue(settlement.data.get("win"))
        self.assertEqual(settlement.data.get("resourceDelta"), 4)
        self.assertEqual(settlement.data.get("sugarDelta"), 4)
        self.assertEqual(settlement.data.get("rewardSugar"), 4)
        self.assertEqual(settlement.data.get("riskSugar"), MARKET_RISK_SUGAR)
        self.assertNotIn("dead", settlement.data)
        self.assertNotIn("wounded", settlement.data)

    def test_losing_prediction_removes_fixed_market_risk_only(self):
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
        starting_sugar = colony.food
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
        self.assertEqual(starting_sugar, STARTING_COLONY_SUGAR)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR - MARKET_RISK_SUGAR)
        self.assertEqual(public_state["sugar"], STARTING_COLONY_SUGAR - MARKET_RISK_SUGAR)
        self.assertEqual(public_state["score"], STARTING_COLONY_SUGAR - MARKET_RISK_SUGAR)
        self.assertEqual(settlement.data.get("resourceDelta"), -MARKET_RISK_SUGAR)
        self.assertEqual(settlement.data.get("sugarDelta"), -MARKET_RISK_SUGAR)
        self.assertEqual(settlement.data.get("riskSugar"), MARKET_RISK_SUGAR)
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

    def test_openrouter_room_call_mode_overrides_global_setting_and_otherwise_falls_back(self):
        cases = [
            ("per_ant", "batch", "batch"),
            ("batch", "per_ant", "per_ant"),
            ("batch", None, "batch"),
        ]
        for global_mode, room_mode, expected_mode in cases:
            with self.subTest(global_mode=global_mode, room_mode=room_mode):
                agent = OpenRouterColonyAgent(
                    OpenRouterSettings(
                        api_key="test-key",
                        model="deepseek/deepseek-v4-flash",
                        call_mode=global_mode,
                    )
                )
                context = {"rules": {"agentCallMode": room_mode}} if room_mode else {}
                with (
                    patch.object(agent, "_decide_ants_batch", return_value=[]) as batch,
                    patch.object(agent, "_decide_ants_per_ant", return_value=[]) as per_ant,
                ):
                    agent.decide_ants(
                        game_id="game-room-mode",
                        stage="pre_info",
                        context=context,
                        ants=[{"antId": "ant_1"}],
                    )

                if expected_mode == "batch":
                    batch.assert_called_once()
                    per_ant.assert_not_called()
                else:
                    per_ant.assert_called_once()
                    batch.assert_not_called()

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
            json={
                "fixtureId": 4242,
                "participant1": "Portugal",
                "participant2": "Brazil",
                "seed": 17,
                "anonymousId": "anon_room_setup_alice",
            },
        ).json()

        anonymous_id = "anon_room_setup_alice"
        joined = client.post(
            f"/api/games/{created['gameId']}/players",
            json={"name": "Alice", "anonymousId": anonymous_id},
        )
        self.assertEqual(joined.status_code, 200)
        self.assertEqual(joined.json()["players"][0]["name"], "Alice")

        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "A",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(colony_response.status_code, 200)
        colony_id = colony_response.json()["colonies"][0]["colonyId"]

        strategy_response = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/strategy",
            json={
                "style": "cautious",
                "favoriteContext": "penalties",
                "infoNeed": "high",
                "anonymousId": anonymous_id,
            },
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
            json={
                "fixtureId": 4243,
                "participant1": "Portugal",
                "participant2": "Brazil",
                "seed": 18,
                "anonymousId": "anon_owner_alice",
            },
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

    def test_market_action_endpoints_enforce_owner_and_disable_v0_tactics(self):
        room = game_manager.create_room(fixture_id=4244, participant1="Portugal", participant2="Brazil", seed=19)
        harness = game_manager.harness(room.game_id)
        harness.join_player("Alice", anonymous_id="anon_market_owner")
        colony = harness.add_colony(
            "Owner Nest",
            20,
            "balanced",
            "penalties",
            "medium",
            anonymous_id="anon_market_owner",
        )
        room.status = "running_live"
        opportunity = build_opportunity(penalty_event(fixtureId=4244), 1, room.match_state)
        safe_option, risky_option = opportunity.options
        vote = {
            "activeCount": 1,
            "predictions": {
                safe_option.option_id: [{"antId": colony.ants[0].ant_id, "weight": 1.0}],
                risky_option.option_id: [],
            },
            "infoRequests": [],
        }
        prediction = create_prediction(colony, opportunity, vote, 1, bought_info=False)
        self.assertIsNotNone(prediction)
        room.predictions[prediction.prediction_id] = prediction
        room.opportunities[opportunity.opportunity_id] = opportunity
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)

        async def fake_sync(target_room):
            return {"stored": True, "gameId": target_room.game_id, "eventCount": len(target_room.log)}

        client = TestClient(app)
        with patch("app.main._sync_room_to_supabase_async", fake_sync):
            blocked_rally = client.post(
                f"/api/games/{room.game_id}/rally",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "anonymousId": "anon_intruder",
                },
            )
            rally_response = client.post(
                f"/api/games/{room.game_id}/rally",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "anonymousId": "anon_market_owner",
                },
            )
            blocked_recall = client.post(
                f"/api/games/{room.game_id}/recall",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "anonymousId": "anon_intruder",
                },
            )
            recall_response = client.post(
                f"/api/games/{room.game_id}/recall",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "anonymousId": "anon_market_owner",
                },
            )
            blocked_switch = client.post(
                f"/api/games/{room.game_id}/switch-call",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "optionId": risky_option.option_id,
                    "anonymousId": "anon_intruder",
                },
            )
            switch_response = client.post(
                f"/api/games/{room.game_id}/switch-call",
                json={
                    "colonyId": colony.colony_id,
                    "opportunityId": opportunity.opportunity_id,
                    "optionId": risky_option.option_id,
                    "anonymousId": "anon_market_owner",
                },
            )

        self.assertEqual(blocked_rally.status_code, 403)
        self.assertEqual(rally_response.status_code, 422)
        self.assertIn("unavailable in Sugar V0", rally_response.json()["detail"])
        self.assertEqual(blocked_recall.status_code, 403)
        self.assertEqual(recall_response.status_code, 422)
        self.assertIn("unavailable in Sugar V0", recall_response.json()["detail"])
        self.assertEqual(blocked_switch.status_code, 403)
        self.assertEqual(switch_response.status_code, 422)
        self.assertIn("unavailable in Sugar V0", switch_response.json()["detail"])
        self.assertEqual(prediction.reserved_food, MARKET_RISK_SUGAR)
        self.assertEqual(colony.food_reserved, MARKET_RISK_SUGAR)
        self.assertEqual(colony.food, STARTING_COLONY_SUGAR)

    def test_live_ant_strategy_api_lists_updates_and_resets_owned_ant(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 4244,
                "participant1": "Japan",
                "participant2": "Brazil",
                "seed": 19,
                "anonymousId": "anon_ant_orders_owner",
            },
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
            json={
                "fixtureId": 4245,
                "participant1": "France",
                "participant2": "Belgium",
                "seed": 20,
                "anonymousId": "anon_ant_history_owner",
            },
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
        self.assertEqual(bet["foodAtRisk"], MARKET_RISK_SUGAR)
        self.assertEqual(bet["colonyFoodDelta"], 1)

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
                "anonymousId": "anon_alice",
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
        self.assertNotIn("playerAnonymousId", game["colonies"][0])

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

    def test_live_room_auto_starts_for_match_in_progress_and_rejects_late_join(self):
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
        self.assertEqual(late_join.status_code, 409)

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
        self.assertEqual(late_colony.status_code, 422)
        resumed_live_task.assert_not_called()

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

    def test_only_waiting_stored_live_game_can_resume(self):
        self.assertTrue(_stored_game_can_resume_live({"status": "waiting_kickoff"}))
        self.assertFalse(_stored_game_can_resume_live({"status": "running_live"}))
        self.assertFalse(_stored_game_can_resume_live({"status": "error", "mode": "live"}))
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

    def test_live_host_cannot_finish_before_verified_full_time(self):
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
        self.assertEqual(finished.status_code, 409)
        self.assertEqual(room.status, "running_live")
        self.assertFalse(any(event.kind == "game_finished" for event in room.log))

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
        self.assertEqual(game["agentCallMode"], "batch")
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

            blocked_ownerless_player_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Admin Only Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                },
            )
            self.assertEqual(blocked_ownerless_player_colony.status_code, 401)

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

    def test_admin_room_request_key_reuses_the_created_room(self):
        client = TestClient(app)
        request_key = "admin-idempotence-test-616162"
        self.addCleanup(_admin_room_request_cache.pop, request_key, None)
        payload = {
            "fixtureId": 616162,
            "participant1": "Argentina",
            "participant2": "Switzerland",
            "requestKey": request_key,
            "colonies": [
                {
                    "name": "Retry Nest",
                    "size": 10,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                }
            ],
        }
        room_count_before = len(game_manager.rooms)

        first = client.post("/api/admin/rooms", json=payload)
        second = client.post("/api/admin/rooms", json=payload)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["gameId"], first.json()["gameId"])
        self.assertEqual(second.json()["roomCode"], first.json()["roomCode"])
        self.assertEqual(len(second.json()["colonies"]), 1)
        self.assertEqual(len(game_manager.rooms), room_count_before + 1)

        conflicting = client.post(
            "/api/admin/rooms",
            json={**payload, "participant2": "Belgium"},
        )

        self.assertEqual(conflicting.status_code, 409)
        self.assertEqual(len(game_manager.rooms), room_count_before + 1)

    def test_mark_game_stopped_preserves_stored_snapshot(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        calls = []
        public_state = {
            "gameId": "game_snapshot_preserved",
            "status": "running_live",
            "mode": "live",
            "eventIndex": 44,
            "logCount": 12,
            "match": {"score": "2 - 1", "gameState": "second_half"},
            "colonies": [{"colonyId": "col_1", "antsAlive": 17}],
            "activeOpportunities": [{"opportunityId": "opp_1", "status": "open"}],
        }
        private_state = {
            "version": 1,
            "antProfiles": {"col_1": {"ant_0000": {"archetype": "balanced"}}},
        }

        def fake_request(path, *, method="GET", body=None, prefer=""):
            calls.append({"path": path, "method": method, "body": body, "prefer": prefer})
            if method == "GET":
                return [
                    {
                        "public_state": {
                            **public_state,
                            PRIVATE_SNAPSHOT_KEY: private_state,
                        }
                    }
                ]
            return [{"public_state": body["public_state"]}]

        store._request_json = fake_request
        stopped = store.mark_game_stopped(public_state)

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["method"], "GET")
        self.assertIn("select=public_state", calls[0]["path"])
        self.assertEqual(calls[1]["method"], "PATCH")
        self.assertIn("status=in.(running_replay,running_live)", calls[1]["path"])
        self.assertEqual(calls[1]["prefer"], "return=representation")
        self.assertEqual(stopped["status"], "stopped")
        self.assertEqual(stopped[PRIVATE_SNAPSHOT_KEY], private_state)
        for key in ("eventIndex", "logCount", "match", "colonies", "activeOpportunities"):
            self.assertEqual(stopped[key], public_state[key])

    def test_admin_games_flattens_supabase_rows_for_the_dashboard(self):
        class StoredAdminGames:
            configured = True

            def list_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 2,
                    "games": [
                        {
                            "game_id": "game_stored_admin",
                            "fixture_id": "4242",
                            "status": "finished",
                            "event_index": 18,
                            "public_state": {
                                "roomKind": "admin",
                                "participant1": "France",
                                "participant2": "Japan",
                                "colonies": [{"colonyId": "col_1", "name": "Stored Nest"}],
                            },
                        },
                        {"public_state": "invalid"},
                    ],
                }

        with (
            patch("app.main.supabase_store", StoredAdminGames()),
            patch.dict(game_manager.rooms, {}, clear=True),
            patch.dict(game_manager.room_codes, {}, clear=True),
        ):
            response = TestClient(app).get("/api/admin/games")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(len(payload["games"]), 1)
        game = payload["games"][0]
        self.assertEqual(game["gameId"], "game_stored_admin")
        self.assertEqual(game["fixtureId"], "4242")
        self.assertEqual(game["status"], "finished")
        self.assertEqual(game["eventIndex"], 18)
        self.assertEqual(game["colonies"][0]["name"], "Stored Nest")
        self.assertEqual(game["players"], [])
        self.assertEqual(game["activeOpportunities"], [])
        self.assertEqual(game["match"], {"score": None})

    def test_admin_games_prefers_newer_in_memory_state_over_stored_row(self):
        room = game_manager.create_room(
            fixture_id=919191,
            participant1="France",
            participant2="Japan",
            seed=91,
            room_kind="admin",
        )
        room.mode = "replay"
        room.status = "finished"
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)

        stale_state = room.public_state()
        stale_state["status"] = "running_replay"

        class StaleStoredAdminGames:
            configured = True

            def list_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 1,
                    "games": [
                        {
                            "game_id": room.game_id,
                            "fixture_id": str(room.fixture_id),
                            "status": "running_replay",
                            "mode": "replay",
                            "event_index": 0,
                            "public_state": stale_state,
                        }
                    ],
                }

        with (
            patch("app.main.supabase_store", StaleStoredAdminGames()),
            patch.dict(game_manager.rooms, {room.game_id: room}, clear=True),
            patch.dict(game_manager.room_codes, {room.room_code: room.game_id}, clear=True),
        ):
            response = TestClient(app).get("/api/admin/games")

        self.assertEqual(response.status_code, 200)
        games = response.json()["games"]
        self.assertEqual(len(games), 1)
        self.assertEqual(games[0]["gameId"], room.game_id)
        self.assertEqual(games[0]["status"], "finished")

    def test_admin_games_keeps_memory_only_room_visible_when_storage_missed_it(self):
        room = game_manager.create_room(
            fixture_id=919190,
            participant1="France",
            participant2="Belgium",
            seed=90,
            room_kind="admin",
        )
        room.mode = "replay"
        room.status = "running_replay"
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)

        class EmptyStoredAdminGames:
            configured = True

            def list_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 0,
                    "games": [],
                }

        with patch("app.main.supabase_store", EmptyStoredAdminGames()):
            response = TestClient(app).get("/api/admin/games?limit=1")

        self.assertEqual(response.status_code, 200)
        games = response.json()["games"]
        self.assertEqual(len(games), 1)
        self.assertEqual(games[0]["gameId"], room.game_id)
        self.assertEqual(games[0]["status"], "running_replay")

    def test_admin_games_limit_prefers_newer_stored_room_over_old_memory_room(self):
        room = game_manager.create_room(
            fixture_id=919196,
            participant1="Old",
            participant2="Memory",
            seed=96,
            room_kind="admin",
        )
        room.mode = "replay"
        room.status = "finished"
        room.log[-1].created_at = 1.0
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)

        stored_state = {
            "gameId": "game_newer_stored_admin",
            "roomKind": "admin",
            "fixtureId": 919197,
            "participant1": "Newer",
            "participant2": "Stored",
            "status": "finished",
            "mode": "replay",
            "eventIndex": 20,
            "players": [],
            "colonies": [],
            "activeOpportunities": [],
            "match": {"score": "1 - 0"},
        }

        class NewerStoredAdminGame:
            configured = True

            def list_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 1,
                    "games": [{"updated_at": "2030-01-01T00:00:00+00:00", "public_state": stored_state}],
                }

        with (
            patch("app.main.supabase_store", NewerStoredAdminGame()),
            patch.dict(game_manager.rooms, {room.game_id: room}, clear=True),
            patch.dict(game_manager.room_codes, {room.room_code: room.game_id}, clear=True),
        ):
            response = TestClient(app).get("/api/admin/games?limit=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["games"][0]["gameId"], stored_state["gameId"])

    def test_admin_games_stops_orphaned_replay_and_live_without_loading_events(self):
        game_id = "game_orphaned_admin_replay"
        room_code = "919192"
        public_state = {
            "gameId": game_id,
            "roomKind": "admin",
            "roomCode": room_code,
            "fixtureId": 919192,
            "participant1": "Brazil",
            "participant2": "Norway",
            "status": "running_replay",
            "mode": "replay",
            "eventIndex": 0,
            "players": [],
            "colonies": [],
            "activeOpportunities": [],
            "match": {"score": None},
            "logCount": 1,
        }
        stored_row = {
            "game_id": game_id,
            "fixture_id": "919192",
            "status": "running_replay",
            "mode": "replay",
            "seed": 92,
            "event_index": 0,
            "public_state": public_state,
        }
        live_state = {
            **public_state,
            "gameId": "game_orphaned_admin_live_list",
            "roomCode": "919194",
            "fixtureId": 919194,
            "status": "running_live",
            "mode": "live",
            "match": {"score": "1 - 0"},
        }
        live_row = {
            **stored_row,
            "game_id": live_state["gameId"],
            "fixture_id": str(live_state["fixtureId"]),
            "status": "running_live",
            "mode": "live",
            "public_state": live_state,
        }

        class OrphanedReplayStore:
            configured = True

            def __init__(self):
                self.marked_states = []

            def list_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 2,
                    "games": [stored_row, live_row],
                }

            def game_replay(self, requested_game_id):
                raise AssertionError(f"Admin list must not hydrate replay events for {requested_game_id}")

            def mark_game_stopped(self, state):
                self.marked_states.append(dict(state))
                return {**state, "status": "stopped"}

        store = OrphanedReplayStore()
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)
        self.addCleanup(game_manager.replay_tasks.pop, game_id, None)
        self.addCleanup(game_manager.rooms.pop, live_state["gameId"], None)
        self.addCleanup(game_manager.room_codes.pop, live_state["roomCode"], None)
        self.addCleanup(game_manager.live_tasks.pop, live_state["gameId"], None)

        with (
            patch("app.main.supabase_store", store),
            patch.dict(game_manager.rooms, {}, clear=True),
            patch.dict(game_manager.room_codes, {}, clear=True),
        ):
            response = TestClient(app).get("/api/admin/games")

        self.assertEqual(response.status_code, 200)
        games = response.json()["games"]
        self.assertEqual({game["gameId"] for game in games}, {game_id, live_state["gameId"]})
        self.assertTrue(all(game["status"] == "stopped" for game in games))
        self.assertEqual({state["gameId"] for state in store.marked_states}, {game_id, live_state["gameId"]})
        self.assertIsNone(game_manager.get_room(game_id))
        self.assertIsNone(game_manager.get_room(live_state["gameId"]))

    def test_admin_games_keeps_stored_live_error_for_diagnosis(self):
        public_state = {
            "gameId": "game_admin_live_error",
            "roomKind": "admin",
            "fixtureId": 919198,
            "status": "error",
            "mode": "live",
            "eventIndex": 9,
            "players": [],
            "colonies": [],
            "activeOpportunities": [],
            "match": {"score": "0 - 0"},
        }

        class StoredLiveErrorAdmin:
            configured = True

            def list_games(self, *, limit):
                return {"source": "supabase", "configured": True, "count": 1, "games": [{"public_state": public_state}]}

            def mark_game_stopped(self, state):
                raise AssertionError("Stored errors must remain errors for diagnosis.")

        with (
            patch("app.main.supabase_store", StoredLiveErrorAdmin()),
            patch.dict(game_manager.rooms, {}, clear=True),
            patch.dict(game_manager.room_codes, {}, clear=True),
        ):
            response = TestClient(app).get("/api/admin/games")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["games"][0]["status"], "error")

    def test_game_state_stops_restored_live_room_without_full_checkpoint(self):
        game_id = "game_orphaned_admin_live"
        room_code = "919193"
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "fixtureId": 919193,
            "participant1": "France",
            "participant2": "Belgium",
            "status": "running_live",
            "mode": "live",
            "eventIndex": 24,
            "players": [],
            "colonies": [],
            "activeOpportunities": [],
            "match": {"score": "1 - 0"},
            "logCount": 1,
        }
        stored_row = {
            "game_id": game_id,
            "fixture_id": "919193",
            "status": "running_live",
            "mode": "live",
            "seed": 93,
            "event_index": 24,
            "public_state": public_state,
        }

        class OrphanedLiveStore:
            configured = True

            def __init__(self):
                self.marked_states = []

            def game_replay(self, requested_game_id):
                if requested_game_id != game_id:
                    return None
                return {
                    "game": public_state,
                    "events": [],
                    "stored": {"source": "supabase", "game": stored_row, "eventCount": 0},
                }

            def mark_game_stopped(self, state):
                self.marked_states.append(dict(state))
                return {**state, "status": "stopped"}

        store = OrphanedLiveStore()
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)
        self.addCleanup(game_manager.live_tasks.pop, game_id, None)

        with patch("app.main.supabase_store", store), patch("app.main._ensure_live_task") as live_task:
            response = TestClient(app).get(f"/api/games/{game_id}")

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertEqual(game["gameId"], game_id)
        self.assertEqual(game["status"], "stopped")
        self.assertEqual(game["match"], public_state["match"])
        self.assertEqual(game["eventIndex"], public_state["eventIndex"])
        self.assertEqual(game["logCount"], public_state["logCount"])
        live_task.assert_not_called()
        self.assertIsNone(game_manager.get_room(game_id))
        self.assertEqual(store.marked_states, [public_state])

    def test_game_state_does_not_resume_stored_live_error(self):
        game_id = "game_stored_live_error"
        public_state = {
            "gameId": game_id,
            "roomCode": "919195",
            "roomKind": "admin",
            "fixtureId": 919195,
            "participant1": "Japan",
            "participant2": "Ghana",
            "status": "error",
            "mode": "live",
            "eventIndex": 18,
            "players": [],
            "colonies": [
                {
                    "colonyId": "col_stored_error",
                    "name": "Error Nest",
                    "size": 20,
                    "antsAlive": 20,
                    "food": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                }
            ],
            "activeOpportunities": [],
            "match": {"score": "0 - 0"},
            "logCount": 4,
        }

        class StoredLiveError:
            configured = True

            def game_replay(self, requested_game_id):
                return {
                    "game": public_state,
                    "events": [],
                    "stored": {"source": "supabase", "game": {"game_id": requested_game_id}, "eventCount": 0},
                }

            def mark_game_stopped(self, state):
                raise AssertionError("A stored error is returned as-is, not resumed or rewritten.")

        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, public_state["roomCode"], None)
        client = TestClient(app)
        with patch("app.main.supabase_store", StoredLiveError()), patch("app.main._ensure_live_task") as live_task:
            response = client.get(f"/api/games/{game_id}")
            ants = client.get(f"/api/games/{game_id}/colonies/col_stored_error/ants")
            response_after_restore = client.get(f"/api/games/{game_id}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "error")
        self.assertEqual(ants.status_code, 200)
        self.assertEqual(response_after_restore.status_code, 200)
        self.assertEqual(response_after_restore.json()["status"], "error")
        live_task.assert_not_called()
        self.assertIsNotNone(game_manager.get_room(game_id))

    def test_admin_replay_fixtures_only_returns_matches_with_score_data(self):
        class FakeTxLineClient:
            calls: list[tuple[str, int]] = []

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
                    {
                        "FixtureId": 703,
                        "StartTime": start - 120,
                        "Competition": "World Cup Demo",
                        "CompetitionId": competition_id or 1,
                        "Participant1": "Morocco",
                        "Participant2": "Canada",
                    },
                ]

            async def score_historical(self, fixture_id):
                self.calls.append(("historical", fixture_id))
                if fixture_id == 702:
                    return [{"FixtureId": fixture_id, "Seq": 1, "Action": "goal"}]
                if fixture_id == 703:
                    raise TimeoutError("historical source stalled")
                return []

            async def score_updates(self, fixture_id):
                self.calls.append(("updates", fixture_id))
                if fixture_id == 703:
                    return [{"FixtureId": fixture_id, "Seq": 2, "Action": "goal"}]
                return []

            async def score_snapshot(self, fixture_id):
                self.calls.append(("snapshot", fixture_id))
                return []

        client = TestClient(app)
        with patch("app.main.TxLineClient", FakeTxLineClient):
            response = client.get("/api/admin/replay-fixtures?days=1&limit=5&scan_limit=5")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["fixtures"][0]["fixtureId"], 702)
        self.assertEqual(data["fixtures"][0]["eventCount"], 1)
        self.assertEqual(data["fixtures"][0]["source"], "historical")
        self.assertEqual(data["fixtures"][1]["fixtureId"], 703)
        self.assertEqual(data["fixtures"][1]["source"], "updates")
        self.assertNotIn(("updates", 702), FakeTxLineClient.calls)
        self.assertNotIn(("snapshot", 702), FakeTxLineClient.calls)

    def test_admin_replay_fixtures_falls_back_to_snapshot_and_skips_source_timeouts(self):
        class FallbackTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                start = int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp())
                return [
                    {
                        "FixtureId": 704,
                        "StartTime": start,
                        "Participant1": "Spain",
                        "Participant2": "Belgium",
                    },
                    {
                        "FixtureId": 705,
                        "StartTime": start - 60,
                        "Participant1": "Norway",
                        "Participant2": "England",
                    },
                ]

            async def score_historical(self, fixture_id):
                if fixture_id == 705:
                    raise TimeoutError("historical timeout")
                return []

            async def score_updates(self, fixture_id):
                if fixture_id == 705:
                    raise TimeoutError("updates timeout")
                return []

            async def score_snapshot(self, fixture_id):
                if fixture_id == 705:
                    raise TimeoutError("snapshot timeout")
                return [{"FixtureId": fixture_id, "Seq": 3, "Action": "game_finalised"}]

        with patch("app.main.TxLineClient", FallbackTxLineClient):
            response = TestClient(app).get("/api/admin/replay-fixtures?days=1&limit=5&scan_limit=5")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["fixtures"][0]["fixtureId"], 704)
        self.assertEqual(data["fixtures"][0]["source"], "snapshot")
        self.assertEqual(data["inspected"], 2)

    def test_txline_timeout_returns_a_clear_gateway_error(self):
        class TimeoutTxLineClient:
            async def fixture_snapshot(self, *, start_epoch_day=None, competition_id=None):
                raise httpx.ReadTimeout("TXLine timed out")

        with patch("app.main.TxLineClient", TimeoutTxLineClient):
            response = TestClient(app).get("/api/fixtures/recent?days=1&limit=5")

        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["detail"], "TXLine did not respond before the timeout.")
        self.assertEqual(response.json()["error"], "ReadTimeout")

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
        call_order = []

        async def fake_sync(room):
            call_order.append("sync")
            return {"stored": True, "gameId": room.game_id, "eventCount": len(room.log)}

        def fake_schedule(room, events, *, delay_seconds=0.0, time_scale=None):
            call_order.append("schedule")
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
            patch("app.main._sync_room_to_supabase_async", fake_sync),
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
                    "agentCallMode": "batch",
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
        self.assertEqual(game["agentCallMode"], "batch")
        self.assertEqual(game["eventIndex"], 0)
        self.assertEqual(len(game["colonies"]), 1)
        self.assertEqual(game["colonies"][0]["name"], "Admin Scout")
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(len(scheduled[0]["events"]), 2)
        self.assertEqual(scheduled[0]["delaySeconds"], 0.8)
        self.assertEqual(scheduled[0]["timeScale"], 120)
        self.assertEqual(scheduled[0]["colonyNames"], ["Admin Scout"])
        self.assertEqual(call_order, ["sync", "schedule"])

    def test_replay_start_persists_running_state_before_scheduling_worker(self):
        room = game_manager.create_room(
            fixture_id="demo-sandbox-previous",
            participant1="North Colony FC",
            participant2="South Colony FC",
            seed=93,
        )
        game_manager.harness(room.game_id).add_colony(
            "Order Nest",
            20,
            "balanced",
            "momentum",
            "medium",
        )
        room.mode = "replay"
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)
        self.addCleanup(game_manager.replay_tasks.pop, room.game_id, None)

        calls = []

        async def fake_sync(target_room):
            calls.append(("sync", target_room.status))
            return {"stored": True, "gameId": target_room.game_id, "eventCount": len(target_room.log)}

        def fake_schedule(target_room, events, *, delay_seconds=0.0, time_scale=None):
            calls.append(("schedule", target_room.status))

        with (
            patch("app.main._sync_room_to_supabase_async", fake_sync),
            patch("app.main._schedule_replay_task", fake_schedule),
        ):
            state = asyncio.run(
                _start_replay_room(
                    room,
                    StartGameRequest(mode="replay", source="demo", agentCallMode="batch"),
                )
            )

        self.assertEqual(state["status"], "running_replay")
        self.assertEqual(state["agentCallMode"], "batch")
        self.assertEqual(calls, [("sync", "running_replay"), ("schedule", "running_replay")])

    def test_start_game_keeps_agent_call_mode_on_room_state(self):
        client = TestClient(app)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": "demo-sandbox-previous",
                "participant1": "North Colony FC",
                "participant2": "South Colony FC",
                "seed": 94,
                "creatorName": "Batch Host",
                "anonymousId": "anon_batch_host",
            },
        ).json()
        game_id = created["gameId"]
        room_code = created["roomCode"]
        self.addCleanup(game_manager.rooms.pop, game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room_code, None)
        self.addCleanup(game_manager.replay_tasks.pop, game_id, None)
        client.post(
            f"/api/games/{game_id}/colonies",
            json={
                "name": "Batch Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_batch_host",
            },
        )

        with (
            patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")),
            patch("app.main._sync_room_to_supabase_async"),
            patch("app.main._schedule_replay_task"),
        ):
            response = client.post(
                f"/api/games/{game_id}/start",
                json={
                    "mode": "replay",
                    "source": "demo",
                    "agentCallMode": "batch",
                    "anonymousId": "anon_batch_host",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["agentCallMode"], "batch")
        self.assertEqual(game_manager.get_room(game_id).agent_call_mode, "batch")

    def test_live_start_ignores_replay_agent_call_mode_override(self):
        client = TestClient(app)
        room = game_manager.create_room(
            fixture_id=949494,
            participant1="France",
            participant2="Belgium",
            seed=95,
        )
        game_manager.harness(room.game_id).add_colony(
            "Live Nest",
            20,
            "balanced",
            "momentum",
            "medium",
        )
        self.addCleanup(game_manager.rooms.pop, room.game_id, None)
        self.addCleanup(game_manager.room_codes.pop, room.room_code, None)

        async def fake_start_live(target_room):
            target_room.status = "running_live"

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._ensure_live_host"),
            patch("app.main._ensure_live_room_ready"),
            patch("app.main._start_live_room_now", fake_start_live),
        ):
            response = client.post(
                f"/api/games/{room.game_id}/start",
                json={"mode": "live", "agentCallMode": "batch"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "running_live")
        self.assertEqual(response.json()["agentCallMode"], "per_ant")
        self.assertEqual(room.agent_call_mode, "per_ant")

    def test_agent_call_mode_request_rejects_unknown_value(self):
        client = TestClient(app)

        start_response = client.post(
            "/api/games/missing/start",
            json={"agentCallMode": "one_call_per_hour"},
        )
        previous_response = client.post(
            "/api/games/run-previous",
            json={"agentCallMode": "one_call_per_hour"},
        )

        self.assertEqual(start_response.status_code, 422)
        self.assertEqual(previous_response.status_code, 422)

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
                json={
                    "fixtureId": 777,
                    "participant1": "Argentina",
                    "participant2": "Morocco",
                    "seed": 11,
                    "creatorName": "Replay Host",
                    "anonymousId": "anon_replay_host",
                },
            ).json()
            client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "A",
                    "size": 50,
                    "style": "cautious",
                    "favoriteContext": "penalties",
                    "infoNeed": "medium",
                    "anonymousId": "anon_replay_host",
                },
            )
            response = client.post(
                f"/api/games/{created['gameId']}/rerun",
                json={
                    "mode": "replay",
                    "source": "historical",
                    "agentCallMode": "batch",
                    "anonymousId": "anon_replay_host",
                },
            )

        self.assertEqual(response.status_code, 200)
        game = response.json()
        self.assertNotEqual(game["gameId"], created["gameId"])
        self.assertEqual(game["fixtureId"], 777)
        self.assertEqual(len(game["colonies"]), 1)
        self.assertEqual(game["agentCallMode"], "batch")
        self.assertIn(game["status"], {"running_replay", "finished"})


class LivePositionRestoreTest(unittest.TestCase):
    def _snapshot_and_events(self, game_id: str, room_code: str):
        opportunity_id = "opp_42_7_next_goal_team"
        colony_id = f"col_{room_code}"
        market = {
            "opportunityId": opportunity_id,
            "fixtureId": 42,
            "context": "next_goal_team",
            "label": "Who scores the next goal?",
            "teamLabel": "France",
            "minute": 20,
            "riskSugar": MARKET_RISK_SUGAR,
            "options": [
                {
                    "optionId": "next_goal_p1",
                    "label": "France scores the next goal",
                    "risk": "wild",
                    "multiplier": 4.4,
                    "rewardSugar": 4,
                    "riskSugar": MARKET_RISK_SUGAR,
                },
                {
                    "optionId": "next_goal_p2",
                    "label": "Belgium scores the next goal",
                    "risk": "wild",
                    "multiplier": 4.4,
                    "rewardSugar": 4,
                    "riskSugar": MARKET_RISK_SUGAR,
                },
                {
                    "optionId": "next_goal_none",
                    "label": "No goal before full time",
                    "risk": "safe",
                    "multiplier": 1.35,
                    "rewardSugar": 1,
                    "riskSugar": MARKET_RISK_SUGAR,
                },
            ],
        }
        public_state = {
            "gameId": game_id,
            "roomCode": room_code,
            "fixtureId": 42,
            "participant1": "France",
            "participant2": "Belgium",
            "status": "running_live",
            "mode": "live",
            "eventIndex": 7,
            "players": [],
            "colonies": [
                {
                    "colonyId": colony_id,
                    "name": "Restart Nest",
                    "simulationSeed": 7123,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "sugar": STARTING_COLONY_SUGAR,
                    "sugarReserved": MARKET_RISK_SUGAR,
                    "sugarNet": 0,
                }
            ],
            "activeOpportunities": [market],
            "match": {"score": {"participant1": 0, "participant2": 0}, "gameState": "inplay"},
        }
        prediction_id = f"pred_{room_code}"
        events = [
            {
                "index": 0,
                "kind": "opportunity",
                "message": market["label"],
                "data": {"opportunity": market},
            },
            {
                "index": 1,
                "kind": "prediction",
                "message": "Restart Nest enters France next goal.",
                "data": {
                    "colonyId": colony_id,
                    "opportunityId": opportunity_id,
                    "predictionId": prediction_id,
                    "option": {
                        "option_id": "next_goal_p1",
                        "optionId": "next_goal_p1",
                        "label": "France scores the next goal",
                        "risk": "wild",
                        "multiplier": 4.4,
                        "target": "goal",
                        "team_scope": "participant1",
                        "reward_sugar": 4,
                        "rewardSugar": 4,
                    },
                    "antIds": [f"ant_{index:04d}" for index in range(12)],
                    "market": market,
                    "sugarReserved": MARKET_RISK_SUGAR,
                    "supportFraction": 0.6,
                    "entryThreshold": STYLE_ENTRY_THRESHOLDS["balanced"],
                },
            },
        ]
        return public_state, events, colony_id, opportunity_id, prediction_id

    def _cleanup_room(self, game_id: str, room_code: str) -> None:
        game_manager.rooms.pop(game_id, None)
        game_manager.room_codes.pop(room_code, None)

    def test_open_position_and_reserved_sugar_survive_restore_then_settle(self):
        game_id = "game_restore_open_position"
        room_code = "881101"
        public_state, events, colony_id, opportunity_id, prediction_id = self._snapshot_and_events(game_id, room_code)
        self.addCleanup(self._cleanup_room, game_id, room_code)

        room = _restore_room_from_stored_row(
            {"game_id": game_id, "seed": 91, "public_state": public_state},
            events=events,
        )

        self.assertIn(opportunity_id, room.opportunities)
        self.assertIn(prediction_id, room.predictions)
        self.assertFalse(room.predictions[prediction_id].resolved)
        self.assertEqual(room.colonies[colony_id].food_reserved, MARKET_RISK_SUGAR)
        self.assertEqual(room.public_state()["colonies"][0]["sugarAvailable"], STARTING_COLONY_SUGAR - MARKET_RISK_SUGAR)

        game_manager.harness(game_id).process_event(
            {
                "fixtureId": 42,
                "seq": 8,
                "action": "goal",
                "highlights": ["goal"],
                "minute": 21,
                "clockSeconds": 1260,
                "participant": 1,
                "participantLabel": "France",
                "description": "Goal - France",
            }
        )

        self.assertTrue(room.predictions[prediction_id].resolved)
        self.assertEqual(room.colonies[colony_id].food_reserved, 0)
        self.assertEqual(room.colonies[colony_id].food, STARTING_COLONY_SUGAR + 4)
        settlement = next(event for event in room.log if event.kind == "settlement")
        self.assertEqual(settlement.data["predictionId"], prediction_id)
        self.assertEqual(settlement.data["sugarDelta"], 4)

    def test_delayed_log_hydration_rebuilds_snapshot_position(self):
        game_id = "game_hydrate_open_position"
        room_code = "881102"
        public_state, events, colony_id, opportunity_id, prediction_id = self._snapshot_and_events(game_id, room_code)
        self.addCleanup(self._cleanup_room, game_id, room_code)
        room = _restore_room_from_stored_row(
            {"game_id": game_id, "seed": 92, "public_state": public_state},
        )

        self.assertIn(opportunity_id, room.opportunities)
        self.assertNotIn(prediction_id, room.predictions)
        self.assertEqual(room.colonies[colony_id].food_reserved, MARKET_RISK_SUGAR)

        async def stored_replay(_game_id):
            return {"game": public_state, "events": events}

        class ConfiguredStore:
            configured = True

        with (
            patch("app.main.supabase_store", ConfiguredStore()),
            patch("app.main._stored_replay_or_none", stored_replay),
        ):
            asyncio.run(_ensure_room_log_hydrated(room))

        self.assertIn(prediction_id, room.predictions)
        self.assertIn(opportunity_id, room.opportunities)
        self.assertEqual(room.colonies[colony_id].food_reserved, MARKET_RISK_SUGAR)
        self.assertTrue(getattr(room, "_aoc_log_hydrated", False))

    def test_later_void_hydration_releases_restored_collateral_and_prunes_market(self):
        game_id = "game_hydrate_voided_position"
        room_code = "881103"
        public_state, events, colony_id, opportunity_id, prediction_id = self._snapshot_and_events(game_id, room_code)
        self.addCleanup(self._cleanup_room, game_id, room_code)
        room = _restore_room_from_stored_row(
            {"game_id": game_id, "seed": 93, "public_state": public_state},
            events=events,
        )
        self.assertFalse(room.predictions[prediction_id].resolved)
        self.assertEqual(room.colonies[colony_id].food_reserved, MARKET_RISK_SUGAR)

        closed_state = {
            **public_state,
            "activeOpportunities": [],
            "colonies": [{**public_state["colonies"][0], "sugarReserved": 0}],
        }
        void_event = {
            "index": 2,
            "kind": "void",
            "message": "Position voided after restart.",
            "data": {
                "colonyId": colony_id,
                "opportunityId": opportunity_id,
                "predictionId": prediction_id,
                "reason": "full_time",
                "sugarReserved": MARKET_RISK_SUGAR,
            },
        }
        same_room = _restore_room_from_stored_row(
            {"game_id": game_id, "seed": 93, "public_state": closed_state},
            events=[*events, void_event],
        )

        self.assertIs(same_room, room)
        self.assertTrue(room.predictions[prediction_id].resolved)
        self.assertEqual(room.colonies[colony_id].food_reserved, 0)
        self.assertNotIn(opportunity_id, room.opportunities)


if __name__ == "__main__":
    unittest.main()
