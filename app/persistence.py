from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .game.harness import (
    PRIVATE_SNAPSHOT_KEY,
    RoomKind,
    RoomScope,
    room_kind_from_snapshot,
    room_scope_from_snapshot,
)
from .txline import load_dotenv


_LATEST_FIXTURE_MAX_PAGES = 10
_ADMIN_LIST_MAX_PAGES = 10
_ADMIN_LIST_LEGACY_MIN_PAGE_SIZE = 50
_ADMIN_EVENT_BATCH_SIZE = 100


class SupabasePersistenceError(RuntimeError):
    """Raised when the optional Supabase persistence layer fails."""


@dataclass(frozen=True)
class SupabasePersistenceSettings:
    url: str | None
    key: str | None
    enabled: bool = True
    timeout_seconds: float = 20.0

    @classmethod
    def from_env(cls) -> "SupabasePersistenceSettings":
        load_dotenv()
        enabled = _env_bool("AOC_SUPABASE_ENABLED", True)
        url = os.getenv("AOC_SUPABASE_URL") or os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = (
            os.getenv("AOC_SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_SERVICE_ROLE")
            or os.getenv("SUPABASE_SECRET_KEY")
            or os.getenv("SUPABASE_SERVICE_KEY")
        )
        timeout = float(os.getenv("AOC_SUPABASE_TIMEOUT_SECONDS", "20"))
        return cls(url=url.rstrip("/") if url else None, key=key, enabled=enabled, timeout_seconds=timeout)

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.url and self.key)


