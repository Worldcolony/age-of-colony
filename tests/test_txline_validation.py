import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import _txline_validation_cache, app
from app.txline_validation import (
    final_score_from_stats,
    find_finalized_score_record,
    txline_network,
    winner_from_score,
)


class TxLineValidationHelpersTest(unittest.TestCase):
    def test_finds_latest_strictly_finalized_record(self):
        records = [
            {"Action": "game_finalised", "StatusId": 99, "Seq": 30},
            {"Action": "game_finalised", "StatusId": 100, "Seq": 28},
            {"action": "game_finalised", "statusId": 100, "seq": 31},
        ]

        finalized = find_finalized_score_record(records)

        self.assertIsNotNone(finalized)
        self.assertEqual(finalized["seq"], 31)

    def test_extracts_score_and_winner_from_v2_stats(self):
        score = final_score_from_stats(
            [
                {"key": 1, "value": 2, "period": 100},
                {"key": 2, "value": 1, "period": 100},
            ]
        )

        self.assertEqual(score, {"participant1": 2, "participant2": 1})
        self.assertEqual(winner_from_score(score), "participant1")

    def test_detects_txline_network_from_api_host(self):
        self.assertEqual(txline_network("https://txline.txodds.com"), "mainnet")
        self.assertEqual(txline_network("https://txline-dev.txodds.com"), "devnet")


class TxLineValidationApiTest(unittest.TestCase):
    def test_admin_endpoint_returns_verified_final_score(self):
        class FakeTxLineClient:
            def __init__(self, settings=None):
                self.settings = settings

            async def score_historical(self, fixture_id):
                self.test_case.assertEqual(fixture_id, 18218149)
                return [
                    {
                        "FixtureId": fixture_id,
                        "Action": "game_finalised",
                        "StatusId": 100,
                        "Seq": 1087,
                        "Ts": 1783717433523,
                    }
                ]

            async def score_stat_validation(self, fixture_id, seq, stat_keys):
                self.test_case.assertEqual((fixture_id, seq, tuple(stat_keys)), (18218149, 1087, (1, 2)))
                return {
                    "summary": {"fixtureId": fixture_id},
                    "statsToProve": [
                        {"key": 1, "value": 2, "period": 100},
                        {"key": 2, "value": 1, "period": 100},
                    ],
                }

        FakeTxLineClient.test_case = self
        onchain = {
            "verified": True,
            "network": "mainnet",
            "programId": "oracle-program",
            "dailyScoresPda": "daily-root",
            "rootAccountExists": True,
            "rootAccountOwner": "oracle-program",
            "epochDay": 20644,
            "stats": [
                {"key": 1, "value": 2, "period": 100},
                {"key": 2, "value": 1, "period": 100},
            ],
        }

        with (
            patch("app.main.TxLineClient", FakeTxLineClient),
            patch("app.main.validate_txline_proof_onchain", AsyncMock(return_value=onchain)),
        ):
            response = TestClient(app).post(
                "/api/admin/fixtures/18218149/txline-validation",
                params={"participant1": "Spain", "participant2": "Belgium"},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["verified"])
        self.assertEqual(payload["status"], "verified")
        self.assertEqual(payload["score"], {"participant1": 2, "participant2": 1})
        self.assertEqual(payload["winnerLabel"], "Spain")
        self.assertEqual(payload["dailyScoresPda"], "daily-root")
        self.assertEqual(_txline_validation_cache["18218149"]["seq"], 1087)
        _txline_validation_cache.pop("18218149", None)

    def test_admin_endpoint_reports_pending_before_game_finalised(self):
        class FakeTxLineClient:
            def __init__(self, settings=None):
                pass

            async def score_historical(self, fixture_id):
                return [{"FixtureId": fixture_id, "Action": "clock_tick", "StatusId": 3, "Seq": 100}]

        with patch("app.main.TxLineClient", FakeTxLineClient):
            response = TestClient(app).post("/api/admin/fixtures/42/txline-validation")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "pending")
        self.assertFalse(response.json()["verified"])

    def test_admin_room_preserves_verified_proof_in_public_state(self):
        proof = {
            "status": "verified",
            "verified": True,
            "fixtureId": 18218149,
            "network": "mainnet",
            "seq": 1087,
            "score": {"participant1": 2, "participant2": 1},
            "programId": "oracle-program",
            "dailyScoresPda": "daily-root",
        }
        _txline_validation_cache["18218149"] = proof
        self.addCleanup(_txline_validation_cache.pop, "18218149", None)
        response = TestClient(app).post(
            "/api/admin/rooms",
            json={
                "fixtureId": 18218149,
                "participant1": "Spain",
                "participant2": "Belgium",
                "colonies": [
                    {
                        "name": "Proof Nest",
                        "size": 10,
                        "style": "balanced",
                        "favoriteContext": "momentum",
                        "infoNeed": "medium",
                    }
                ],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["txlineValidation"], proof)


if __name__ == "__main__":
    unittest.main()
