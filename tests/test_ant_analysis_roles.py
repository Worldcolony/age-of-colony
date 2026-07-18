from __future__ import annotations

import unittest

from app.game.agents import OpenRouterColonyAgent, OpenRouterSettings
from app.game.harness import (
    GameManager,
    MatchState,
    Opportunity,
    OpportunityOption,
    PRIVATE_SNAPSHOT_KEY,
    ant_profile_state,
    ant_strategy_state,
    build_market_signal_pack,
    clone_ant_for_new_match,
    effective_analysis_role,
    natural_analysis_role,
    public_vote,
    restore_ant_profile,
)


class CapturingAntAgent:
    def __init__(self, vote: str = "yes") -> None:
        self.vote = vote
        self.calls: list[dict] = []

    def decide_ants(self, *, game_id, stage, context, ants):
        self.calls.append({"gameId": game_id, "stage": stage, "context": context, "ants": ants})
        return [{"antId": ant["antId"], "vote": self.vote} for ant in ants]

    def usage_for_game(self, game_id):
        return None


def make_opportunity(source_event: dict, *, context: str = "goal_next_10") -> Opportunity:
    return Opportunity(
        opportunity_id="opp_signal_test",
        fixture_id=42,
        context=context,
        label="Test market",
        team=None,
        team_label=None,
        minute=source_event.get("minute"),
        created_event_index=1,
        deadline_clock=None,
        deadline_event_index=None,
        options=[
            OpportunityOption("yes_option", "Yes", "risky", 2.0, "goal", "any", 2),
            OpportunityOption("no_option", "No", "safe", 1.3, "no_goal", "any", 2),
        ],
        source_event=source_event,
    )


