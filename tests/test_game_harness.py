import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.game.agents import AgentDecisionError, OpenRouterColonyAgent, OpenRouterSettings
from app.main import app
from app.game.harness import (
    GameHarness,
    GameManager,
    LARVAE_INCUBATION_EVENTS,
    build_info_packet,
    build_opportunity,
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
        self.assertEqual(opportunity.info_cost, 5)
        labels = {option.label: option.multiplier for option in opportunity.options}
        self.assertEqual(labels["yes, penalty scored"], 1.35)
        self.assertEqual(labels["no, no goal"], 4.0)

    def test_pressure_event_creates_one_next_five_yes_no_market(self):
        room, _ = self.make_room()
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

        self.assertIsNotNone(opportunity)
        self.assertEqual(opportunity.context, "next_5")
        self.assertEqual([option.option_id for option in opportunity.options], [
            "goal_next_5_yes",
            "goal_next_5_no",
        ])
        self.assertEqual(opportunity.options[0].label, "yes, France goal in the next 5 min")
        self.assertEqual(opportunity.options[1].label, "no, no France goal in the next 5 min")

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

        self.assertEqual(len(colony.ants), 50)
        self.assertIn("cautious", archetypes)
        self.assertIn("data_first", archetypes)
        self.assertGreater(len(archetypes), 3)
        self.assertTrue(any(ant.risk_appetite > 0.55 for ant in colony.ants))

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
        self.assertEqual(packet.cost, 5)
        self.assertIn("involved player: Mbappe", packet.facts)
        opportunity.info_bought_by.add(colony.colony_id)
        self.assertFalse(should_buy_info(colony, opportunity, vote))

    def test_info_cost_scales_with_colony_size(self):
        _, harness = self.make_room()
        opportunity = build_opportunity(penalty_event(player={"name": "Mbappe"}), 1)
        small = harness.add_colony("Small", 10, "cautious", "penalties", "high")
        medium = harness.add_colony("Medium", 20, "cautious", "penalties", "high")
        large = harness.add_colony("Large", 50, "cautious", "penalties", "high")

        self.assertEqual(info_cost_for_colony(small, opportunity), 1)
        self.assertEqual(info_cost_for_colony(medium, opportunity), 2)
        self.assertEqual(info_cost_for_colony(large, opportunity), 5)

    def test_food_drain_uses_alive_ants_not_starting_size(self):
        _, harness = self.make_room()
        colony = harness.add_colony("Large", 50, "aggressive", "chaos", "low")
        for ant in colony.ants[:40]:
            ant.alive = False

        self.assertEqual(len(colony.alive_ants), 10)
        self.assertEqual(food_drain_for_colony(colony), 1)

    def test_late_pressure_event_does_not_create_next_five_market(self):
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

        self.assertIsNone(opportunity)

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

        self.assertEqual(len(agent.calls), 1)
        self.assertEqual(agent.calls[0]["context"]["market"]["availableVotes"][0]["vote"], "yes")
        self.assertIn("objective", agent.calls[0]["ants"][0])
        self.assertIn("personality", agent.calls[0]["ants"][0])
        self.assertIn("memory", agent.calls[0]["ants"][0])
        self.assertTrue(any(event.kind == "ant_agent_vote" for event in room.log))
        self.assertTrue(any(prediction.option.option_id == "goal_next_5_yes" for prediction in room.predictions.values()))
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
                                "optionId": "goal_next_5_yes",
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
                                        "optionId": "goal_next_5_yes",
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
                        {"optionId": "goal_next_5_yes"},
                        {"optionId": "goal_next_5_no"},
                    ]
                }
            },
        )

        self.assertEqual(decision.source, "openrouter")
        self.assertEqual(decision.option_id, "goal_next_5_yes")
        self.assertEqual(len(decision.squad_votes), 2)
        self.assertEqual(decision.public_state()["squadVotes"][1]["squad"], "momentum")


class DemoRunApiTest(unittest.TestCase):
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
