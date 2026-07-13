import unittest
import urllib.parse
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.game.harness import GameManager, room_kind_from_snapshot
from app.main import _admin_game_public_state, _restore_room_from_stored_row, app, game_manager
from app.persistence import SupabaseGameStore, SupabasePersistenceSettings


class RoomKindTest(unittest.TestCase):
    def test_manager_defaults_to_player_and_admin_rooms_reject_players(self):
        manager = GameManager()
        player_room = manager.create_room(fixture_id="player-kind")
        admin_room = manager.create_room(fixture_id="admin-kind", room_kind="admin")

        self.assertEqual(player_room.room_kind, "player")
        self.assertEqual(player_room.public_state()["roomKind"], "player")
        self.assertEqual(admin_room.room_kind, "admin")
        self.assertEqual(admin_room.public_state()["roomKind"], "admin")
        self.assertEqual(admin_room.log[0].public_state()["data"]["roomKind"], "admin")
        with self.assertRaisesRegex(ValueError, "admin simulation rooms do not accept players"):
            manager.harness(admin_room.game_id).join_player("Alice")

    def test_public_and_admin_creation_expose_explicit_room_kinds(self):
        async def fake_sync(room):
            return {"stored": True, "gameId": room.game_id, "eventCount": len(room.log)}

        client = TestClient(app)
        with patch("app.main._sync_room_to_supabase_async", fake_sync):
            player_response = client.post(
                "/api/games",
                json={
                    "fixtureId": "room-kind-public",
                    "participant1": "France",
                    "participant2": "Japan",
                    "anonymousId": "anon_room_kind_public",
                },
            )
            admin_response = client.post(
                "/api/admin/rooms",
                json={
                    "fixtureId": "room-kind-admin",
                    "participant1": "France",
                    "participant2": "Japan",
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

        self.assertEqual(player_response.status_code, 200, player_response.text)
        self.assertEqual(admin_response.status_code, 200, admin_response.text)
        player_state = player_response.json()
        admin_state = admin_response.json()
        self.addCleanup(game_manager.rooms.pop, player_state["gameId"], None)
        self.addCleanup(game_manager.room_codes.pop, player_state["roomCode"], None)
        self.addCleanup(game_manager.rooms.pop, admin_state["gameId"], None)
        self.addCleanup(game_manager.room_codes.pop, admin_state["roomCode"], None)

        self.assertEqual(player_state["roomKind"], "player")
        self.assertEqual(admin_state["roomKind"], "admin")

        blocked_join = client.post(
            f"/api/rooms/{admin_state['roomCode']}/players",
            json={"name": "Not an admin colony"},
        )
        self.assertEqual(blocked_join.status_code, 409, blocked_join.text)
        self.assertIn("admin simulation rooms", blocked_join.json()["detail"])

    def test_legacy_snapshot_inference_requires_a_durable_admin_marker(self):
        self.assertEqual(room_kind_from_snapshot({}), "player")
        self.assertEqual(
            room_kind_from_snapshot({"players": [], "colonies": [{"colonyId": "admin_col"}]}),
            "player",
        )
        self.assertEqual(
            room_kind_from_snapshot(
                {
                    "players": [],
                    "colonies": [{"colonyId": "player_col", "playerWallet": "wallet_1"}],
                }
            ),
            "player",
        )
        self.assertEqual(
            room_kind_from_snapshot(
                {"owner": {"name": "Legacy host"}, "players": [], "colonies": [{"colonyId": "col"}]}
            ),
            "player",
        )
        self.assertEqual(
            room_kind_from_snapshot(
                {
                    "events": [
                        {
                            "kind": "game_created",
                            "data": {"roomKind": "admin"},
                        }
                    ]
                }
            ),
            "admin",
        )

    def test_restore_keeps_ambiguous_legacy_room_player_and_blocks_admin_patch(self):
        ambiguous_legacy = {
            "gameId": "game_room_kind_legacy_ambiguous",
            "roomCode": "781201",
            "fixtureId": "legacy-ambiguous",
            "status": "created",
            "mode": "replay",
            "players": [],
            "colonies": [{"colonyId": "admin_col", "name": "Admin Nest"}],
            "activeOpportunities": [],
        }
        explicit_player = {
            **ambiguous_legacy,
            "gameId": "game_room_kind_explicit_player",
            "roomCode": "781202",
            "roomKind": "player",
        }
        explicit_admin_from_event = {
            **ambiguous_legacy,
            "gameId": "game_room_kind_event_admin",
            "roomCode": "781203",
        }
        for state in (ambiguous_legacy, explicit_player, explicit_admin_from_event):
            self.addCleanup(game_manager.rooms.pop, state["gameId"], None)
            self.addCleanup(game_manager.room_codes.pop, state["roomCode"], None)

        restored_ambiguous = _restore_room_from_stored_row({"public_state": ambiguous_legacy}, events=[])
        restored_player = _restore_room_from_stored_row({"public_state": explicit_player}, events=[])
        restored_admin = _restore_room_from_stored_row(
            {"public_state": explicit_admin_from_event},
            events=[{"index": 0, "kind": "game_created", "data": {"roomKind": "admin"}}],
        )

        self.assertEqual(restored_ambiguous.room_kind, "player")
        self.assertEqual(restored_ambiguous.public_state()["roomKind"], "player")
        self.assertEqual(restored_player.room_kind, "player")
        self.assertEqual(restored_player.public_state()["roomKind"], "player")
        self.assertEqual(restored_admin.room_kind, "admin")

        blocked = TestClient(app).patch(
            f"/api/games/{ambiguous_legacy['gameId']}/colonies/admin_col/strategy",
            json={"style": "aggressive"},
        )
        self.assertEqual(blocked.status_code, 403, blocked.text)

        flattened = _admin_game_public_state({"public_state": ambiguous_legacy})
        self.assertIsNotNone(flattened)
        self.assertEqual(flattened["roomKind"], "player")
        self.assertIsNone(_admin_game_public_state({"public_state": ambiguous_legacy}, admin_only=True))

    def test_persistence_fixture_lookup_filters_admin_simulations(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        admin_rows = [
            {
                "game_id": f"game_admin_{index:02d}",
                "status": "running_live",
                "mode": "live",
                "public_state": {
                    "gameId": f"game_admin_{index:02d}",
                    "roomKind": "admin",
                    "status": "running_live",
                    "mode": "live",
                    "players": [],
                    "colonies": [{"colonyId": f"admin_col_{index:02d}"}],
                },
            }
            for index in range(25)
        ]
        player_row = {
            "game_id": "game_player",
            "status": "running_live",
            "mode": "live",
            "public_state": {
                "gameId": "game_player",
                "roomKind": "player",
                "status": "running_live",
                "mode": "live",
                "players": [{"playerId": "player_1", "name": "Alice"}],
                "colonies": [],
            },
        }
        calls = []

        def fake_request(path, **_kwargs):
            calls.append(path)
            query = urllib.parse.parse_qs(path.partition("?")[2])
            room_filter = query.get("or", [""])[0]
            rows = [*admin_rows, player_row]
            if "public_state->>roomKind.eq.player" in room_filter:
                rows = [
                    row
                    for row in rows
                    if row["public_state"].get("roomKind") in {None, "player"}
                ]
            offset = int(query.get("offset", ["0"])[0])
            limit = int(query["limit"][0])
            return rows[offset : offset + limit]

        with patch.object(store, "_request_json", side_effect=fake_request):
            found = store.latest_game_for_fixture("same-fixture", mode="live", room_kind="player")

        self.assertIsNotNone(found)
        self.assertEqual(found["game_id"], "game_player")
        self.assertEqual(len(calls), 1)
        parsed_query = urllib.parse.parse_qs(calls[0].partition("?")[2])
        self.assertEqual(
            parsed_query["or"],
            ["(public_state->>roomKind.eq.player,public_state->>roomKind.is.null)"],
        )

    def test_persistence_fixture_lookup_skips_ambiguous_legacy_snapshots_for_reuse(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        legacy_admin_rows = [
            {
                "game_id": f"game_legacy_admin_{index:02d}",
                "status": "running_live",
                "mode": "live",
                "public_state": {
                    "gameId": f"game_legacy_admin_{index:02d}",
                    "status": "running_live",
                    "mode": "live",
                    "players": [],
                    "colonies": [{"colonyId": f"legacy_admin_col_{index:02d}"}],
                },
            }
            for index in range(20)
        ]
        legacy_player_row = {
            "game_id": "game_legacy_player",
            "status": "running_live",
            "mode": "live",
            "public_state": {
                "gameId": "game_legacy_player",
                "status": "running_live",
                "mode": "live",
                "owner": {"name": "Legacy host"},
                "players": [],
                "colonies": [],
            },
        }
        rows = [*legacy_admin_rows, legacy_player_row]
        calls = []

        def fake_request(path, **_kwargs):
            calls.append(path)
            query = urllib.parse.parse_qs(path.partition("?")[2])
            offset = int(query.get("offset", ["0"])[0])
            limit = int(query["limit"][0])
            return rows[offset : offset + limit]

        with patch.object(store, "_request_json", side_effect=fake_request):
            found = store.latest_game_for_fixture(
                "legacy-same-fixture",
                mode="live",
                room_kind="player",
            )

        self.assertIsNotNone(found)
        self.assertEqual(found["game_id"], "game_legacy_player")
        self.assertEqual(len(calls), 2)
        second_query = urllib.parse.parse_qs(calls[1].partition("?")[2])
        self.assertEqual(second_query["offset"], ["20"])

    def test_persistence_admin_list_filters_before_limit(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        explicit_admin = {
            "game_id": "game_admin_after_many_players",
            "public_state": {
                "gameId": "game_admin_after_many_players",
                "roomKind": "admin",
                "status": "finished",
            },
        }
        calls = []

        def fake_request(path, **_kwargs):
            calls.append(path)
            if "public_state->>roomKind=eq.admin" in path:
                return [explicit_admin]
            if path.startswith("aoc_game_events?"):
                return []
            # The bounded legacy scan sees only ambiguous player snapshots.
            query = urllib.parse.parse_qs(path.partition("?")[2])
            if int(query.get("offset", ["0"])[0]) > 0:
                return []
            return [
                {
                    "game_id": f"game_player_{index}",
                    "public_state": {
                        "gameId": f"game_player_{index}",
                        "players": [],
                        "colonies": [{"colonyId": f"col_{index}"}],
                    },
                }
                for index in range(50)
            ]

        with patch.object(store, "_request_json", side_effect=fake_request):
            payload = store.list_admin_games(limit=1)

        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["games"][0]["game_id"], explicit_admin["game_id"])
        self.assertIn("public_state->>roomKind=eq.admin", calls[0])

    def test_persistence_admin_list_recovers_only_journal_marked_legacy_admin(self):
        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        marked_admin = {
            "game_id": "game_legacy_marked_admin",
            "updated_at": "2026-07-13T10:00:00+00:00",
            "public_state": {
                "gameId": "game_legacy_marked_admin",
                "status": "finished",
                "players": [],
                "colonies": [{"colonyId": "admin_col"}],
            },
        }
        explicit_player = {
            "game_id": "game_legacy_journal_player",
            "updated_at": "2026-07-13T11:00:00+00:00",
            "public_state": {
                "gameId": "game_legacy_journal_player",
                "status": "finished",
                "owner": {"anonymousId": "must_not_leak", "name": "Alice"},
                "players": [{"playerId": "player_1", "name": "Alice"}],
                "colonies": [],
            },
        }
        ambiguous = {
            "game_id": "game_legacy_ambiguous",
            "updated_at": "2026-07-13T12:00:00+00:00",
            "public_state": {
                "gameId": "game_legacy_ambiguous",
                "status": "finished",
                "players": [],
                "colonies": [{"colonyId": "ambiguous_col"}],
            },
        }
        calls = []

        def fake_request(path, **_kwargs):
            calls.append(path)
            if "public_state->>roomKind=eq.admin" in path:
                return []
            if path.startswith("aoc_game_events?"):
                return [{"game_id": marked_admin["game_id"]}]
            return [ambiguous, explicit_player, marked_admin]

        with patch.object(store, "_request_json", side_effect=fake_request):
            payload = store.list_admin_games(limit=10)

        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["games"][0]["game_id"], marked_admin["game_id"])
        self.assertEqual(payload["games"][0]["room_kind"], "admin")
        event_query = next(path for path in calls if path.startswith("aoc_game_events?"))
        parsed = urllib.parse.parse_qs(event_query.partition("?")[2])
        self.assertEqual(parsed["select"], ["game_id"])
        self.assertNotIn("data", parsed["select"][0])
        self.assertIn("data->>roomKind=eq.admin", event_query)
        self.assertIn("game_legacy_marked_admin", event_query)
        self.assertIn("game_legacy_journal_player", event_query)
        self.assertIn("game_legacy_ambiguous", event_query)


if __name__ == "__main__":
    unittest.main()