class AntAnalysisRoleTest(unittest.TestCase):
    def make_colony(self, *, agent=None):
        manager = GameManager(decision_agent=agent)
        room = manager.create_room(
            fixture_id=42,
            participant1="France",
            participant2="Belgium",
            seed=17,
        )
        harness = manager.harness(room.game_id)
        colony = harness.add_colony("Role Nest", 20, "balanced", "momentum", "medium")
        return room, harness, colony

    def test_natural_role_override_update_clone_and_profile_persistence(self):
        room, harness, colony = self.make_colony()
        expected = {
            "cautious": "statistical",
            "balanced": "situational",
            "data_first": "statistical",
            "opportunist": "situational",
            "momentum": "reactive",
            "chaos": "reactive",
        }
        for ant in colony.ants:
            self.assertEqual(natural_analysis_role(ant), expected[ant.archetype])

        ant = colony.ants[0]
        natural_role = natural_analysis_role(ant)
        custom_role = next(role for role in ("reactive", "statistical", "situational") if role != natural_role)
        initial = ant_strategy_state(ant, colony)
        self.assertEqual(initial["analysisRole"], natural_role)
        self.assertTrue(initial["inheritsRole"])
        self.assertEqual(initial["roleSource"], "archetype")
        self.assertTrue(initial["inheritsGlobal"])

        harness.update_ant_strategy(colony.colony_id, ant.ant_id, analysis_role=custom_role)
        updated = ant_strategy_state(ant, colony)
        self.assertEqual(updated["analysisRole"], custom_role)
        self.assertFalse(updated["inheritsRole"])
        self.assertEqual(updated["roleSource"], "custom")
        self.assertTrue(updated["inheritsGlobal"])
        self.assertEqual(updated["source"], "colony")

        public_colony = colony.public_state(room.event_index)
        self.assertEqual(public_colony["antStrategies"][ant.ant_id]["analysisRole"], custom_role)
        persisted = room.persistence_state()
        stored_profile = persisted[PRIVATE_SNAPSHOT_KEY]["antProfiles"][colony.colony_id][ant.ant_id]
        self.assertEqual(stored_profile["analysisRoleOverride"], custom_role)
        self.assertEqual(stored_profile["analysisRole"], custom_role)

        cloned = clone_ant_for_new_match(ant)
        self.assertEqual(cloned.analysis_role_override, custom_role)
        fallback = clone_ant_for_new_match(ant)
        fallback.analysis_role_override = None
        restore_ant_profile(fallback, ant_profile_state(ant))
        self.assertEqual(fallback.analysis_role_override, custom_role)

        harness.update_ant_strategy(colony.colony_id, ant.ant_id, inherit_global=True)
        self.assertEqual(ant.analysis_role_override, custom_role)
        self.assertEqual(effective_analysis_role(ant), custom_role)
        self.assertTrue(ant_strategy_state(ant, colony)["inheritsGlobal"])

    def test_signal_pack_uses_five_minute_window_and_full_match_counts(self):
        state = MatchState(42, "France", "Belgium")
        events = [
            {
                "seq": 1,
                "action": "shot",
                "minute": 4,
                "clockSeconds": 299,
                "participant": 1,
                "participantLabel": "France",
            },
            {
                "seq": 2,
                "action": "corner",
                "minute": 5,
                "clockSeconds": 300,
                "participant": 2,
                "participantLabel": "Belgium",
            },
            {
                "seq": 3,
                "action": "attack_possession",
                "minute": 5,
                "clockSeconds": 301,
                "participant": 1,
                "participantLabel": "France",
            },
            {
                "seq": 4,
                "action": "high_danger_possession",
                "minute": 10,
                "clockSeconds": 600,
                "participant": 2,
                "participantLabel": "Belgium",
                "score": {"participant1": 0, "participant2": 0},
            },
        ]
        for event in events:
            state.update(event)

        pack = build_market_signal_pack(state, make_opportunity(events[-1]))
        recent = pack["roleEvidence"]["reactive"]
        cumulative = pack["roleEvidence"]["statistical"]

        self.assertEqual(recent["sampleSize"], 3)
        self.assertEqual(recent["signalSampleSize"], 3)
        self.assertNotIn("windowStartClockSeconds", recent)
        self.assertNotIn("windowEndClockSeconds", recent)
        self.assertTrue(all("secondsAgo" in event for event in recent["recentEvents"]))
        self.assertTrue(all("minute" not in event for event in recent["recentEvents"]))
        self.assertTrue(all("clockSeconds" not in event for event in recent["recentEvents"]))
        self.assertEqual(recent["countsByTeam"]["participant1"]["shot"], 0)
        self.assertEqual(recent["countsByTeam"]["participant1"]["attack"], 1)
        self.assertEqual(recent["countsByTeam"]["participant2"]["corner"], 1)
        self.assertEqual(recent["countsByTeam"]["participant2"]["danger"], 1)
        self.assertEqual(cumulative["countsByTeam"]["participant1"]["shot"], 1)
        self.assertEqual(cumulative["sampleSize"], 4)
        self.assertEqual(cumulative["signalSampleSize"], 4)

    def test_missing_score_and_clock_are_explicit_but_confirmed_none_is_neutral(self):
        state = MatchState(42, "France", "Belgium")
        source = {
            "seq": 1,
            "action": "shot",
            "participant": 1,
            "participantLabel": "France",
            "confirmed": None,
        }
        state.update(source)

        pack = build_market_signal_pack(state, make_opportunity(source))
        situational = pack["roleEvidence"]["situational"]["scoreMinuteContext"]
        reliability = pack["reliability"]

        self.assertFalse(situational["available"])
        self.assertFalse(situational["scoreAvailable"])
        self.assertFalse(situational["timeAvailable"])
        self.assertEqual(situational["leader"], "unknown")
        self.assertIn("missing_score", reliability["issueCodes"])
        self.assertIn("missing_current_clock", reliability["issueCodes"])
        self.assertIn("missing_event_clock", reliability["issueCodes"])
        self.assertNotIn("explicitly_unconfirmed", reliability["issueCodes"])
        self.assertEqual(reliability["confirmedFalseCount"], 0)
        self.assertTrue(reliability["confirmedMissingIsNeutral"])

    def test_tactician_requires_both_score_and_time(self):
        state = MatchState(42, "France", "Belgium")
        source = {
            "seq": 1,
            "action": "shot",
            "participant": 1,
            "score": {"participant1": 0, "participant2": 0},
        }
        state.update(source)

        pack = build_market_signal_pack(state, make_opportunity(source))
        context = pack["roleEvidence"]["situational"]["scoreMinuteContext"]

        self.assertFalse(context["available"])
        self.assertTrue(context["scoreAvailable"])
        self.assertFalse(context["timeAvailable"])
        self.assertNotIn("missing_score", pack["reliability"]["issueCodes"])
        self.assertIn("missing_current_clock", pack["reliability"]["issueCodes"])

    def test_match_state_score_fills_partial_event_score(self):
        state = MatchState(42, "France", "Belgium")
        state.score = {"participant1": 1, "participant2": 0}
        source = {
            "seq": 1,
            "action": "shot",
            "minute": 12,
            "clockSeconds": 720,
            "participant": 1,
            "score": {"participant1": 1, "participant2": None},
        }
        state.update(source)

        pack = build_market_signal_pack(state, make_opportunity(source))
        context = pack["roleEvidence"]["situational"]["scoreMinuteContext"]

        self.assertTrue(context["available"])
        self.assertTrue(context["scoreAvailable"])
        self.assertEqual(context["score"], {"participant1": 1, "participant2": 0})
        self.assertNotIn("missing_score", pack["reliability"]["issueCodes"])

    def test_explicitly_unconfirmed_signal_does_not_inflate_samples(self):
        state = MatchState(42, "France", "Belgium")
        baseline = {
            "seq": 1,
            "action": "safe_possession",
            "minute": 9,
            "clockSeconds": 590,
            "participant": 1,
            "score": {"participant1": 0, "participant2": 0},
        }
        unconfirmed = {
            "seq": 2,
            "action": "goal",
            "highlights": ["goal"],
            "minute": 10,
            "clockSeconds": 600,
            "participant": 1,
            "confirmed": False,
            "score": {"participant1": 1, "participant2": 0},
        }
        state.update(baseline)
        state.update(unconfirmed)

        pack = build_market_signal_pack(state, make_opportunity(unconfirmed))
        statistical = pack["roleEvidence"]["statistical"]
        situational = pack["roleEvidence"]["situational"]["scoreMinuteContext"]

        self.assertEqual(statistical["signalSampleSize"], 0)
        self.assertEqual(statistical["countsByTeam"]["participant1"]["goal"], 0)
        self.assertEqual(situational["score"], {"participant1": 0, "participant2": 0})
        self.assertIn("explicitly_unconfirmed", pack["reliability"]["issueCodes"])

    def test_preliminary_false_replaced_by_confirmed_record_is_not_a_quality_issue(self):
        state = MatchState(42, "France", "Belgium")
        preliminary = {
            "id": 10,
            "seq": 1,
            "action": "corner",
            "minute": 10,
            "clockSeconds": 600,
            "participant": 1,
            "confirmed": False,
            "score": {"participant1": 0, "participant2": 0},
        }
        confirmed = {**preliminary, "seq": 2, "confirmed": True}
        state.update(preliminary)
        state.update(confirmed)

        pack = build_market_signal_pack(state, make_opportunity(confirmed))

        self.assertEqual(pack["reliability"]["confirmedFalseCount"], 0)
        self.assertNotIn("explicitly_unconfirmed", pack["reliability"]["issueCodes"])
        self.assertEqual(
            pack["roleEvidence"]["statistical"]["countsByTeam"]["participant1"]["corner"],
            1,
        )

    def test_discarded_action_is_removed_from_counts_and_reduces_reliability(self):
        state = MatchState(42, "France", "Belgium")
        original = {
            "id": 10,
            "seq": 1,
            "action": "shot",
            "minute": 10,
            "clockSeconds": 600,
            "participant": 1,
            "participantLabel": "France",
            "score": {"participant1": 0, "participant2": 0},
        }
        discarded = {
            "id": 10,
            "seq": 2,
            "action": "action_discarded",
            "minute": 10,
            "clockSeconds": 610,
            "highlights": ["discarded"],
            "description": "Action discarded - shot - France",
        }
        state.update(original)
        state.update(discarded)

        pack = build_market_signal_pack(state, make_opportunity(discarded))
        cumulative = pack["roleEvidence"]["statistical"]
        reliability = pack["reliability"]

        self.assertEqual(cumulative["countsByTeam"]["participant1"]["shot"], 0)
        self.assertEqual(cumulative["sampleSize"], 0)
        self.assertIn("discarded_action", reliability["issueCodes"])
        self.assertEqual(reliability["discardedCount"], 1)

    def test_amended_action_replaces_original_signal(self):
        state = MatchState(42, "France", "Belgium")
        original = {
            "id": 10,
            "seq": 1,
            "action": "shot",
            "minute": 10,
            "clockSeconds": 600,
            "participant": 1,
            "score": {"participant1": 0, "participant2": 0},
        }
        amended = {
            "id": 10,
            "seq": 2,
            "action": "action_amend",
            "type": "corner",
            "highlights": ["corner"],
            "minute": 10,
            "clockSeconds": 610,
            "participant": 1,
            "score": {"participant1": 0, "participant2": 0},
        }
        state.update(original)
        state.update(amended)

        pack = build_market_signal_pack(state, make_opportunity(amended))
        counts = pack["roleEvidence"]["statistical"]["countsByTeam"]["participant1"]

        self.assertEqual(counts["shot"], 0)
        self.assertEqual(counts["corner"], 1)
        self.assertEqual(pack["reliability"]["amendedCount"], 1)

    def test_foul_and_penalty_markets_have_direct_signal_counts(self):
        state = MatchState(42, "France", "Belgium")
        events = [
            {
                "seq": 1,
                "action": "foul",
                "highlights": ["foul"],
                "minute": 20,
                "clockSeconds": 1200,
                "participant": 2,
                "score": {"participant1": 0, "participant2": 0},
            },
            {
                "seq": 2,
                "action": "penalty_scored",
                "highlights": ["penalty", "goal"],
                "minute": 21,
                "clockSeconds": 1260,
                "participant": 1,
                "score": {"participant1": 1, "participant2": 0},
            },
        ]
        for event in events:
            state.update(event)

        pack = build_market_signal_pack(state, make_opportunity(events[-1], context="penalties"))
        counts = pack["roleEvidence"]["statistical"]["countsByTeam"]

        self.assertEqual(counts["participant2"]["foul"], 1)
        self.assertEqual(counts["participant1"]["penalty"], 1)
        self.assertEqual(counts["participant1"]["penalty_scored"], 1)
        self.assertEqual(counts["participant1"]["penalty_missed"], 0)

    def test_cancelled_goal_is_removed_from_tactician_score(self):
        state = MatchState(42, "France", "Belgium")
        baseline = {
            "id": 1,
            "seq": 1,
            "action": "safe_possession",
            "minute": 9,
            "clockSeconds": 590,
            "participant": 1,
            "score": {"participant1": 0, "participant2": 0},
        }
        goal = {
            "id": 10,
            "seq": 2,
            "action": "goal",
            "highlights": ["goal"],
            "minute": 10,
            "clockSeconds": 600,
            "participant": 1,
            "score": {"participant1": 1, "participant2": 0},
        }
        discarded = {
            "id": 10,
            "seq": 3,
            "action": "action_discarded",
            "minute": 10,
            "clockSeconds": 610,
        }
        for event in (baseline, goal, discarded):
            state.update(event)

        pack = build_market_signal_pack(state, make_opportunity(discarded))
        context = pack["roleEvidence"]["situational"]["scoreMinuteContext"]

        self.assertTrue(context["available"])
        self.assertEqual(context["score"], {"participant1": 0, "participant2": 0})
        self.assertEqual(context["leader"], "tied")
        self.assertNotIn("timeRemainingMinutes", context)

    def test_quiet_recent_possession_is_valid_data_not_bad_reliability(self):
        state = MatchState(42, "France", "Belgium")
        events = [
            {
                "seq": 1,
                "action": "safe_possession",
                "minute": 10,
                "clockSeconds": 600,
                "participant": 1,
                "score": {"participant1": 0, "participant2": 0},
            },
            {
                "seq": 2,
                "action": "safe_possession",
                "minute": 10,
                "clockSeconds": 610,
                "participant": 2,
                "score": {"participant1": 0, "participant2": 0},
            },
        ]
        for event in events:
            state.update(event)

        pack = build_market_signal_pack(state, make_opportunity(events[-1]))
        reactive = pack["roleEvidence"]["reactive"]
        reliability = pack["reliability"]

        self.assertEqual(reactive["sampleSize"], 2)
        self.assertEqual(reactive["signalSampleSize"], 0)
        self.assertEqual(reliability["level"], "good")
        self.assertEqual(reliability["recentSampleSize"], 2)
        self.assertEqual(reliability["recentSignalSampleSize"], 0)
        self.assertNotIn("small_recent_sample", reliability["issueCodes"])

    def test_agent_receives_one_lens_and_public_vote_has_role_summaries(self):
        agent = CapturingAntAgent("yes")
        room, harness, colony = self.make_colony(agent=agent)
        source = {
            "seq": 1,
            "action": "high_danger_possession",
            "minute": 20,
            "clockSeconds": 1200,
            "participant": 1,
            "participantLabel": "France",
            "score": {"participant1": 1, "participant2": 0},
        }
        room.match_state.update(source)
        room.event_index = 1
        opportunity = make_opportunity(source)

        vote = harness._ant_agent_vote(colony, opportunity)
        self.assertIsNotNone(vote)
        call = agent.calls[0]
        self.assertNotIn("score", call["context"]["match"])
        self.assertNotIn("recentEvents", call["context"]["match"])
        self.assertNotIn("minute", call["context"]["market"])
        self.assertNotIn("minute", call["context"]["opportunity"])
        self.assertNotIn("teamLabel", call["context"]["market"])
        self.assertNotIn("teamLabel", call["context"]["opportunity"])
        self.assertNotIn("20'", call["context"]["opportunity"]["label"])
        self.assertNotIn("style", call["context"]["colony"])
        self.assertNotIn("entryThreshold", call["context"]["colony"])
        self.assertNotIn("accuracy", call["context"]["colony"])
        self.assertNotIn("contextRate", call["context"]["colony"])
        self.assertIn("dataReliability", call["context"]["match"])
        for key in ("sampleSize", "signalSampleSize", "recentSampleSize", "recentSignalSampleSize"):
            self.assertNotIn(key, call["context"]["match"]["dataReliability"])
        for ant_payload in call["ants"]:
            role = ant_payload["strategy"]["analysisRole"]
            self.assertEqual(
                set(ant_payload["strategy"]),
                {"analysisRole"},
            )
            self.assertNotIn("archetype", ant_payload)
            self.assertNotIn("personality", ant_payload)
            self.assertNotIn("memory", ant_payload)
            for key in ("sampleSize", "signalSampleSize", "recentSampleSize", "recentSignalSampleSize"):
                self.assertNotIn(key, ant_payload["dataReliability"])
            self.assertEqual(ant_payload["roleEvidence"]["role"], role)
            if role == "reactive":
                self.assertIn("windowMinutes", ant_payload["roleEvidence"])
                self.assertNotIn("scoreMinuteContext", ant_payload["roleEvidence"])
            elif role == "statistical":
                self.assertEqual(ant_payload["roleEvidence"]["scope"], "full_match_so_far")
                self.assertNotIn("recentEvents", ant_payload["roleEvidence"])
            else:
                self.assertIn("scoreMinuteContext", ant_payload["roleEvidence"])
                self.assertNotIn("countsByTeam", ant_payload["roleEvidence"])

        public = public_vote(vote)
        self.assertEqual(sum(public["roleAntCounts"].values()), len(colony.ants))
        for role, ant_count in public["roleAntCounts"].items():
            self.assertEqual(public["roleVoteCounts"][role]["yes"], ant_count)
        self.assertEqual(public["reliabilitySummary"]["level"], vote["reliabilitySummary"]["level"])

    def test_openrouter_batch_calls_are_isolated_by_analysis_role(self):
        agent = OpenRouterColonyAgent(
            OpenRouterSettings(
                api_key="test-key",
                model="deepseek/deepseek-v4-flash",
                call_mode="batch",
                ant_batch_size=20,
                max_calls_per_game=10,
            )
        )
        calls: list[list[dict]] = []

        def fake_call(*, stage, context, ants):
            calls.append(ants)
            return {
                "model": "deepseek/deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": {
                                "antDecisions": [
                                    {"antId": ant["antId"], "vote": "yes"}
                                    for ant in ants
                                ]
                            }
                        }
                    }
                ],
            }

        agent._call_openrouter_ants = fake_call
        roles = ["reactive", "statistical", "situational", "reactive", "statistical"]
        ants = [
            {
                "antId": f"ant_{index}",
                "strategy": {"analysisRole": role},
                "roleEvidence": {"role": role},
            }
            for index, role in enumerate(roles, start=1)
        ]
        decisions = agent.decide_ants(
            game_id="role-batch-test",
            stage="pre_info",
            context={
                "market": {
                    "availableVotes": [
                        {"vote": "yes", "optionId": "yes_option"},
                        {"vote": "no", "optionId": "no_option"},
                        {"vote": "abstain", "optionId": None},
                    ]
                }
            },
            ants=ants,
        )

        self.assertEqual(len(calls), 3)
        for batch in calls:
            self.assertEqual(
                len({ant["strategy"]["analysisRole"] for ant in batch}),
                1,
            )
            self.assertEqual(
                {ant["strategy"]["analysisRole"] for ant in batch},
                {ant["roleEvidence"]["role"] for ant in batch},
            )
        self.assertEqual([decision.ant_id for decision in decisions or []], [ant["antId"] for ant in ants])


if __name__ == "__main__":
    unittest.main()
