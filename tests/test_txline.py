import unittest

from app.txline import build_timeline, normalize_score_record


class TxLineNormalizationTest(unittest.TestCase):
    def test_detects_soccer_highlights(self):
        record = {
            "fixtureId": 42,
            "seq": 9,
            "ts": 1_720_000_000,
            "dataSoccer": {
                "Participant": 1,
                "FreeKickType": "Direct",
                "Penalty": True,
                "New": {"Minutes": 73},
            },
            "scoreSoccer": {
                "Participant1": {"Total": {"Goals": 2}},
                "Participant2": {"Total": {"Goals": 1}},
            },
        }

        normalized = normalize_score_record(record, fixture={"participant1": "France", "participant2": "Spain"})

        self.assertEqual(normalized["fixtureId"], 42)
        self.assertEqual(normalized["participantLabel"], "France")
        self.assertEqual(normalized["minute"], 73)
        self.assertIn("penalty", normalized["highlights"])
        self.assertIn("free_kick", normalized["highlights"])
        self.assertEqual(normalized["score"], {"participant1": 2, "participant2": 1})

    def test_timeline_keeps_latest_score_even_when_filtering(self):
        records = [
            {
                "fixtureId": 42,
                "seq": 1,
                "scoreSoccer": {
                    "Participant1": {"Total": {"Goals": 1}},
                    "Participant2": {"Total": {"Goals": 0}},
                },
            },
            {"fixtureId": 42, "seq": 2, "action": "free kick", "dataSoccer": {"Participant": 2}},
        ]

        timeline = build_timeline(records, fixture={"fixtureId": 42}, important_only=True)

        self.assertEqual(timeline["rawCount"], 2)
        self.assertEqual(timeline["count"], 1)
        self.assertEqual(timeline["score"], {"participant1": 1, "participant2": 0})

    def test_goal_kick_is_not_a_goal_highlight(self):
        normalized = normalize_score_record({"fixtureId": 42, "action": "goal_kick"})

        self.assertFalse(normalized["isHighlight"])
        self.assertNotIn("goal", normalized["highlights"])

    def test_timeline_detects_possession_changes(self):
        records = [
            {"fixtureId": 42, "seq": 1, "possession": 1, "action": "safe_possession"},
            {"fixtureId": 42, "seq": 2, "possession": 1, "action": "safe_possession"},
            {"fixtureId": 42, "seq": 3, "possession": 2, "action": "safe_possession"},
        ]

        timeline = build_timeline(
            records,
            fixture={"fixtureId": 42, "participant1": "France", "participant2": "Spain"},
            important_only=True,
        )

        self.assertEqual(timeline["count"], 1)
        event = timeline["events"][0]
        self.assertTrue(event["possessionChanged"])
        self.assertEqual(event["previousPossessionLabel"], "France")
        self.assertEqual(event["possessionLabel"], "Spain")
        self.assertIn("possession", event["highlights"])


if __name__ == "__main__":
    unittest.main()
