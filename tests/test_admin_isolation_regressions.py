import asyncio
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import _stop_orphaned_admin_runs, app, game_manager


def _stored_admin_replay(game_id: str, room_code: str, *, status: str) -> dict:
    state = {
        "gameId": game_id,
        "roomCode": room_code,
        "roomKind": "admin",
        "fixtureId": f"fixture_{game_id}",
        "participant1": "France",
        "participant2": "Japan",
        "status": status,
        "mode": "replay",
        "eventIndex": 0,
        "players": [],
        "colonies": [
            {
                "colonyId": "col_stored_admin",
                "name": "Stored Admin Nest",
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
            }
        ],
        "activeOpportunities": [],
        "match": {"score": None},
    }
    row = {"game_id": game_id, "room_code": room_code, "seed": 73, "public_state": state}
    return {
        "game": state,
        "events": [
            {
                "index": 0,
                "kind": "game_created",
                "message": "Stored admin room created.",
                "data": {"roomKind": "admin"},
            }
        ],
        "stored": {"source": "supabase", "game": row, "eventCount": 1},
    }


class AdminIsolationRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.game_ids: set[str] = set()

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

    def test_start_restores_room_present_only_in_supabase(self):
        game_id = "game_start_storage_only"
        room_code = "781311"
        self.game_ids.add(game_id)
        stored = _stored_admin_replay(game_id, room_code, status="created")

        async def fake_stored_replay(requested_game_id):
            self.assertEqual(requested_game_id, game_id)
            return stored

        async def fake_start(room, _payload):
            self.assertEqual(room.game_id, game_id)
            return room.public_state()

        with (
            patch("app.main._stored_replay_or_none", new=fake_stored_replay),
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._start_replay_room", new=fake_start),
        ):
            response = self.client.post(
                f"/api/games/{game_id}/start",
                json={"mode": "replay", "source": "demo", "agentCallMode": "batch"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["gameId"], game_id)
        self.assertEqual(response.json()["roomKind"], "admin")
        self.assertIsNotNone(game_manager.get_room(game_id))

    def test_rerun_restores_finished_room_present_only_in_supabase(self):
        game_id = "game_rerun_storage_only"
        room_code = "781312"
        self.game_ids.add(game_id)
        stored = _stored_admin_replay(game_id, room_code, status="finished")

        async def fake_stored_replay(requested_game_id):
            self.assertEqual(requested_game_id, game_id)
            return stored

        async def fake_start(room, _payload):
            self.game_ids.add(room.game_id)
            return room.public_state()

        with (
            patch("app.main._stored_replay_or_none", new=fake_stored_replay),
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._start_replay_room", new=fake_start),
        ):
            response = self.client.post(
                f"/api/games/{game_id}/rerun",
                json={"mode": "replay", "source": "demo", "agentCallMode": "batch"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotEqual(response.json()["gameId"], game_id)
        self.assertEqual(response.json()["roomKind"], "admin")
        self.assertEqual(response.json()["colonies"][0]["name"], "Stored Admin Nest")

    def test_admin_games_memory_source_excludes_player_rooms(self):
        player = game_manager.create_room(fixture_id="memory-player", room_kind="player")
        admin = game_manager.create_room(fixture_id="memory-admin", room_kind="admin")
        self.game_ids.update({player.game_id, admin.game_id})

        class MemoryOnlyStore:
            configured = False

        with (
            patch("app.main.supabase_store", MemoryOnlyStore()),
            patch.dict(
                game_manager.rooms,
                {player.game_id: player, admin.game_id: admin},
                clear=True,
            ),
        ):
            response = self.client.get("/api/admin/games")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([game["gameId"] for game in response.json()["games"]], [admin.game_id])

    def test_admin_list_and_orphan_stop_ignore_player_and_ambiguous_rows(self):
        explicit_admin = {
            "gameId": "game_explicit_admin_orphan",
            "roomKind": "admin",
            "status": "running_replay",
            "mode": "replay",
            "eventIndex": 0,
            "players": [],
            "colonies": [],
            "activeOpportunities": [],
            "match": {"score": None},
        }
        explicit_player = {
            **explicit_admin,
            "gameId": "game_explicit_player_orphan",
            "roomKind": "player",
        }
        ambiguous_player = {
            **explicit_admin,
            "gameId": "game_ambiguous_player_orphan",
        }
        ambiguous_player.pop("roomKind")

        class MixedStoredGames:
            configured = True

            def __init__(self):
                self.marked: list[str] = []

            def list_admin_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 3,
                    "games": [
                        {"public_state": explicit_player},
                        {"public_state": ambiguous_player},
                        {"public_state": explicit_admin},
                    ],
                }

            def list_games(self, *, limit):
                raise AssertionError("The admin endpoint must use the filtered storage query.")

            def mark_game_stopped(self, state):
                self.marked.append(state["gameId"])
                return {**state, "status": "stopped"}

        store = MixedStoredGames()
        with (
            patch("app.main.supabase_store", store),
            patch.dict(game_manager.rooms, {}, clear=True),
            patch.dict(game_manager.room_codes, {}, clear=True),
        ):
            direct = asyncio.run(
                _stop_orphaned_admin_runs([explicit_player, ambiguous_player, explicit_admin])
            )
            response = self.client.get("/api/admin/games")

        self.assertEqual([game["gameId"] for game in direct], [explicit_admin["gameId"]])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [game["gameId"] for game in response.json()["games"]],
            [explicit_admin["gameId"]],
        )
        self.assertEqual(store.marked, [explicit_admin["gameId"], explicit_admin["gameId"]])

    def test_admin_endpoint_accepts_derived_legacy_proof_without_identity_leak(self):
        proven_legacy_admin = {
            "game_id": "game_proven_legacy_admin",
            "room_kind": "admin",
            "public_state": {
                "gameId": "game_proven_legacy_admin",
                "status": "finished",
                "mode": "replay",
                "eventIndex": 4,
                "ownerAnonymousId": "legacy_admin_bearer",
                "players": [],
                "colonies": [{"colonyId": "legacy_admin_col", "name": "Legacy Admin"}],
                "activeOpportunities": [],
                "match": {"score": "1 - 0"},
            },
        }
        ambiguous = {
            "game_id": "game_unproven_legacy",
            "public_state": {
                "gameId": "game_unproven_legacy",
                "status": "finished",
                "players": [],
                "colonies": [{"colonyId": "ambiguous_col"}],
            },
        }

        class LegacyProofStore:
            configured = True

            def list_admin_games(self, *, limit):
                return {
                    "source": "supabase",
                    "configured": True,
                    "count": 2,
                    "games": [proven_legacy_admin, ambiguous],
                }

            def list_games(self, *, limit):
                raise AssertionError("The generic room list must not be used.")

        with (
            patch("app.main.supabase_store", LegacyProofStore()),
            patch.dict(game_manager.rooms, {}, clear=True),
            patch.dict(game_manager.room_codes, {}, clear=True),
        ):
            response = self.client.get("/api/admin/games")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [game["gameId"] for game in response.json()["games"]],
            [proven_legacy_admin["game_id"]],
        )
        self.assertEqual(response.json()["games"][0]["roomKind"], "admin")
        self.assertNotIn("legacy_admin_bearer", response.text)
        self.assertNotIn("ownerAnonymousId", response.text)


if __name__ == "__main__":
    unittest.main()
