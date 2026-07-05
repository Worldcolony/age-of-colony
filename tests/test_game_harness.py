import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.game.agents import AgentDecisionError, OpenRouterColonyAgent, OpenRouterSettings
from app.main import (
    ADMIN_TOKEN_HEADER,
    app,
    _finish_live_game,
    _live_timeline_finished,
    _merge_restored_events,
    _pick_live_target_fixture,
    _process_live_events,
    _replay_delay_after_event,
    game_manager,
)
from app.game.harness import (
    GameHarness,
    GameManager,
    LARVAE_INCUBATION_EVENTS,
    STARTING_COLONY_ANTS,
    STARTING_COLONY_FOOD,
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
    def make_room(self):
        manager = GameManager()
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        return room, GameHarness(room)

    def test_penalty_event_creates_risk_reward_opportunity(self):
        opportunity = build_opportunity(penalty_event(), 1)

        self.assertIsNotNone(opportunity)
        self.assertEqual(opportunity.context, "penalties")
        self.assertEqual(opportunity.info_cost, 8)
        labels = {option.label: option.multiplier for option in opportunity.options}
        self.assertEqual(labels["yes, penalty scored"], 1.35)
        self.assertEqual(labels["no, missed or saved"], 5.5)

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

        self.assertEqual([opportunity.context for opportunity in opportunities], ["goal_next_10", "next_goal_team", "next_foul"])
        goal_market = opportunities[0]
        precision_market = opportunities[1]
        foul_market = opportunities[2]
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
        self.assertEqual(precision_market.options[2].label, "no goal before the deadline")
        self.assertEqual([option.option_id for option in foul_market.options], [
            "next_foul_p1",
            "next_foul_p2",
        ])
        self.assertEqual(foul_market.options[0].label, "yes, France commits the next foul")
        self.assertEqual(foul_market.options[1].label, "no, Belgium commits the next foul")

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
        self.assertEqual(public["antsEngaged"], 1)
        self.assertEqual(public["antsWounded"], 1)

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

    def test_next_foul_market_resolves_on_first_foul_team(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("no"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Foul Nest", 20, "balanced", "chaos", "medium")

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
        foul_predictions = [
            prediction
            for prediction in room.predictions.values()
            if prediction.option.option_id == "next_foul_p2"
        ]
        self.assertTrue(foul_predictions)

        harness.process_event(
            {
                "fixtureId": 42,
                "seq": 2,
                "action": "foul",
                "highlights": ["foul"],
                "minute": 61,
                "clockSeconds": 3660,
                "participant": 2,
                "participantLabel": "Belgium",
                "description": "Foul - Belgium",
            }
        )

        self.assertTrue(foul_predictions[0].resolved)
        self.assertGreaterEqual(colony.memory.wins, 1)
        self.assertTrue(any(event.kind == "settlement" and event.data.get("win") for event in room.log))

    def test_successful_prediction_adds_food_and_larvae(self):
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
        self.assertGreater(colony.food + colony.memory.losses, starting_food - 1)
        self.assertTrue(any(event.kind == "settlement" for event in room.log))

    def test_larvae_hatch_into_new_ants_after_incubation(self):
        manager = GameManager(decision_agent=FakeDeepSeekAntAgent("yes"))
        room = manager.create_room(fixture_id=42, participant1="France", participant2="Belgium", seed=123)
        harness = manager.harness(room.game_id)
        colony = harness.add_colony(
            name="Nursery Nest",
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

        self.assertGreater(colony.larvae, 0)
        self.assertEqual(len(colony.ants), colony.size)

        for offset in range(LARVAE_INCUBATION_EVENTS + 1):
            harness.process_event(
                {
                    "fixtureId": 42,
                    "seq": 3 + offset,
                    "action": "clock",
                    "highlights": [],
                    "minute": 11 + offset // 6,
                    "clockSeconds": 660 + offset * 10,
                    "description": "Clock tick",
                }
            )

        public_state = colony.public_state(room.event_index)
        self.assertGreater(len(colony.ants), colony.size)
        self.assertGreater(public_state["antsBorn"], 0)
        self.assertTrue(any(event.kind == "hatch" for event in room.log))

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
            if context["market"]["context"] == "next_goal_team":
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
                "action": "foul",
                "highlights": ["foul"],
                "minute": 12,
                "clockSeconds": 720,
                "participant": 1,
                "participantLabel": "France",
                "description": "Foul - France",
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
                self.assertEqual(len(agent.calls), colony_count * 3)
                self.assertEqual(len([event for event in room.log if event.kind == "ant_agent_vote"]), colony_count * 3)
                self.assertEqual(len([event for event in room.log if event.kind == "settlement"]), colony_count * 3)

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
        self.assertTrue(any(event.kind == "void" for event in room.log))

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
                return [
                    {
                        "antId": ant["antId"],
                        "vote": "yes",
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

        self.assertEqual(len(agent.calls), 3)
        self.assertEqual([call["context"]["market"]["context"] for call in agent.calls], ["goal_next_10", "next_goal_team", "next_foul"])
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
        self.assertEqual(game["players"][0]["colonyName"], "Alice Nest")
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

    def test_live_start_waits_for_future_kickoff_and_locks_lobby(self):
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

        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")), patch("app.main._schedule_kickoff_start") as schedule:
            started = client.post(
                f"/api/games/{created['gameId']}/start",
                json={"mode": "live", "source": "updates", "anonymousId": "anon_wait_host"},
            )

        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.json()["status"], "waiting_kickoff")
        schedule.assert_called_once()

        joined_after_lock = client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Late Bob", "anonymousId": "anon_late_bob"},
        )
        self.assertEqual(joined_after_lock.status_code, 409)

        colony_after_lock = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Late Nest",
                "size": 10,
                "style": "cautious",
                "favoriteContext": "penalties",
                "infoNeed": "high",
                "anonymousId": "anon_wait_host",
            },
        )
        self.assertEqual(colony_after_lock.status_code, 422)

    def test_live_start_for_match_in_progress_runs_immediately(self):
        client = TestClient(app)
        kickoff = datetime.now(timezone.utc) - timedelta(minutes=25)
        created = client.post(
            "/api/games",
            json={
                "fixtureId": 939393,
                "participant1": "Australia",
                "participant2": "Egypt",
                "startTimeIso": kickoff.isoformat(),
                "creatorName": "Host Alice",
                "anonymousId": "anon_live_host",
            },
        ).json()
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

        with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")), patch("app.main._ensure_live_task") as live_task:
            started = client.post(
                f"/api/games/{created['gameId']}/start",
                json={"mode": "live", "source": "updates", "anonymousId": "anon_live_host"},
            )

        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.json()["status"], "running_live")
        live_task.assert_called_once()

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

    def test_admin_debug_tools_require_token_when_configured(self):
        client = TestClient(app)

        with patch.dict("os.environ", {"AOC_ADMIN_TOKEN": "secret"}):
            blocked_demo = client.post("/api/demo/run", json={"seed": 99})
            self.assertEqual(blocked_demo.status_code, 403)

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

            blocked_unowned_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                json={
                    "name": "Admin Only Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                },
            )
            self.assertEqual(blocked_unowned_colony.status_code, 403)

            allowed_unowned_colony = client.post(
                f"/api/games/{created['gameId']}/colonies",
                headers={ADMIN_TOKEN_HEADER: "secret"},
                json={
                    "name": "Admin Only Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                },
            )
            self.assertEqual(allowed_unowned_colony.status_code, 200)

            with patch("app.main.game_manager.decision_agent", FakeDeepSeekAntAgent("yes")):
                allowed_demo = client.post(
                    "/api/demo/run",
                    headers={ADMIN_TOKEN_HEADER: "secret"},
                    json={"seed": 99},
                )
            self.assertEqual(allowed_demo.status_code, 200)

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