class SupabaseGameStore:
    def __init__(self, settings: SupabasePersistenceSettings | None = None) -> None:
        self.settings = settings or SupabasePersistenceSettings.from_env()

    @property
    def configured(self) -> bool:
        return self.settings.configured

    def public_status(self) -> dict[str, Any]:
        return {
            "configured": self.configured,
            "enabled": self.settings.enabled,
            "url": self.settings.url,
            "tables": ["aoc_games", "aoc_game_events", "aoc_queens"],
        }

    def sync_room(self, room: Any) -> dict[str, Any]:
        if not self.configured:
            return {"stored": False, "reason": "supabase_not_configured"}

        persistence_state = getattr(room, "persistence_state", None)
        snapshot = persistence_state() if callable(persistence_state) else room.public_state()
        public_state = _json_safe(snapshot)
        row = {
            "game_id": str(room.game_id),
            "fixture_id": str(room.fixture_id),
            "participant1": room.participant1,
            "participant2": room.participant2,
            "owner_anonymous_id": getattr(room, "owner_anonymous_id", None),
            "owner_wallet": getattr(room, "owner_wallet", None),
            "owner_name": getattr(room, "owner_name", None),
            "status": room.status,
            "mode": room.mode,
            "seed": room.seed,
            "event_index": room.event_index,
            "public_state": public_state,
            "agent_usage": _json_safe(room.agent_usage),
            "completed_at": _utc_now() if room.status in {"finished", "error", "stopped"} else None,
        }
        try:
            self._request_json(
                "aoc_games?on_conflict=game_id",
                method="POST",
                body=row,
                prefer="resolution=merge-duplicates,return=minimal",
            )
        except SupabasePersistenceError as exc:
            if not _missing_owner_columns(str(exc)):
                raise
            legacy_row = dict(row)
            legacy_row.pop("owner_anonymous_id", None)
            legacy_row.pop("owner_wallet", None)
            legacy_row.pop("owner_name", None)
            self._request_json(
                "aoc_games?on_conflict=game_id",
                method="POST",
                body=legacy_row,
                prefer="resolution=merge-duplicates,return=minimal",
            )
        event_count = self.sync_events(room)
        return {"stored": True, "gameId": room.game_id, "eventCount": event_count}

    def sync_events(self, room: Any) -> int:
        if not self.configured:
            return 0

        rows = [
            {
                "game_id": str(room.game_id),
                "event_index": int(event.index),
                "kind": event.kind,
                "message": event.message,
                "data": _json_safe(event.public_state().get("data", {})),
                "created_at_unix": float(event.created_at),
            }
            for event in room.log
        ]
        for chunk in _chunks(rows, 100):
            self._request_json(
                "aoc_game_events?on_conflict=game_id,event_index",
                method="POST",
                body=chunk,
                prefer="resolution=merge-duplicates,return=minimal",
            )
        return len(rows)

    def mark_game_stopped(self, game_state: dict[str, Any]) -> dict[str, Any] | None:
        """Mark an orphaned worker stopped without loading or rewriting its replay."""
        state = _json_safe(game_state)
        game_id = str(state.get("gameId") or "").strip()
        if not game_id:
            raise SupabasePersistenceError("gameId is required to stop a stored game.")

        state["status"] = "stopped"
        if not self.configured:
            return state

        cleaned = urllib.parse.quote(game_id, safe="")
        if not isinstance(state.get(PRIVATE_SNAPSHOT_KEY), dict):
            existing_rows = self._request_json(
                f"aoc_games?select=public_state&game_id=eq.{cleaned}&limit=1"
            )
            existing_state = (
                existing_rows[0].get("public_state")
                if isinstance(existing_rows, list) and existing_rows and isinstance(existing_rows[0], dict)
                else None
            )
            if isinstance(existing_state, dict) and isinstance(
                existing_state.get(PRIVATE_SNAPSHOT_KEY), dict
            ):
                state[PRIVATE_SNAPSHOT_KEY] = existing_state[PRIVATE_SNAPSHOT_KEY]
        rows = self._request_json(
            f"aoc_games?game_id=eq.{cleaned}&status=in.(running_replay,running_live)",
            method="PATCH",
            body={
                "status": "stopped",
                "completed_at": _utc_now(),
                "public_state": state,
            },
            prefer="return=representation",
        )
        if not isinstance(rows, list) or not rows:
            return None
        stored_state = rows[0].get("public_state") if isinstance(rows[0], dict) else None
        return stored_state if isinstance(stored_state, dict) else state

    def list_games(self, *, limit: int = 50) -> dict[str, Any]:
        if not self.configured:
            return {"source": "supabase", "configured": False, "count": 0, "games": []}
        safe_limit = max(1, min(int(limit), 200))
        fields = ",".join(
            [
                "game_id",
                "fixture_id",
                "participant1",
                "participant2",
                "owner_anonymous_id",
                "owner_wallet",
                "owner_name",
                "status",
                "mode",
                "seed",
                "event_index",
                "agent_usage",
                "created_at",
                "updated_at",
                "completed_at",
                "public_state",
            ]
        )
        try:
            rows = self._request_json(f"aoc_games?select={fields}&order=updated_at.desc&limit={safe_limit}")
        except SupabasePersistenceError as exc:
            if not _missing_owner_columns(str(exc)):
                raise
            legacy_fields = ",".join(
                [
                    "game_id",
                    "fixture_id",
                    "participant1",
                    "participant2",
                    "status",
                    "mode",
                    "seed",
                    "event_index",
                    "agent_usage",
                    "created_at",
                    "updated_at",
                    "completed_at",
                    "public_state",
                ]
            )
            rows = self._request_json(f"aoc_games?select={legacy_fields}&order=updated_at.desc&limit={safe_limit}")
        return {"source": "supabase", "configured": True, "count": len(rows), "games": rows}

    def list_admin_games(self, *, limit: int = 50) -> dict[str, Any]:
        """List only rooms backed by a durable admin marker.

        Explicit ``roomKind=admin`` snapshots are fetched before LIMIT. For
        transitional snapshots without that field, a bounded scan asks the
        journal for ``game_created.data.roomKind=admin`` and selects only the
        matching game ids. Event data itself is never read back, which avoids
        exposing legacy identity fields while retaining a positive proof.
        """

        if not self.configured:
            return {"source": "supabase", "configured": False, "count": 0, "games": []}

        safe_limit = max(1, min(int(limit), 200))
        fields = ",".join(
            [
                "game_id",
                "fixture_id",
                "participant1",
                "participant2",
                "owner_anonymous_id",
                "owner_wallet",
                "owner_name",
                "status",
                "mode",
                "seed",
                "event_index",
                "agent_usage",
                "created_at",
                "updated_at",
                "completed_at",
                "public_state",
            ]
        )
        legacy_fields = ",".join(
            field
            for field in fields.split(",")
            if field not in {"owner_anonymous_id", "owner_wallet", "owner_name"}
        )

        def fetch(query: str) -> list[dict[str, Any]]:
            try:
                rows = self._request_json(query.format(fields=fields))
            except SupabasePersistenceError as exc:
                if not _missing_owner_columns(str(exc)):
                    raise
                rows = self._request_json(query.format(fields=legacy_fields))
            return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

        explicit_query = (
            "aoc_games?select={fields}"
            "&public_state->>roomKind=eq.admin"
            "&order=updated_at.desc,game_id.desc"
            f"&limit={safe_limit}"
        )
        explicit_rows = []
        seen_ids: set[str] = set()
        for row in fetch(explicit_query):
            public_state = row.get("public_state")
            snapshot = {**row, **public_state} if isinstance(public_state, dict) else row
            game_id = _stored_game_id(row)
            if not game_id or game_id in seen_ids or room_kind_from_snapshot(snapshot) != "admin":
                continue
            explicit_rows.append(row)
            seen_ids.add(game_id)

        legacy_rows: list[dict[str, Any]] = []
        page_size = max(safe_limit, _ADMIN_LIST_LEGACY_MIN_PAGE_SIZE)
        legacy_query = (
            "aoc_games?select={fields}"
            "&public_state->>roomKind=is.null"
            "&order=updated_at.desc,game_id.desc"
        )
        for page in range(_ADMIN_LIST_MAX_PAGES):
            offset = page * page_size
            query = f"{legacy_query}&limit={page_size}"
            if offset:
                query = f"{query}&offset={offset}"
            rows = fetch(query)
            proven_admin_ids = self._legacy_admin_game_ids(rows)
            for row in rows:
                game_id = _stored_game_id(row)
                if not game_id or game_id in seen_ids or game_id not in proven_admin_ids:
                    continue
                # This derived marker carries only the authorization result;
                # journal data (including any legacy identities) is not exposed.
                legacy_rows.append({**row, "room_kind": "admin"})
                seen_ids.add(game_id)
                if len(legacy_rows) >= safe_limit:
                    break
            if len(legacy_rows) >= safe_limit or len(rows) < page_size:
                break

        admin_rows = [*explicit_rows, *legacy_rows]
        admin_rows.sort(key=_stored_row_recency_key, reverse=True)
        games = admin_rows[:safe_limit]
        return {"source": "supabase", "configured": True, "count": len(games), "games": games}

    def _legacy_admin_game_ids(self, rows: list[dict[str, Any]]) -> set[str]:
        """Return ids whose creation journal explicitly declares an admin room."""

        game_ids = list(dict.fromkeys(filter(None, (_stored_game_id(row) for row in rows))))
        proven: set[str] = set()
        for start in range(0, len(game_ids), _ADMIN_EVENT_BATCH_SIZE):
            batch = game_ids[start : start + _ADMIN_EVENT_BATCH_SIZE]
            allowed = set(batch)
            encoded_ids = ",".join(urllib.parse.quote(game_id, safe="_-") for game_id in batch)
            # Select only game_id: legacy game_created data may contain bearer
            # identifiers and must never enter the admin-list response.
            events = self._request_json(
                "aoc_game_events?select=game_id"
                "&kind=eq.game_created"
                "&data->>roomKind=eq.admin"
                f"&game_id=in.({encoded_ids})"
                f"&limit={len(batch)}"
            )
            if not isinstance(events, list):
                continue
            proven.update(
                game_id
                for event in events
                if isinstance(event, dict)
                for game_id in [str(event.get("game_id") or "")]
                if game_id in allowed
            )
        return proven

    def latest_game_for_fixture(
        self,
        fixture_id: str | int,
        *,
        limit: int = 20,
        mode: str | None = None,
        room_kind: RoomKind | None = None,
        room_scope: RoomScope | None = None,
    ) -> dict[str, Any] | None:
        if not self.configured:
            return None
        cleaned = urllib.parse.quote(str(fixture_id), safe="")
        safe_limit = max(1, min(int(limit), 50))
        fields = ",".join(
            [
                "game_id",
                "fixture_id",
                "participant1",
                "participant2",
                "owner_anonymous_id",
                "owner_wallet",
                "owner_name",
                "status",
                "mode",
                "seed",
                "event_index",
                "public_state",
                "created_at",
                "updated_at",
                "completed_at",
            ]
        )
        query = (
            f"aoc_games?select={fields}&fixture_id=eq.{cleaned}"
            "&status=not.in.(finished,error,stopped)"
            "&order=updated_at.desc,game_id.desc"
        )
        room_kind_filter = None
        if room_kind is not None:
            # New snapshots can be filtered before LIMIT. Missing roomKind must
            # remain eligible so pre-migration snapshots still use the local,
            # identity-aware legacy inference below.
            room_kind_filter = (
                f"(public_state->>roomKind.eq.{room_kind},"
                "public_state->>roomKind.is.null)"
            )
        scope_filter = None
        if room_scope == "global":
            # Legacy player snapshots predate roomScope and represent the
            # original global match room. Private rooms always carry an
            # explicit marker and are never eligible for a global lookup.
            scope_filter = (
                "(public_state->>roomScope.eq.global,"
                "public_state->>roomScope.is.null)"
            )
        if room_kind_filter and scope_filter:
            combined_filter = f"(or{room_kind_filter},or{scope_filter})"
            query = f"{query}&{urllib.parse.urlencode({'and': combined_filter})}"
        else:
            if room_kind_filter:
                query = f"{query}&{urllib.parse.urlencode({'or': room_kind_filter})}"
            if scope_filter:
                query = f"{query}&{urllib.parse.urlencode({'or': scope_filter})}"
        if room_scope == "private":
            query = f"{query}&public_state->>roomScope=eq.private"

        for page in range(_LATEST_FIXTURE_MAX_PAGES):
            offset = page * safe_limit
            page_query = f"{query}&limit={safe_limit}"
            if offset:
                page_query = f"{page_query}&offset={offset}"
            rows = self._request_json(page_query)
            if not isinstance(rows, list) or not rows:
                break

            for row in rows:
                if not isinstance(row, dict):
                    continue
                if row.get("status") in {"finished", "error", "stopped"}:
                    continue
                public_state = row.get("public_state") or {}
                if room_kind is not None:
                    snapshot = {**row, **public_state} if isinstance(public_state, dict) else row
                    if room_kind_from_snapshot(snapshot) != room_kind:
                        continue
                    if (
                        room_kind == "player"
                        and not _snapshot_has_explicit_room_kind(snapshot)
                        and not _legacy_snapshot_has_player_identity(snapshot)
                    ):
                        # Ambiguous snapshots stay player for authorization,
                        # but are unsafe for automatic public-room reuse: they
                        # may be pre-migration admin simulations.
                        continue
                if room_scope is not None:
                    snapshot = {**row, **public_state} if isinstance(public_state, dict) else row
                    if room_scope_from_snapshot(snapshot) != room_scope:
                        continue
                if mode is not None:
                    row_mode = public_state.get("mode") if isinstance(public_state, dict) else None
                    row_mode = row_mode or row.get("mode")
                    owner = public_state.get("owner") if isinstance(public_state, dict) else None
                    legacy_public_live = (
                        mode == "live"
                        and row_mode is None
                        and isinstance(owner, dict)
                        and bool(owner.get("anonymousId") or owner.get("name"))
                    )
                    if row_mode != mode and not legacy_public_live:
                        continue
                return row

            if len(rows) < safe_limit:
                break
        return None

    def latest_game_for_room_code(
        self,
        room_code: str,
        *,
        limit: int = 200,
        room_scope: RoomScope | None = None,
    ) -> dict[str, Any] | None:
        if not self.configured:
            return None
        clean_room_code = "".join(character for character in str(room_code or "") if character.isdigit())[:6]
        if len(clean_room_code) != 6:
            return None
        payload = self.list_games(limit=limit)
        for row in payload.get("games", []):
            public_state = row.get("public_state") or {}
            if not isinstance(public_state, dict):
                continue
            if room_scope is not None and room_scope_from_snapshot({**row, **public_state}) != room_scope:
                continue
            status = public_state.get("status") or row.get("status")
            if str(public_state.get("roomCode") or "") == clean_room_code and status not in {"finished", "error", "stopped"}:
                return row
        return None

    def game_replay(self, game_id: str) -> dict[str, Any] | None:
        if not self.configured:
            return None
        cleaned = urllib.parse.quote(str(game_id), safe="")
        games = self._request_json(f"aoc_games?select=*&game_id=eq.{cleaned}&limit=1")
        if not games:
            return None
        events = self._request_json(
            f"aoc_game_events?select=*&game_id=eq.{cleaned}&order=event_index.asc&limit=5000"
        )
        game = games[0]
        return {
            "game": game.get("public_state") or game,
            "events": [_stored_event_public_state(event) for event in events],
            "stored": {
                "source": "supabase",
                "game": game,
                "eventCount": len(events),
            },
        }

    # ------------------------------------------------------------------
    # Queens — one royal profile per wallet (wallet is the primary key,
    # so upserts amend the existing queen and can never create a second).
    # ------------------------------------------------------------------
    def get_queen(self, wallet: str) -> dict[str, Any] | None:
        if not self.configured:
            return None
        cleaned = urllib.parse.quote(str(wallet), safe="")
        rows = self._request_json(f"aoc_queens?select=*&wallet=eq.{cleaned}&limit=1")
        return _queen_public_state(rows[0]) if rows else None

    def upsert_queen(self, wallet: str, *, name: str, motto: str, emblem: str) -> dict[str, Any]:
        row = {
            "wallet": str(wallet),
            "name": name,
            "motto": motto,
            "emblem": emblem,
        }
        rows = self._request_json(
            "aoc_queens?on_conflict=wallet",
            method="POST",
            body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return _queen_public_state(rows[0]) if rows else _queen_public_state(row)

    def delete_queen(self, wallet: str) -> bool:
        cleaned = urllib.parse.quote(str(wallet), safe="")
        self._request_json(f"aoc_queens?wallet=eq.{cleaned}", method="DELETE", prefer="return=minimal")
        return True

    def _request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        prefer: str = "",
    ) -> Any:
        settings = self.settings
        if not settings.url or not settings.key:
            raise SupabasePersistenceError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")

        endpoint = f"{settings.url}/rest/v1/{path.lstrip('/')}"
        data = None if body is None else json.dumps(_json_safe(body), ensure_ascii=False).encode("utf-8")
        headers = {
            "apikey": settings.key,
            "Authorization": f"Bearer {settings.key}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer

        request = urllib.request.Request(endpoint, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=settings.timeout_seconds) as response:  # noqa: S310
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SupabasePersistenceError(f"Supabase {method} failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise SupabasePersistenceError(f"Supabase {method} failed: {exc}") from exc

        return json.loads(payload) if payload.strip() else []


def _queen_public_state(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "wallet": row.get("wallet"),
        "name": row.get("name"),
        "motto": row.get("motto") or "",
        "emblem": row.get("emblem") or "👑",
        "crownedAt": row.get("crowned_at"),
        "updatedAt": row.get("updated_at"),
    }


def _stored_event_public_state(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "index": row.get("event_index"),
        "kind": row.get("kind"),
        "message": row.get("message"),
        "data": row.get("data") or {},
        "createdAt": row.get("created_at_unix"),
    }


def _json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _chunks(rows: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "y", "on"}


def _missing_owner_columns(detail: str) -> bool:
    return "owner_anonymous_id" in detail or "owner_wallet" in detail or "owner_name" in detail


def _stored_game_id(row: dict[str, Any]) -> str:
    public_state = row.get("public_state")
    public_game_id = public_state.get("gameId") if isinstance(public_state, dict) else None
    return str(row.get("game_id") or public_game_id or "").strip()


def _stored_row_recency_key(row: dict[str, Any]) -> tuple[float, str]:
    value = row.get("updated_at") or row.get("completed_at") or row.get("created_at")
    timestamp = 0.0
    if isinstance(value, (int, float)):
        timestamp = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            timestamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return timestamp, _stored_game_id(row)


def _snapshot_has_explicit_room_kind(snapshot: dict[str, Any]) -> bool:
    for key in ("roomKind", "room_kind"):
        if snapshot.get(key) in {"admin", "player"}:
            return True
    nested = snapshot.get("public_state")
    if isinstance(nested, dict):
        return any(nested.get(key) in {"admin", "player"} for key in ("roomKind", "room_kind"))
    return False


def _legacy_snapshot_has_player_identity(snapshot: dict[str, Any]) -> bool:
    owner = snapshot.get("owner")
    if isinstance(owner, dict) and any(
        owner.get(key) for key in ("wallet", "anonymousId", "anonymous_id", "name")
    ):
        return True
    if any(
        snapshot.get(key)
        for key in ("owner_wallet", "ownerAnonymousId", "owner_anonymous_id", "owner_name")
    ):
        return True
    players = snapshot.get("players")
    if isinstance(players, list) and players:
        return True
    colonies = snapshot.get("colonies")
    if not isinstance(colonies, list):
        return False
    return any(
        isinstance(colony, dict)
        and any(
            colony.get(key)
            for key in (
                "playerId",
                "playerWallet",
                "playerAnonymousId",
                "player_id",
                "player_wallet",
                "player_anonymous_id",
            )
        )
        for colony in colonies
    )
