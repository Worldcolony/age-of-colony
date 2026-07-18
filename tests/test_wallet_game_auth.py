import base64
import json
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.main import app, game_manager, supabase_store
from app.wallet_auth import WALLET_SESSION_COOKIE


_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _base58_encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = _B58_ALPHABET[remainder] + encoded
    leading_zeroes = len(value) - len(value.lstrip(b"\x00"))
    return "1" * leading_zeroes + (encoded or "")


def _wallet(private_key: Ed25519PrivateKey) -> str:
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _base58_encode(public_key)


def _sign(private_key: Ed25519PrivateKey, message: str) -> str:
    signature = private_key.sign(message.encode("utf-8"))
    return base64.b64encode(signature).decode("ascii")


class WalletGameAuthIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clients: list[TestClient] = []
        self.game_ids: list[str] = []

    def tearDown(self) -> None:
        for game_id in self.game_ids:
            room = game_manager.rooms.pop(game_id, None)
            if room:
                game_manager.room_codes.pop(room.room_code, None)
            for tasks in (
                game_manager.replay_tasks,
                game_manager.live_tasks,
                game_manager.kickoff_tasks,
            ):
                task = tasks.pop(game_id, None)
                if task and not task.done():
                    task.cancel()
        for client in self.clients:
            client.close()

    def _client(self) -> TestClient:
        client = TestClient(app)
        self.clients.append(client)
        return client

    def _authenticate(
        self,
        private_key: Ed25519PrivateKey | None = None,
    ) -> tuple[TestClient, Ed25519PrivateKey, str]:
        key = private_key or Ed25519PrivateKey.generate()
        wallet = _wallet(key)
        client = self._client()
        challenge_response = client.post(
            "/api/auth/wallet/challenge",
            json={"wallet": wallet},
        )
        self.assertEqual(challenge_response.status_code, 200, challenge_response.text)
        challenge = challenge_response.json()
        verify_response = client.post(
            "/api/auth/wallet/verify",
            json={
                "wallet": wallet,
                "nonce": challenge["nonce"],
                "signature": _sign(key, challenge["message"]),
            },
        )
        self.assertEqual(verify_response.status_code, 200, verify_response.text)
        self.assertEqual(verify_response.json()["wallet"], wallet)
        return client, key, wallet

    def _track_game(self, payload: dict) -> dict:
        game_id = payload["gameId"]
        if game_id not in self.game_ids:
            self.game_ids.append(game_id)
        return payload

    def _fixture_id(self) -> int:
        return 900_000_000 + (uuid.uuid4().int % 90_000_000)

    def _create_wallet_room_and_colony(
        self,
        client: TestClient,
        wallet: str,
        *,
        anonymous_id: str = "anon_wallet_device_a",
    ) -> tuple[dict, dict]:
        created_response = client.post(
            "/api/rooms",
            json={
                "fixtureId": self._fixture_id(),
                "participant1": "France",
                "participant2": "Belgium",
                "creatorName": "Wallet Alice",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(created_response.status_code, 200, created_response.text)
        created = self._track_game(created_response.json())
        self.assertEqual(created["owner"]["wallet"], wallet)
        self.assertIsNone(created["owner"].get("anonymousId"))
        self.assertEqual(created["players"][0]["wallet"], wallet)
        self.assertNotIn("anonymousId", created["players"][0])

        colony_response = client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Wallet Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(colony_response.status_code, 200, colony_response.text)
        game = colony_response.json()
        colony = game["colonies"][0]
        self.assertEqual(colony["playerWallet"], wallet)
        self.assertNotIn("playerAnonymousId", colony)
        return created, colony

    def test_challenge_verification_sets_http_only_cookie_and_logout_clears_it(self):
        private_key = Ed25519PrivateKey.generate()
        wallet = _wallet(private_key)
        client = self._client()

        challenge = client.post(
            "/api/auth/wallet/challenge",
            json={"wallet": wallet},
        ).json()
        verify = client.post(
            "/api/auth/wallet/verify",
            json={
                "wallet": wallet,
                "nonce": challenge["nonce"],
                "signature": _sign(private_key, challenge["message"]),
            },
        )

        self.assertEqual(verify.status_code, 200, verify.text)
        self.assertNotIn("token", verify.json())
        set_cookie = verify.headers.get("set-cookie", "")
        self.assertIn(f"{WALLET_SESSION_COOKIE}=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=lax", set_cookie)
        session = client.get("/api/auth/wallet/session")
        self.assertEqual(session.status_code, 200, session.text)
        self.assertTrue(session.json()["authenticated"])
        self.assertEqual(session.json()["wallet"], wallet)

        replay = client.post(
            "/api/auth/wallet/verify",
            json={
                "wallet": wallet,
                "nonce": challenge["nonce"],
                "signature": _sign(private_key, challenge["message"]),
            },
        )
        self.assertEqual(replay.status_code, 409, replay.text)
        self.assertEqual(replay.json()["code"], "challenge_used")

        logout = client.delete("/api/auth/wallet/session")
        self.assertEqual(logout.status_code, 200, logout.text)
        self.assertFalse(client.get("/api/auth/wallet/session").json()["authenticated"])

    def test_invalid_signature_and_raw_wallet_field_cannot_impersonate_owner(self):
        owner_key = Ed25519PrivateKey.generate()
        attacker_key = Ed25519PrivateKey.generate()
        owner_wallet = _wallet(owner_key)
        client = self._client()
        challenge = client.post(
            "/api/auth/wallet/challenge",
            json={"wallet": owner_wallet},
        ).json()

        rejected = client.post(
            "/api/auth/wallet/verify",
            json={
                "wallet": owner_wallet,
                "nonce": challenge["nonce"],
                "signature": _sign(attacker_key, challenge["message"]),
            },
        )
        self.assertEqual(rejected.status_code, 403, rejected.text)
        self.assertEqual(rejected.json()["code"], "invalid_signature")
        self.assertIsNone(client.cookies.get(WALLET_SESSION_COOKIE))

        created_response = client.post(
            "/api/rooms",
            json={
                "fixtureId": self._fixture_id(),
                "participant1": "Spain",
                "participant2": "Japan",
                "creatorName": "Legacy Browser",
                "anonymousId": "anon_raw_wallet_attempt",
                "wallet": owner_wallet,
            },
        )
        self.assertEqual(created_response.status_code, 200, created_response.text)
        created = self._track_game(created_response.json())
        self.assertNotEqual(created["owner"].get("wallet"), owner_wallet)
        self.assertNotIn("anonymousId", created["owner"])
        self.assertEqual(game_manager.get_room(created["gameId"]).owner_anonymous_id, "anon_raw_wallet_attempt")

    def test_same_wallet_recovers_player_and_colony_from_another_browser(self):
        first_client, private_key, wallet = self._authenticate()
        created, colony = self._create_wallet_room_and_colony(first_client, wallet)

        second_client, _, second_wallet = self._authenticate(private_key)
        self.assertEqual(second_wallet, wallet)
        joined = second_client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Alice New Device", "anonymousId": "anon_wallet_device_b"},
        )
        self.assertEqual(joined.status_code, 200, joined.text)
        self.assertEqual(len(joined.json()["players"]), 1)
        self.assertEqual(joined.json()["players"][0]["wallet"], wallet)
        self.assertEqual(joined.json()["players"][0]["name"], "Alice New Device")

        roster = second_client.get(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/ants",
            params={"anonymousId": "a-different-browser-id"},
        )
        self.assertEqual(roster.status_code, 200, roster.text)
        self.assertEqual(len(roster.json()["ants"]), 5)

        duplicate = second_client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Duplicate Wallet Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_wallet_device_b",
            },
        )
        self.assertEqual(duplicate.status_code, 422, duplicate.text)
        self.assertIn("already has a colony", duplicate.json()["detail"])

    def test_wallet_owner_can_control_colony_but_wallet_b_and_anonymous_spoof_cannot(self):
        owner_client, _, owner_wallet = self._authenticate()
        attacker_client, _, _ = self._authenticate()
        unsigned_client = self._client()
        created, colony = self._create_wallet_room_and_colony(owner_client, owner_wallet)
        game_id = created["gameId"]
        colony_id = colony["colonyId"]

        unsigned_join = unsigned_client.post(
            f"/api/rooms/{created['roomCode']}/players",
            json={"name": "Unsigned", "anonymousId": "anon_wallet_device_a"},
        )
        self.assertEqual(unsigned_join.status_code, 401, unsigned_join.text)
        unsigned_colony = unsigned_client.post(
            f"/api/games/{game_id}/colonies",
            json={
                "name": "Unsigned Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_wallet_device_a",
            },
        )
        self.assertEqual(unsigned_colony.status_code, 401, unsigned_colony.text)

        owner_strategy = owner_client.patch(
            f"/api/games/{game_id}/colonies/{colony_id}/strategy",
            json={
                "style": "aggressive",
                "favoriteContext": "chaos",
                "infoNeed": "low",
                "anonymousId": "ignored-when-wallet-is-authenticated",
            },
        )
        self.assertEqual(owner_strategy.status_code, 200, owner_strategy.text)

        roster = owner_client.get(f"/api/games/{game_id}/colonies/{colony_id}/ants")
        self.assertEqual(roster.status_code, 200, roster.text)
        ant_id = roster.json()["ants"][0]["antId"]
        owner_ant_update = owner_client.patch(
            f"/api/games/{game_id}/colonies/{colony_id}/ants/{ant_id}/strategy",
            json={"style": "cautious", "anonymousId": "ignored"},
        )
        self.assertEqual(owner_ant_update.status_code, 200, owner_ant_update.text)

        blocked_requests = [
            attacker_client.get(f"/api/games/{game_id}/colonies/{colony_id}/ants"),
            attacker_client.patch(
                f"/api/games/{game_id}/colonies/{colony_id}/strategy",
                json={"style": "balanced", "anonymousId": "anon_wallet_device_a"},
            ),
            attacker_client.patch(
                f"/api/games/{game_id}/colonies/{colony_id}/ants/{ant_id}/strategy",
                json={"style": "balanced", "anonymousId": "anon_wallet_device_a"},
            ),
            attacker_client.post(
                f"/api/games/{game_id}/rally",
                json={
                    "colonyId": colony_id,
                    "opportunityId": "opp_spoofed",
                    "anonymousId": "anon_wallet_device_a",
                },
            ),
            attacker_client.post(
                f"/api/games/{game_id}/recall",
                json={
                    "colonyId": colony_id,
                    "opportunityId": "opp_spoofed",
                    "anonymousId": "anon_wallet_device_a",
                },
            ),
            attacker_client.post(
                f"/api/games/{game_id}/switch-call",
                json={
                    "colonyId": colony_id,
                    "opportunityId": "opp_spoofed",
                    "optionId": "option_spoofed",
                    "anonymousId": "anon_wallet_device_a",
                },
            ),
            unsigned_client.patch(
                f"/api/games/{game_id}/colonies/{colony_id}/strategy",
                json={
                    "style": "balanced",
                    "anonymousId": "anon_wallet_device_a",
                    "wallet": owner_wallet,
                },
            ),
        ]
        self.assertTrue(blocked_requests)
        for response in blocked_requests:
            self.assertEqual(response.status_code, 403, response.text)

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._start_live_room_now", new=AsyncMock()),
        ):
            blocked_start = attacker_client.post(
                f"/api/games/{game_id}/start",
                json={"mode": "live", "anonymousId": "anon_wallet_device_a"},
            )
            blocked_replay = attacker_client.post(
                f"/api/games/{game_id}/start",
                json={"mode": "replay", "anonymousId": "anon_wallet_device_a"},
            )
            owner_start = owner_client.post(
                f"/api/games/{game_id}/start",
                json={"mode": "live", "anonymousId": "ignored"},
            )
        self.assertEqual(blocked_start.status_code, 403, blocked_start.text)
        self.assertEqual(blocked_replay.status_code, 403, blocked_replay.text)
        self.assertEqual(owner_start.status_code, 200, owner_start.text)

        room = game_manager.get_room(game_id)
        self.assertIsNotNone(room)
        room.status = "finished"
        blocked_finish = attacker_client.post(
            f"/api/games/{game_id}/finish",
            json={"anonymousId": "anon_wallet_device_a"},
        )
        owner_finish = owner_client.post(
            f"/api/games/{game_id}/finish",
            json={"anonymousId": "ignored"},
        )
        self.assertEqual(blocked_finish.status_code, 403, blocked_finish.text)
        self.assertEqual(owner_finish.status_code, 200, owner_finish.text)

    def test_legacy_anonymous_room_colony_and_controls_remain_compatible(self):
        owner_client = self._client()
        intruder_client = self._client()
        anonymous_id = "anon_legacy_wallet_compat"
        created_response = owner_client.post(
            "/api/rooms",
            json={
                "fixtureId": self._fixture_id(),
                "participant1": "Brazil",
                "participant2": "Canada",
                "creatorName": "Legacy Alice",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(created_response.status_code, 200, created_response.text)
        created = self._track_game(created_response.json())
        self.assertNotIn("anonymousId", created["owner"])
        self.assertIsNone(created["owner"].get("wallet"))
        self.assertEqual(game_manager.get_room(created["gameId"]).owner_anonymous_id, anonymous_id)

        colony_response = owner_client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Legacy Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(colony_response.status_code, 200, colony_response.text)
        colony = colony_response.json()["colonies"][0]
        self.assertNotIn("playerAnonymousId", colony)
        self.assertNotIn("playerWallet", colony)
        self.assertEqual(
            game_manager.get_room(created["gameId"]).colonies[colony["colonyId"]].player_anonymous_id,
            anonymous_id,
        )

        strategy = owner_client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/strategy",
            json={"style": "cautious", "anonymousId": anonymous_id},
        )
        self.assertEqual(strategy.status_code, 200, strategy.text)
        roster = owner_client.get(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/ants",
            params={"anonymousId": anonymous_id},
        )
        self.assertEqual(roster.status_code, 200, roster.text)
        blocked = intruder_client.get(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/ants",
            params={"anonymousId": "anon_legacy_intruder"},
        )
        self.assertEqual(blocked.status_code, 403, blocked.text)
        public_replay = owner_client.get(f"/api/games/{created['gameId']}/replay")
        self.assertEqual(public_replay.status_code, 200, public_replay.text)
        self.assertNotIn(anonymous_id, json.dumps(public_replay.json()))

    def test_queen_mutations_reuse_session_and_cannot_cross_wallets(self):
        owner_client, _, owner_wallet = self._authenticate()
        attacker_client, _, _ = self._authenticate()
        unsigned_client = self._client()
        queen = {
            "wallet": owner_wallet,
            "name": "Queen Session",
            "motto": "No second signature",
            "emblem": "👑",
            "crownedAt": "2026-07-12T00:00:00Z",
            "updatedAt": "2026-07-12T00:00:00Z",
        }

        with (
            patch("app.main._queen_store_or_503"),
            patch.object(supabase_store, "upsert_queen", return_value=queen) as upsert,
            patch.object(supabase_store, "delete_queen", return_value=True) as delete,
        ):
            unsigned = unsigned_client.put(
                f"/api/queens/{owner_wallet}",
                json={"name": "Spoofed"},
            )
            crossed = attacker_client.put(
                f"/api/queens/{owner_wallet}",
                json={"name": "Spoofed"},
            )
            saved = owner_client.put(
                f"/api/queens/{owner_wallet}",
                json={"name": "Queen Session", "motto": "No second signature", "emblem": "👑"},
            )
            removed = owner_client.delete(f"/api/queens/{owner_wallet}")

        self.assertEqual(unsigned.status_code, 401, unsigned.text)
        self.assertEqual(crossed.status_code, 403, crossed.text)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["wallet"], owner_wallet)
        self.assertEqual(removed.status_code, 200, removed.text)
        upsert.assert_called_once()
        delete.assert_called_once_with(owner_wallet)

    def test_admin_room_and_ownerless_colony_stay_wallet_free(self):
        client = self._client()
        created_response = client.post(
            "/api/admin/rooms",
            json={
                "fixtureId": self._fixture_id(),
                "participant1": "Argentina",
                "participant2": "Switzerland",
                "colonies": [
                    {
                        "name": "Admin Nest",
                        "size": 20,
                        "style": "balanced",
                        "favoriteContext": "momentum",
                        "infoNeed": "medium",
                    }
                ],
            },
        )
        self.assertEqual(created_response.status_code, 200, created_response.text)
        created = self._track_game(created_response.json())
        self.assertIsNone(created["owner"])
        self.assertEqual(created["players"], [])
        colony = created["colonies"][0]
        self.assertNotIn("playerWallet", colony)
        self.assertNotIn("playerAnonymousId", colony)

        roster = client.get(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/ants"
        )
        self.assertEqual(roster.status_code, 200, roster.text)
        strategy = client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony['colonyId']}/strategy",
            json={"style": "aggressive"},
        )
        self.assertEqual(strategy.status_code, 200, strategy.text)


if __name__ == "__main__":
    unittest.main()
