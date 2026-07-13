import unittest

from app.game.demo import DEMO_FIXTURE, demo_events
from tools.playtest_sugar import LocalVoterAgent, reward_audit, run_playtests


class SugarPlaytestToolTest(unittest.TestCase):
    def test_reward_audit_flags_three_way_markets(self):
        rows = {row["context"]: row for row in reward_audit()}

        self.assertAlmostEqual(rows["goal_next_10"]["breakEvenSum"], 1.0)
        self.assertEqual(rows["goal_next_10"]["status"], "coherent")
        self.assertGreater(rows["next_goal_team"]["breakEvenSum"], 1.0)
        self.assertGreater(rows["next_corner"]["breakEvenSum"], 1.0)
        self.assertGreater(rows["next_free_kick"]["breakEvenSum"], 1.0)
        self.assertGreater(rows["next_yellow_card"]["breakEvenSum"], 1.0)
        self.assertFalse(rows["next_foul"]["openedByCurrentV0"])

    def test_small_playtest_is_reproducible_and_preserves_invariants(self):
        first = run_playtests(policies=["accuracy_60"], runs=3, seed=91)
        second = run_playtests(policies=["accuracy_60"], runs=3, seed=91)

        self.assertEqual(first, second)
        result = first["policies"]["accuracy_60"]
        self.assertEqual(result["invariantFailures"], [])
        for style in ("cautious", "balanced", "aggressive"):
            row = result["styles"][style]
            self.assertGreater(row["offers"], 0)
            self.assertGreaterEqual(row["meanFinalSugar"], 0)
            self.assertGreaterEqual(row["entryRate"], 0)
            self.assertLessEqual(row["entryRate"], 1)
            self.assertIn("goal_next_10", result["styleContexts"][style])
            self.assertTrue(result["styleOptions"][style])
        for row in result["options"].values():
            self.assertGreaterEqual(row["offers"], row.get("entries", 0))
            self.assertLessEqual(row["entryRate"], 1)

    def test_accuracy_policies_are_paired_and_oracle_uses_event_order(self):
        market = {
            "marketId": f"opp_{DEMO_FIXTURE['fixtureId']}_1_goal_next_10",
            "context": "goal_next_10",
            "minute": 4,
            "availableVotes": [
                {"vote": "yes", "optionId": "goal_next_10_yes", "rewardSugar": 4},
                {"vote": "no", "optionId": "goal_next_10_no", "rewardSugar": 1},
                {"vote": "abstain", "optionId": None, "rewardSugar": 0},
            ],
        }
        context = {"market": market, "colony": {"name": "paired"}}
        ants = [{"antId": f"ant_{index:04d}"} for index in range(20)]
        events = demo_events(DEMO_FIXTURE["fixtureId"])
        fifty = LocalVoterAgent(policy="accuracy_50", seed=3, run_index=2, events=events)
        sixty = LocalVoterAgent(policy="accuracy_60", seed=3, run_index=2, events=events)

        votes_50 = fifty.decide_ants(game_id="ignored", stage="pre_info", context=context, ants=ants)
        votes_60 = sixty.decide_ants(game_id="ignored", stage="pre_info", context=context, ants=ants)

        correct_50 = {vote["antId"] for vote in votes_50 if vote["vote"] == "yes"}
        correct_60 = {vote["antId"] for vote in votes_60 if vote["vote"] == "yes"}
        self.assertTrue(correct_50.issubset(correct_60))

    def test_cancelled_penalty_has_no_oracle_winner(self):
        events = [
            {
                "fixtureId": 1,
                "seq": 1,
                "minute": 20,
                "clockSeconds": 1200,
                "action": "penalty",
                "participantLabel": "North Colony FC",
                "confirmed": True,
            },
            {
                "fixtureId": 1,
                "seq": 2,
                "minute": 21,
                "clockSeconds": 1260,
                "action": "penalty_cancelled",
                "description": "Penalty cancelled",
                "participantLabel": "North Colony FC",
                "confirmed": True,
            },
        ]
        agent = LocalVoterAgent(policy="accuracy_70", seed=1, run_index=0, events=events)
        market = {
            "marketId": "opp_1_1_penalties",
            "context": "penalties",
            "minute": 20,
            "teamLabel": "North Colony FC",
        }
        votes = [
            {"vote": "yes", "optionId": "penalty_goal", "rewardSugar": 1},
            {"vote": "no", "optionId": "penalty_no_goal", "rewardSugar": 5},
        ]

        self.assertIsNone(agent._correct_vote(market, votes))

    def test_real_fixture_oracle_uses_real_team_labels_and_skips_unconfirmed_events(self):
        events = [
            {
                "fixtureId": 99,
                "seq": 1,
                "minute": 20,
                "clockSeconds": 1200,
                "action": "danger_possession",
            },
            {
                "fixtureId": 99,
                "seq": 2,
                "minute": 21,
                "clockSeconds": 1260,
                "action": "goal",
                "highlights": ["goal"],
                "participantLabel": "France",
                "confirmed": False,
            },
            {
                "fixtureId": 99,
                "seq": 3,
                "minute": 22,
                "clockSeconds": 1320,
                "action": "goal",
                "highlights": ["goal"],
                "participantLabel": "Morocco",
                "confirmed": True,
            },
        ]
        agent = LocalVoterAgent(
            policy="accuracy_100",
            seed=1,
            run_index=0,
            events=events,
            participant1="France",
            participant2="Morocco",
        )
        market = {
            "marketId": "opp_99_1_next_goal_team",
            "context": "next_goal_team",
            "minute": 20,
        }
        votes = [
            {"vote": "option_a", "optionId": "next_goal_p1", "rewardSugar": 4},
            {"vote": "option_b", "optionId": "next_goal_p2", "rewardSugar": 4},
            {"vote": "option_c", "optionId": "next_goal_none", "rewardSugar": 1},
        ]

        self.assertEqual(agent._correct_vote(market, votes), "option_b")


if __name__ == "__main__":
    unittest.main()
