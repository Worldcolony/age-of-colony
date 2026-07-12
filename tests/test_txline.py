import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.txline import (
    TxLineClient,
    TxLineSettings,
    _decode_sse_payloads,
    build_full_match_data,
    build_match_details,
    build_record_inventory,
    build_timeline,
    filter_upcoming_fixtures,
    normalize_score_record,
    normalize_fixtures,
)


class TxLineNormalizationTest(unittest.TestCase):
    def test_client_forces_ipv4_transport_by_default(self):
        settings = TxLineSettings(jwt="jwt", api_token="token")
        sentinel = object()

        with patch("app.txline.httpx.AsyncHTTPTransport", return_value=sentinel) as transport:
            result = TxLineClient(settings)._transport()

        self.assertIs(result, sentinel)
        transport.assert_called_once_with(local_address="0.0.0.0", retries=1)

    def test_client_can_disable_ipv4_transport(self):
        settings = TxLineSettings(jwt="jwt", api_token="token", force_ipv4=False)

        self.assertIsNone(TxLineClient(settings)._transport())

    def test_zero_clock_and_minute_values_are_preserved(self):
        from_clock = normalize_score_record({"FixtureId": 42, "Clock": {"Seconds": 0}})
        from_minute = normalize_score_record(
            {"FixtureId": 42, "Clock": {"Seconds": 120}, "dataSoccer": {"Minutes": 0}}
        )

        self.assertEqual(from_clock["clockSeconds"], 0)
        self.assertEqual(from_clock["minute"], 1)
        self.assertEqual(from_minute["minute"], 0)

    def test_empty_clock_and_minute_values_use_valid_fallbacks(self):
        record = normalize_score_record(
            {
                "FixtureId": 42,
                "Clock": {"Seconds": "", "seconds": 120},
                "dataSoccer": {"Minutes": "", "New": {"Minutes": 12}},
            }
        )

        self.assertEqual(record["clockSeconds"], 120)
        self.assertEqual(record["minute"], 12)

    def test_timeline_sorts_mixed_numeric_sequence_types(self):
        timeline = build_timeline(
            [
                {"FixtureId": 42, "Seq": "2", "Action": "corner"},
                {"FixtureId": 42, "Seq": 1, "Action": "shot"},
            ],
            important_only=False,
        )

        self.assertEqual([event["seq"] for event in timeline["events"]], [1, "2"])

    def test_timeline_sorts_large_integer_ids_without_precision_loss(self):
        smaller = 9_007_199_254_740_992
        larger = smaller + 1
        timeline = build_timeline(
            [
                {"FixtureId": 42, "Ts": 1, "Seq": 1, "Id": larger, "Action": "corner"},
                {"FixtureId": 42, "Ts": 1, "Seq": 1, "Id": smaller, "Action": "shot"},
            ],
            important_only=False,
        )

        self.assertEqual([event["id"] for event in timeline["events"]], [smaller, larger])

    def test_fixtures_sort_mixed_upstream_number_types(self):
        fixtures = normalize_fixtures(
            [
                {"FixtureId": "10", "StartTime": "2000"},
                {"FixtureId": 2, "StartTime": 1000},
            ]
        )

        self.assertEqual([fixture["fixtureId"] for fixture in fixtures], [2, "10"])

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

    def test_penalty_area_text_is_not_a_penalty_highlight(self):
        normalized = normalize_score_record(
            {
                "fixtureId": 42,
                "action": "attack_possession",
                "possessionType": "Penalty area",
                "dataSoccer": {"New": {"Type": "Attack"}},
            }
        )

        self.assertNotIn("penalty", normalized["highlights"])

    def test_unconfirmed_overturned_goal_does_not_update_score(self):
        fixture = {"fixtureId": 42, "participant1": "Brazil", "participant2": "Norway"}
        records = [
            {
                "FixtureId": 42,
                "Seq": 59,
                "Action": "goal",
                "Participant": 2,
                "Confirmed": False,
                "Clock": {"Seconds": 160},
                "Score": {"Participant2": {"Total": {"Goals": 1}}},
            },
            {
                "FixtureId": 42,
                "Seq": 64,
                "Action": "var_end",
                "Confirmed": True,
                "Data": {"Outcome": "Overturned"},
                "Clock": {"Seconds": 207},
                "Score": {"Participant2": {"Total": {"Goals": 1}}},
            },
        ]

        timeline = build_timeline(records, fixture=fixture, important_only=False)

        self.assertIs(timeline["events"][0]["confirmed"], False)
        self.assertEqual(timeline["events"][0]["score"], {"participant1": None, "participant2": None})
        self.assertEqual(timeline["events"][1]["score"], {"participant1": None, "participant2": None})
        self.assertIsNone(timeline["score"])

    def test_confirmed_partial_goal_score_is_completed_with_zero(self):
        timeline = build_timeline(
            [
                {
                    "FixtureId": 42,
                    "Seq": 59,
                    "Action": "goal",
                    "Participant": 2,
                    "Confirmed": True,
                    "Score": {"Participant2": {"Total": {"Goals": 1}}},
                }
            ],
            fixture={"fixtureId": 42, "participant1": "Brazil", "participant2": "Norway"},
            important_only=False,
        )

        self.assertEqual(timeline["score"], {"participant1": 0, "participant2": 1})

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

    def test_decodes_sse_batch_payloads(self):
        text = 'data: {"FixtureId":42,"Action":"corner"}\n\ndata: {"FixtureId":42,"Action":"penalty"}\n\n'

        events = _decode_sse_payloads(text)

        self.assertEqual(events, [{"FixtureId": 42, "Action": "corner"}, {"FixtureId": 42, "Action": "penalty"}])

    def test_top_level_participant_data_and_discarded_actions_are_descriptive(self):
        records = [
            {"FixtureId": 42, "Seq": 1, "Id": 10, "Action": "penalty", "Participant": 2, "Confirmedd": True},
            {"FixtureId": 42, "Seq": 2, "Id": 10, "Action": "action_discarded"},
            {
                "FixtureId": 42,
                "Seq": 3,
                "Id": 11,
                "Action": "free_kick",
                "Participant": 1,
                "Possession": 1,
                "Data": {"FreeKickType": "Safe"},
                "Confirmedd": True,
            },
        ]

        timeline = build_timeline(
            records,
            fixture={"fixtureId": 42, "participant1": "France", "participant2": "Belgium"},
            important_only=True,
        )

        self.assertEqual(timeline["events"][0]["participantLabel"], "Belgium")
        self.assertIn("Belgium", timeline["events"][0]["description"])
        self.assertEqual(timeline["events"][1]["discardedAction"], "penalty")
        self.assertIn("Action discarded", timeline["events"][1]["description"])
        self.assertIn("free_kick", timeline["events"][2]["highlights"])
        self.assertIn("Free kick: Safe", timeline["events"][2]["details"])

    def test_lineups_enrich_player_ids_and_match_details(self):
        records = [
            {
                "FixtureId": 42,
                "Action": "lineups",
                "Lineups": [
                    {
                        "normativeId": 1,
                        "preferredName": "France",
                        "lineups": [
                            {
                                "fixturePlayerId": 10,
                                "rosterNumber": "7",
                                "starter": True,
                                "positionId": 36,
                                "player": {"normativeId": 100, "preferredName": "Player, One"},
                            }
                        ],
                    }
                ],
            },
            {
                "FixtureId": 42,
                "Action": "lineups",
                "Lineups": [
                    {
                        "normativeId": 1,
                        "preferredName": "France",
                        "lineups": [
                            {
                                "fixturePlayerId": 10,
                                "rosterNumber": "7",
                                "starter": True,
                                "positionId": 36,
                                "player": {"normativeId": 100, "preferredName": "Player, One"},
                            }
                        ],
                    }
                ],
            },
            {"FixtureId": 42, "Seq": 2, "Action": "goal", "Participant": 1, "Data": {"PlayerId": 100}},
            {"FixtureId": 42, "Seq": 3, "Action": "weather", "Data": {"Conditions": ["Cloudy", "Night"]}},
            {"FixtureId": 42, "Seq": 4, "Action": "additional_time", "Clock": {"seconds": 2705}, "Data": {"Minutes": 6}},
            {"FixtureId": 42, "Seq": 5, "Action": "additional_time", "Clock": {"seconds": 5404}, "Data": {"Minutes": 4}},
        ]

        fixture = {"fixtureId": 42, "participant1": "France", "participant2": "Belgium"}
        timeline = build_timeline(records, fixture=fixture, important_only=True)
        details = build_match_details(records, fixture=fixture)

        self.assertEqual(timeline["playersIndexed"], 1)
        self.assertEqual(timeline["events"][0]["player"]["name"], "Player, One")
        self.assertIn("#7 Player, One", timeline["events"][0]["description"])
        self.assertEqual(len(details["lineups"][0]["starters"]), 1)
        self.assertEqual(details["lineups"][0]["starters"][0]["name"], "Player, One")
        self.assertEqual(details["environment"]["weatherConditions"], ["Cloudy", "Night"])
        self.assertEqual(details["additionalTime"], [{"minute": 46, "minutes": 6, "period": "H1"}, {"minute": 91, "minutes": 4, "period": "H2"}])

    def test_full_match_data_keeps_raw_records_and_field_inventory(self):
        records = [
            {
                "FixtureId": 42,
                "Seq": 1,
                "Action": "attack_possession",
                "GameState": "PreMatch",
                "StatusId": 1,
                "CoverageType": "Full",
                "PossessionType": "Attack",
                "Stats": {"Participant1": {"Shots": 3}},
                "Parti1State": {"Pressure": "High"},
                "PossibleEvent": {"Goal": True},
                "Score": {"Participant1": {"H1": {"Goals": 1}, "Total": {"Goals": 1}}},
                "Data": {"Outcome": "Safe"},
            },
            {
                "FixtureId": 42,
                "Seq": 2,
                "Action": "shot",
                "Data": {"PlayerId": 100, "Outcome": "Blocked"},
            },
        ]

        inventory = build_record_inventory(records)
        full = build_full_match_data(records, fixture={"fixtureId": 42, "participant1": "France"}, include_raw=True)

        self.assertEqual(inventory["actionCounts"]["attack_possession"], 1)
        self.assertEqual(inventory["dataFieldCounts"]["Outcome"], 2)
        self.assertIn("Participant1.H1.Goals", inventory["scoreFieldPaths"])
        self.assertIn("Participant1.Shots", inventory["statsFieldPaths"])
        self.assertIn("Parti1State.Pressure", inventory["participantStateFieldPaths"])
        self.assertIn("Goal", inventory["possibleEventFieldPaths"])
        self.assertEqual(full["recordCount"], 2)
        self.assertEqual(len(full["rawRecords"]), 2)
        self.assertEqual(full["timeline"]["count"], 2)
        self.assertEqual(full["latestState"]["fixtureId"], 42)

    def test_filter_upcoming_fixtures_removes_past_and_duplicates(self):
        now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
        fixtures = [
            {"fixtureId": 1, "startTime": int((now - timedelta(hours=1)).timestamp())},
            {"fixtureId": 2, "startTime": int((now + timedelta(hours=2)).timestamp())},
            {"fixtureId": 2, "startTime": int((now + timedelta(hours=2)).timestamp())},
            {"fixtureId": 3, "startTime": int((now + timedelta(days=3)).timestamp() * 1000)},
        ]

        upcoming = filter_upcoming_fixtures(fixtures, now=now, until=now + timedelta(days=2))

        self.assertEqual([fixture["fixtureId"] for fixture in upcoming], [2])


if __name__ == "__main__":
    unittest.main()
