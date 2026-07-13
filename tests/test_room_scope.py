import unittest
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.game.harness import room_scope_from_snapshot
from app.main import _restore_room_from_stored_row, app, game_manager
from app.persistence import SupabaseGameStore, SupabasePersistenceSettings


class PlayerRoomScopeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
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
        self.client.close()

    def _fixture_id(self) -> str:
        return f"scope-{uuid.uuid4().hex}"

    def _track(self, state: dict) -> dict:
        if state["gameId"] not in self.game_ids:
            self.game_ids.append(state["gameId"])
        return state

    def _create(self, endpoint: str, fixture_id: str, identity: str, name: str) -> dict:
        response = self.client.post(
            endpoint,
            json={
                "fixtureId": fixture_id,
                "participant1": "France",
                "participant2": "Japan",
                "creatorName": name,
                "anonymousId": identity,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return self._track(response.json())

    def test_global_room_is_reused_and_has_no_player_host(self):
        fixture_id = self._fixture_id()
        first = self._create("/api/games", fixture_id, "anon_global_a", "Alice")
        second = self._create("/api/games", fixture_id, "anon_global_b", "Bob")

        self.assertEqual(first["gameId"], second["gameId"])
        self.assertEqual(first["roomCode"], second["roomCode"])
        self.assertEqual(second["roomScope"], "global")
        self.assertIsNone(second["owner"])
        self.assertEqual({player["name"] for player in second["players"]}, {"Alice", "Bob"})
        self.assertTrue(all("isHost" not in player for player in second["players"]))
        room = game_manager.rooms[first["gameId"]]
        self.assertIsNone(room.owner_wallet)
        self.assertIsNone(room.owner_anonymous_id)
        self.assertIsNone(room.owner_name)

    def test_private_rooms_are_always_distinct_and_keep_their_host(self):
        fixture_id = self._fixture_id()
        first = self._create("/api/rooms", fixture_id, "anon_private_a", "Alice")
        second = self._create("/api/rooms", fixture_id, "anon_private_b", "Bob")

        self.assertNotEqual(first["gameId"], second["gameId"])
        self.assertNotEqual(first["roomCode"], second["roomCode"])
        self.assertEqual(first["roomScope"], "private")
        self.assertEqual(second["roomScope"], "private")
        self.assertTrue(first["players"][0]["isHost"])
        self.assertTrue(second["players"][0]["isHost"])
        self.assertEqual(game_manager.rooms[first["gameId"]].owner_anonymous_id, "anon_private_a")
        self.assertEqual(game_manager.rooms[second["gameId"]].owner_anonymous_id, "anon_private_b")

    def test_private_room_never_satisfies_global_lookup_and_codes_are_private_only(self):
        fixture_id = self._fixture_id()
        private = self._create("/api/rooms", fixture_id, "anon_private", "Friends")
        global_room = self._create("/api/games", fixture_id, "anon_global", "Public")
        global_again = self._create("/api/games", fixture_id, "anon_global_2", "Public 2")

        self.assertNotEqual(private["gameId"], global_room["gameId"])
        self.assertEqual(global_room["gameId"], global_again["gameId"])
        self.assertEqual(self.client.get(f"/api/rooms/{private['roomCode']}").status_code, 200)
        blocked = self.client.get(f"/api/rooms/{global_room['roomCode']}")
        self.assertEqual(blocked.status_code, 404, blocked.text)

    def test_private_room_waits_for_host_start_while_global_manual_lifecycle_is_refused(self):
        fixture_id = self._fixture_id()
        kickoff = datetime.now(timezone.utc) + timedelta(minutes=15)
        private_response = self.client.post(
            "/api/rooms",
            json={
                "fixtureId": fixture_id,
                "participant1": "France",
                "participant2": "Japan",
                "startTimeIso": kickoff.isoformat(),
                "creatorName": "Alice",
                "anonymousId": "anon_private_start",
            },
        )
        private = self._track(private_response.json())
        with patch("app.main._schedule_kickoff_start") as schedule:
            colony_response = self.client.post(
                f"/api/games/{private['gameId']}/colonies",
                json={
                    "name": "Alice Nest",
                    "size": 20,
                    "style": "balanced",
                    "favoriteContext": "momentum",
                    "infoNeed": "medium",
                    "anonymousId": "anon_private_start",
                },
            )
        self.assertEqual(colony_response.status_code, 200, colony_response.text)
        self.assertEqual(colony_response.json()["status"], "created")
        schedule.assert_not_called()

        with patch("app.main._ensure_deepseek_agent"), patch("app.main._schedule_kickoff_start") as schedule:
            started = self.client.post(
                f"/api/games/{private['gameId']}/start",
                json={"mode": "live", "anonymousId": "anon_private_start"},
            )
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["status"], "waiting_kickoff")
        schedule.assert_called_once()

        global_room = self._create("/api/games", self._fixture_id(), "anon_global_start", "Public")
        blocked_start = self.client.post(
            f"/api/games/{global_room['gameId']}/start",
            json={"mode": "live", "anonymousId": "anon_global_start"},
        )
        blocked_rerun = self.client.post(
            f"/api/games/{global_room['gameId']}/rerun",
            json={"mode": "replay", "anonymousId": "anon_global_start"},
        )
        self.assertEqual(blocked_start.status_code, 403, blocked_start.text)
        self.assertEqual(blocked_rerun.status_code, 403, blocked_rerun.text)

    def test_scope_persists_and_restores_with_legacy_player_rooms_defaulting_global(self):
        private = self._create("/api/rooms", self._fixture_id(), "anon_restore", "Alice")
        original = game_manager.rooms.pop(private["gameId"])
        game_manager.room_codes.pop(original.room_code, None)
        snapshot = original.persistence_state()

        restored = _restore_room_from_stored_row(
            {
                "game_id": original.game_id,
                "room_code": original.room_code,
                "seed": original.seed,
                "public_state": snapshot,
            }
        )
        self.assertEqual(restored.room_scope, "private")
        self.assertEqual(restored.public_state()["roomScope"], "private")

        self.assertEqual(room_scope_from_snapshot({"roomKind": "player"}), "global")
        self.assertIsNone(room_scope_from_snapshot({"roomKind": "admin"}))

    def test_supabase_global_lookup_combines_legacy_or_filters_and_skips_private(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        rows = [
            {
                "game_id": "game_private",
                "status": "created",
                "mode": "live",
                "public_state": {
                    "gameId": "game_private",
                    "roomKind": "player",
                    "roomScope": "private",
                    "status": "created",
                    "mode": "live",
                },
            },
            {
                "game_id": "game_global",
                "status": "created",
                "mode": "live",
                "public_state": {
                    "gameId": "game_global",
                    "roomKind": "player",
                    "roomScope": "global",
                    "status": "created",
                    "mode": "live",
                },
            },
        ]
        calls: list[str] = []

        def fake_request(path, **_kwargs):
            calls.append(path)
            return rows

        with patch.object(store, "_request_json", side_effect=fake_request):
            found = store.latest_game_for_fixture(
                "same-fixture",
                mode="live",
                room_kind="player",
                room_scope="global",
            )

        self.assertEqual(found["game_id"], "game_global")
        query = urllib.parse.parse_qs(calls[0].partition("?")[2])
        self.assertEqual(
            query["and"],
            [
                "(or(public_state->>roomKind.eq.player,public_state->>roomKind.is.null),"
                "or(public_state->>roomScope.eq.global,public_state->>roomScope.is.null))"
            ],
        )


if __name__ == "__main__":
    unittest.main()
