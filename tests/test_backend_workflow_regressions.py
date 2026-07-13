import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.game.harness import PRIVATE_SNAPSHOT_KEY, GameHarness, redact_public_identity
from app.main import _restore_room_from_stored_row, app, game_manager
from app.persistence import SupabaseGameStore, SupabasePersistenceSettings


class BackendWorkflowRegressionTest(unittest.TestCase):
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

    def _track(self, state: dict) -> dict:
        game_id = state["gameId"]
        if game_id not in self.game_ids:
            self.game_ids.append(game_id)
        return state

    def test_rerun_preserves_match_metadata_and_individual_ant_orders(self):
        created_response = self.client.post(
            "/api/admin/rooms",
            json={
                "fixtureId": "rerun-fidelity",
                "participant1": "France",
                "participant2": "Japan",
                "competition": "World Cup Final",
                "startTime": 1783807200000,
                "startTimeIso": "2026-07-11T18:00:00+00:00",
                "seed": 31,
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
        created = self._track(created_response.json())
        colony_id = created["colonies"][0]["colonyId"]

        global_update = self.client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/strategy",
            json={"style": "cautious", "favoriteContext": "corners", "infoNeed": "high"},
        )
        self.assertEqual(global_update.status_code, 200, global_update.text)
        roster = self.client.get(f"/api/games/{created['gameId']}/colonies/{colony_id}/ants")
        self.assertEqual(roster.status_code, 200, roster.text)
        ant_id = roster.json()["ants"][0]["antId"]
        ant_update = self.client.patch(
            f"/api/games/{created['gameId']}/colonies/{colony_id}/ants/{ant_id}/strategy",
            json={"style": "aggressive", "favoriteContext": "chaos", "infoNeed": "low"},
        )
        self.assertEqual(ant_update.status_code, 200, ant_update.text)

        source_room = game_manager.rooms[created["gameId"]]
        source_colony = source_room.colonies[colony_id]

        def static_profile(ant):
            return (
                ant.ant_id,
                ant.archetype,
                ant.risk_appetite,
                ant.info_hunger,
                ant.favorite_context,
                ant.confidence_threshold,
                ant.loss_sensitivity,
                ant.momentum_bias,
                ant.chaos_bias,
                ant.base_influence,
            )

        source_profiles = [static_profile(ant) for ant in source_colony.ants]
        source_ant = source_colony.ants[0]
        source_ant.influence = 1.85
        source_ant.alive = False
        source_ant.wounded_until_event = 12
        source_ant.engaged_prediction_ids.add("prediction_from_previous_match")
        source_ant.memory.attempts_by_context["corners"] = 3
        source_ant.memory.wins_by_context["corners"] = 2
        source_ant.memory.losses_by_context["corners"] = 1
        source_ant.memory.recent_losses = 1
        source_ant.memory.info_attempts = 2
        source_ant.memory.info_successes = 1

        public_snapshot = source_room.public_state()
        self.assertNotIn(PRIVATE_SNAPSHOT_KEY, public_snapshot)
        self.assertNotIn("antProfiles", public_snapshot["colonies"][0])

        snapshot = source_room.persistence_state()
        stored_profile = snapshot[PRIVATE_SNAPSHOT_KEY]["antProfiles"][colony_id][ant_id]
        self.assertEqual(stored_profile["baseInfluence"], 1.0)
        self.assertNotIn("memory", stored_profile)
        self.assertNotIn("alive", stored_profile)
        self.assertNotIn("influence", stored_profile)

        game_manager.rooms.pop(source_room.game_id, None)
        game_manager.room_codes.pop(source_room.room_code, None)
        restored_room = _restore_room_from_stored_row(
            {"game_id": source_room.game_id, "public_state": snapshot},
            events=[],
        )
        restored_colony = restored_room.colonies[colony_id]
        self.assertEqual(
            [static_profile(ant) for ant in restored_colony.ants],
            source_profiles,
        )
        restored_source_ant = restored_colony.ants[0]
        self.assertEqual(restored_source_ant.influence, 1.0)
        self.assertTrue(restored_source_ant.alive)
        self.assertEqual(restored_source_ant.memory.attempts_by_context, {})

        async def fake_start_replay(room, _payload):
            return room.public_state()

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._start_replay_room", new=fake_start_replay),
        ):
            rerun_response = self.client.post(
                f"/api/games/{created['gameId']}/rerun",
                json={"mode": "replay", "source": "historical", "agentCallMode": "batch"},
            )

        self.assertEqual(rerun_response.status_code, 200, rerun_response.text)
        rerun = self._track(rerun_response.json())
        self.assertEqual(rerun["roomKind"], "admin")
        self.assertEqual(rerun["competition"], "World Cup Final")
        self.assertEqual(rerun["startTime"], 1783807200000)
        self.assertEqual(rerun["startTimeIso"], "2026-07-11T18:00:00+00:00")

        cloned_colony = rerun["colonies"][0]
        cloned_room = game_manager.rooms[rerun["gameId"]]
        cloned_colony_state = cloned_room.colonies[cloned_colony["colonyId"]]
        self.assertEqual(cloned_colony_state.seed, restored_colony.seed)
        self.assertEqual(
            [static_profile(ant) for ant in cloned_colony_state.ants],
            source_profiles,
        )
        self.assertEqual(cloned_colony["style"], "cautious")
        self.assertEqual(cloned_colony["favoriteContext"], "corners")
        self.assertEqual(cloned_colony["infoNeed"], "high")
        self.assertEqual(
            cloned_colony["antStrategies"][ant_id],
            {"style": "aggressive", "favoriteContext": "chaos", "infoNeed": "low"},
        )

        cloned_ant = cloned_colony_state.ants[0]
        self.assertIsNot(cloned_ant, restored_source_ant)
        self.assertIsNot(cloned_ant.memory, restored_source_ant.memory)
        self.assertEqual(cloned_ant.influence, cloned_ant.base_influence)
        self.assertEqual(cloned_ant.influence, 1.0)
        self.assertTrue(cloned_ant.alive)
        self.assertEqual(cloned_ant.wounded_until_event, 0)
        self.assertEqual(cloned_ant.engaged_prediction_ids, set())
        self.assertEqual(cloned_ant.memory.attempts_by_context, {})
        self.assertEqual(cloned_ant.memory.wins_by_context, {})
        self.assertEqual(cloned_ant.memory.losses_by_context, {})
        self.assertEqual(cloned_ant.memory.recent_losses, 0)
        self.assertEqual(cloned_ant.memory.info_attempts, 0)
        self.assertEqual(cloned_ant.memory.info_successes, 0)
        self.assertEqual(cloned_ant.style_override, "aggressive")
        self.assertEqual(cloned_ant.favorite_context_override, "chaos")
        self.assertEqual(cloned_ant.info_need_override, "low")

        detail = self.client.get(
            f"/api/games/{rerun['gameId']}/colonies/{cloned_colony['colonyId']}/ants/{ant_id}"
        )
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["ant"]["strategy"]["style"], "aggressive")
        self.assertTrue(detail.json()["strategyHistory"][0]["strategy"]["source"] == "custom")

    def test_private_snapshot_restores_anonymous_ownership_without_api_exposure(self):
        anonymous_id = "anon_private_restore_owner"
        created_response = self.client.post(
            "/api/games",
            json={
                "fixtureId": "private-anonymous-restore",
                "participant1": "France",
                "participant2": "Japan",
                "creatorName": "Alice",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(created_response.status_code, 200, created_response.text)
        created = self._track(created_response.json())
        colony_response = self.client.post(
            f"/api/games/{created['gameId']}/colonies",
            json={
                "name": "Alice Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": anonymous_id,
            },
        )
        self.assertEqual(colony_response.status_code, 200, colony_response.text)
        colony_id = colony_response.json()["colonies"][0]["colonyId"]

        source_room = game_manager.rooms[created["gameId"]]
        public_state = source_room.public_state()
        public_payload = str(public_state)
        self.assertNotIn(PRIVATE_SNAPSHOT_KEY, public_state)
        self.assertNotIn("antProfiles", public_payload)
        self.assertNotIn(anonymous_id, public_payload)

        snapshot = source_room.persistence_state()
        private_state = snapshot[PRIVATE_SNAPSHOT_KEY]
        self.assertIn(anonymous_id, private_state["playerAnonymousIds"].values())
        self.assertEqual(private_state["colonyAnonymousIds"][colony_id], anonymous_id)
        self.assertIn(colony_id, private_state["antProfiles"])

        stored_requests: list[dict] = []

        def capture_request(path, *, method="GET", body=None, prefer=""):
            stored_requests.append(
                {"path": path, "method": method, "body": body, "prefer": prefer}
            )
            return []

        store = SupabaseGameStore(
            SupabasePersistenceSettings(url="https://example.supabase.co", key="test-key")
        )
        with patch.object(store, "_request_json", side_effect=capture_request):
            store.sync_room(source_room)
        persisted_game = next(
            request["body"]
            for request in stored_requests
            if request["path"].startswith("aoc_games?")
        )
        self.assertEqual(
            persisted_game["public_state"][PRIVATE_SNAPSHOT_KEY]["colonyAnonymousIds"][colony_id],
            anonymous_id,
        )
        self.assertIn(
            colony_id,
            persisted_game["public_state"][PRIVATE_SNAPSHOT_KEY]["antProfiles"],
        )

        redacted = str(redact_public_identity(snapshot))
        self.assertNotIn(PRIVATE_SNAPSHOT_KEY, redacted)
        self.assertNotIn("antProfiles", redacted)
        self.assertNotIn(anonymous_id, redacted)

        game_manager.rooms.pop(source_room.game_id, None)
        game_manager.room_codes.pop(source_room.room_code, None)
        restored = _restore_room_from_stored_row(
            {
                "game_id": source_room.game_id,
                "seed": source_room.seed,
                "owner_anonymous_id": source_room.owner_anonymous_id,
                "public_state": snapshot,
            },
            events=[],
        )
        restored_colony = restored.colonies[colony_id]
        self.assertEqual(restored.players[0].anonymous_id, anonymous_id)
        self.assertEqual(restored_colony.player_anonymous_id, anonymous_id)

        allowed_roster = self.client.get(
            f"/api/games/{restored.game_id}/colonies/{colony_id}/ants",
            params={"anonymousId": anonymous_id},
        )
        self.assertEqual(allowed_roster.status_code, 200, allowed_roster.text)
        denied_roster = self.client.get(
            f"/api/games/{restored.game_id}/colonies/{colony_id}/ants",
            params={"anonymousId": "anon_intruder"},
        )
        self.assertEqual(denied_roster.status_code, 403, denied_roster.text)
        strategy_update = self.client.patch(
            f"/api/games/{restored.game_id}/colonies/{colony_id}/strategy",
            json={"style": "cautious", "anonymousId": anonymous_id},
        )
        self.assertEqual(strategy_update.status_code, 200, strategy_update.text)
        self.assertNotIn("antProfiles", strategy_update.text)
        self.assertNotIn(anonymous_id, strategy_update.text)

    def test_player_rooms_require_identity_while_admin_rooms_remain_ownerless(self):
        rejected_room = self.client.post(
            "/api/games",
            json={"fixtureId": "ownerless-player-rejected", "participant1": "A", "participant2": "B"},
        )
        self.assertEqual(rejected_room.status_code, 401, rejected_room.text)

        player_room = game_manager.create_room(
            fixture_id="legacy-ownerless-player",
            participant1="A",
            participant2="B",
            room_kind="player",
        )
        self._track(player_room.public_state())
        ownerless_colony = game_manager.harness(player_room.game_id).add_colony(
            "Legacy Ownerless",
            20,
            "balanced",
            "momentum",
            "medium",
        )

        blocked_strategy = self.client.patch(
            f"/api/games/{player_room.game_id}/colonies/{ownerless_colony.colony_id}/strategy",
            json={"style": "aggressive"},
        )
        blocked_rerun = None
        with patch("app.main._ensure_deepseek_agent"):
            blocked_rerun = self.client.post(
                f"/api/games/{player_room.game_id}/rerun",
                json={"mode": "replay"},
            )
        self.assertEqual(blocked_strategy.status_code, 403, blocked_strategy.text)
        self.assertEqual(blocked_rerun.status_code, 403, blocked_rerun.text)

        joined = self.client.post(
            f"/api/games/{player_room.game_id}/players",
            json={"name": "Anonymous Alice", "anonymousId": "anon_backend_regression"},
        )
        self.assertEqual(joined.status_code, 200, joined.text)
        self.assertIsNone(player_room.owner_anonymous_id)

        player_colony_response = self.client.post(
            f"/api/games/{player_room.game_id}/colonies",
            json={
                "name": "Alice Nest",
                "size": 20,
                "style": "balanced",
                "favoriteContext": "momentum",
                "infoNeed": "medium",
                "anonymousId": "anon_backend_regression",
            },
        )
        self.assertEqual(player_colony_response.status_code, 200, player_colony_response.text)
        player_colony = next(
            colony
            for colony in player_colony_response.json()["colonies"]
            if colony.get("playerId")
        )
        anonymous_update = self.client.patch(
            f"/api/games/{player_room.game_id}/colonies/{player_colony['colonyId']}/strategy",
            json={"style": "cautious", "anonymousId": "anon_backend_regression"},
        )
        self.assertEqual(anonymous_update.status_code, 200, anonymous_update.text)

        admin_response = self.client.post(
            "/api/admin/rooms",
            json={
                "fixtureId": "ownerless-admin-allowed",
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
        self.assertEqual(admin_response.status_code, 200, admin_response.text)
        admin = self._track(admin_response.json())
        admin_colony_id = admin["colonies"][0]["colonyId"]
        admin_update = self.client.patch(
            f"/api/games/{admin['gameId']}/colonies/{admin_colony_id}/strategy",
            json={"style": "aggressive"},
        )
        self.assertEqual(admin_update.status_code, 200, admin_update.text)

    def test_demo_run_dispatches_blocking_simulation_to_worker_thread(self):
        dispatched: list[str] = []

        async def fake_to_thread(function, *args, **kwargs):
            dispatched.append(getattr(function, "__name__", type(function).__name__))
            return function(*args, **kwargs)

        def fake_process_events(harness, _events):
            harness.room.status = "finished"

        async def fake_sync(_room):
            return {"stored": False}

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main.asyncio.to_thread", new=fake_to_thread),
            patch.object(GameHarness, "process_events", new=fake_process_events),
            patch("app.main._sync_room_to_supabase_async", new=fake_sync),
        ):
            response = self.client.post("/api/demo/run", json={"seed": 99})

        self.assertEqual(response.status_code, 200, response.text)
        self._track(response.json())
        self.assertEqual(dispatched, ["fake_process_events"])
        self.assertEqual(response.json()["status"], "finished")

    def test_non_streamed_previous_run_dispatches_simulation_to_worker_thread(self):
        dispatched: list[tuple[str, list[dict]]] = []
        replay_events = [{"action": "goal", "seq": 1}]

        async def fake_recent_fixtures(*_args, **_kwargs):
            return [{
                "fixtureId": 4242,
                "participant1": "France",
                "participant2": "Japan",
            }]

        async def fake_score_sources(_client, _fixture_id):
            return {
                "historical": [{"FixtureId": 4242, "Seq": 1, "Action": "goal"}],
                "updates": [],
                "snapshot": [],
            }

        async def fake_to_thread(function, *args, **kwargs):
            dispatched.append((getattr(function, "__name__", type(function).__name__), args[0]))
            return function(*args, **kwargs)

        def fake_process_events(harness, _events):
            harness.room.status = "finished"

        async def fake_sync(_room):
            return {"stored": False}

        with (
            patch("app.main._ensure_deepseek_agent"),
            patch("app.main._recent_past_fixtures", new=fake_recent_fixtures),
            patch("app.main._fetch_score_sources", new=fake_score_sources),
            patch("app.main.build_timeline", return_value={"events": replay_events, "rawCount": 1}),
            patch("app.main.asyncio.to_thread", new=fake_to_thread),
            patch.object(GameHarness, "process_events", new=fake_process_events),
            patch("app.main._sync_room_to_supabase_async", new=fake_sync),
        ):
            response = self.client.post(
                "/api/games/run-previous",
                json={"days": 1, "limit": 5, "stream": False, "seed": 17},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self._track(response.json())
        self.assertEqual(dispatched, [("fake_process_events", replay_events)])
        self.assertEqual(response.json()["status"], "finished")


if __name__ == "__main__":
    unittest.main()
