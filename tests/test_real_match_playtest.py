import unittest

import app.game.harness as harness_module
from tools.playtest_real_matches import use_rule_set


class RealMatchPlaytestToolTest(unittest.TestCase):
    def test_candidate_cadence_rules_are_scoped_and_simplified(self):
        original_corner_options = harness_module.opportunity_options("next_corner", "A", "B")

        with use_rule_set("candidate_cadence"):
            corner_options = harness_module.opportunity_options("next_corner", "A", "B")
            goal_options = harness_module.opportunity_options("goal_next_10", "A", "B")
            penalty_result_contexts = harness_module.event_contexts(
                {
                    "action": "penalty_outcome",
                    "highlights": ["penalty"],
                    "confirmed": True,
                    "description": "Penalty missed",
                }
            )

            self.assertEqual([option.option_id for option in corner_options], ["next_corner_p1", "next_corner_p2"])
            self.assertEqual([option.reward_sugar for option in corner_options], [2, 2])
            self.assertEqual([option.reward_sugar for option in goal_options], [5, 1])
            self.assertEqual(penalty_result_contexts, [])

        restored_corner_options = harness_module.opportunity_options("next_corner", "A", "B")
        self.assertEqual(len(original_corner_options), 3)
        self.assertEqual(restored_corner_options, original_corner_options)


if __name__ == "__main__":
    unittest.main()
