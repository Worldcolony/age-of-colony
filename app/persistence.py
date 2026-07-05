from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .txline import load_dotenv


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

        public_state = _json_safe(room.public_state())
        row = {
            "game_id": str(room.game_id),
            "fixture_id": str(room.fixture_id),
            "participant1": room.participant1,
            "participant2": room.participant2,
            "owner_anonymous_id": getattr(room, "owner_anonymous_id", None),
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
                "data": _json_safe(event.data),
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

    def latest_game_for_fixture(self, fixture_id: str | int, *, limit: int = 20, mode: str | None = None) -> dict[str, Any] | None:
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
        rows = self._request_json(
            f"aoc_games?select={fields}&fixture_id=eq.{cleaned}&order=updated_at.desc&limit={safe_limit}"
        )
        for row in rows:
            if row.get("status") not in {"finished", "error", "stopped"}:
                if mode is not None:
                    public_state = row.get("public_state") or {}
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
        return None

    def latest_game_for_room_code(self, room_code: str, *, limit: int = 200) -> dict[str, Any] | None:
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
    return "owner_anonymous_id" in detail or "owner_name" in detail
