from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from typing import Any, AsyncIterator, Iterable

import httpx


class TxLineConfigError(RuntimeError):
    """Raised when the TXLine credentials are not configured."""


def load_dotenv(path: str = ".env") -> None:
    """Load simple KEY=value pairs for local development without overriding env vars."""
    if not os.path.exists(path):
        return

    with open(path, encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


@dataclass(frozen=True)
class TxLineSettings:
    jwt: str | None
    api_token: str | None
    base_url: str = "https://txline.txodds.com"
    default_competition_id: int | None = None
    timeout_seconds: float = 20.0

    @classmethod
    def from_env(cls) -> "TxLineSettings":
        load_dotenv()
        competition_id = os.getenv("TXLINE_COMPETITION_ID") or None
        return cls(
            jwt=os.getenv("TXLINE_JWT"),
            api_token=os.getenv("TXLINE_API_TOKEN"),
            base_url=os.getenv("TXLINE_BASE_URL", "https://txline.txodds.com").rstrip("/"),
            default_competition_id=int(competition_id) if competition_id else None,
            timeout_seconds=float(os.getenv("TXLINE_TIMEOUT_SECONDS", "20")),
        )

    @property
    def configured(self) -> bool:
        return bool(self.jwt and self.api_token)


def epoch_day_from_date(value: date) -> int:
    day_start = datetime.combine(value, time.min, tzinfo=timezone.utc)
    return int(day_start.timestamp() // 86400)


def parse_date_to_epoch_day(value: str) -> int:
    return epoch_day_from_date(date.fromisoformat(value))


def epoch_to_iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return None

    if timestamp > 10_000_000_000:
        timestamp /= 1000

    try:
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def pick(mapping: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return default


def nested_get(mapping: dict[str, Any] | None, *keys: str, default: Any = None) -> Any:
    current: Any = mapping
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ("name", "Name", "value", "Value", "type", "Type"):
            if key in value:
                return clean_text(value[key])
        if not value:
            return None
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value).strip()
    return text or None


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


class TxLineClient:
    def __init__(self, settings: TxLineSettings | None = None) -> None:
        self.settings = settings or TxLineSettings.from_env()

    def _headers(self, accept: str = "application/json") -> dict[str, str]:
        if not self.settings.configured:
            raise TxLineConfigError("TXLINE_JWT and TXLINE_API_TOKEN must be configured.")
        return {
            "Authorization": f"Bearer {self.settings.jwt}",
            "X-Api-Token": self.settings.api_token or "",
            "Accept": accept,
            "Accept-Encoding": "gzip, deflate",
        }

    async def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        timeout = httpx.Timeout(self.settings.timeout_seconds)
        async with httpx.AsyncClient(base_url=self.settings.base_url, timeout=timeout) as client:
            response = await client.get(path, headers=self._headers(), params=_compact_params(params))
            response.raise_for_status()
            return response.json()

    async def fixture_snapshot(
        self,
        *,
        start_epoch_day: int | None = None,
        competition_id: int | None = None,
    ) -> list[dict[str, Any]]:
        data = await self.get_json(
            "/api/fixtures/snapshot",
            {
                "startEpochDay": start_epoch_day,
                "competitionId": competition_id or self.settings.default_competition_id,
            },
        )
        return data if isinstance(data, list) else []

    async def score_snapshot(self, fixture_id: int) -> list[dict[str, Any]]:
        data = await self.get_json(f"/api/scores/snapshot/{fixture_id}")
        return data if isinstance(data, list) else []

    async def score_updates(self, fixture_id: int) -> list[dict[str, Any]]:
        data = await self.get_json(f"/api/scores/updates/{fixture_id}")
        return data if isinstance(data, list) else []

    async def score_historical(self, fixture_id: int) -> list[dict[str, Any]]:
        data = await self.get_json(f"/api/scores/historical/{fixture_id}")
        return data if isinstance(data, list) else []

    async def score_interval(self, epoch_day: int, hour: int, interval: int) -> list[dict[str, Any]]:
        data = await self.get_json(f"/api/scores/updates/{epoch_day}/{hour}/{interval}")
        return data if isinstance(data, list) else []

    async def stream_score_events(self) -> AsyncIterator[dict[str, Any]]:
        timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
        async with httpx.AsyncClient(base_url=self.settings.base_url, timeout=timeout) as client:
            async with client.stream("GET", "/api/scores/stream", headers=self._headers("text/event-stream")) as response:
                response.raise_for_status()
                event: dict[str, Any] = {}
                async for line in response.aiter_lines():
                    if line == "":
                        if event:
                            yield _decode_sse_event(event)
                            event = {}
                        continue
                    if line.startswith(":"):
                        continue
                    key, separator, value = line.partition(":")
                    if not separator:
                        continue
                    if value.startswith(" "):
                        value = value[1:]
                    if key == "data" and "data" in event:
                        event["data"] = f"{event['data']}\n{value}"
                    else:
                        event[key] = value


def _compact_params(params: dict[str, Any] | None) -> dict[str, Any]:
    return {key: value for key, value in (params or {}).items() if value is not None and value != ""}


def _decode_sse_event(raw: dict[str, Any]) -> dict[str, Any]:
    decoded = dict(raw)
    data = raw.get("data")
    if isinstance(data, str):
        try:
            decoded["data"] = json.loads(data)
        except json.JSONDecodeError:
            decoded["data"] = data
    return decoded


def normalize_fixture(raw: dict[str, Any]) -> dict[str, Any]:
    fixture_id = pick(raw, "FixtureId", "fixtureId")
    start_time = pick(raw, "StartTime", "startTime")
    participant1 = clean_text(
        pick(raw, "Participant1", "participant1", "Participant1Name", "participant1Name", "Team1", "team1")
    )
    participant2 = clean_text(
        pick(raw, "Participant2", "participant2", "Participant2Name", "participant2Name", "Team2", "team2")
    )
    return {
        "fixtureId": fixture_id,
        "startTime": start_time,
        "startTimeIso": epoch_to_iso(start_time),
        "competition": clean_text(pick(raw, "Competition", "competition", "CompetitionName", "competitionName")),
        "competitionId": pick(raw, "CompetitionId", "competitionId"),
        "fixtureGroupId": pick(raw, "FixtureGroupId", "fixtureGroupId"),
        "participant1Id": pick(raw, "Participant1Id", "participant1Id"),
        "participant1": participant1,
        "participant2Id": pick(raw, "Participant2Id", "participant2Id"),
        "participant2": participant2,
        "participant1IsHome": pick(raw, "Participant1IsHome", "participant1IsHome"),
        "ts": pick(raw, "Ts", "ts"),
        "raw": raw,
    }


def normalize_fixtures(raw_fixtures: Iterable[dict[str, Any]], search: str | None = None) -> list[dict[str, Any]]:
    fixtures = [normalize_fixture(raw) for raw in raw_fixtures]
    if search:
        needle = search.casefold()
        fixtures = [
            fixture
            for fixture in fixtures
            if needle
            in " ".join(
                str(fixture.get(field) or "")
                for field in ("competition", "fixtureId", "participant1", "participant2")
            ).casefold()
        ]
    return sorted(fixtures, key=lambda item: (item.get("startTime") or 0, item.get("fixtureId") or 0))


def normalize_score_record(raw: dict[str, Any], fixture: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = raw.get("data") if _looks_like_sse_score(raw) else raw
    if not isinstance(payload, dict):
        payload = raw

    soccer = payload.get("dataSoccer") if isinstance(payload.get("dataSoccer"), dict) else {}
    score = payload.get("scoreSoccer") if isinstance(payload.get("scoreSoccer"), dict) else {}
    action = clean_text(pick(payload, "action", "Action")) or clean_text(soccer.get("Action"))
    event_type = clean_text(soccer.get("Type")) or clean_text(nested_get(soccer, "New", "Type"))
    outcome = clean_text(soccer.get("Outcome")) or clean_text(nested_get(soccer, "New", "Outcome"))
    free_kick_type = clean_text(soccer.get("FreeKickType")) or clean_text(nested_get(soccer, "New", "FreeKickType"))
    goal_type = clean_text(soccer.get("GoalType")) or clean_text(nested_get(soccer, "New", "GoalType"))
    possession = pick(payload, "possession", "Possession")
    possession_type = clean_text(pick(payload, "possessionType", "possessiontype", "PossessionType"))
    text_blob = " ".join(
        item
        for item in (
            action,
            event_type,
            outcome,
            free_kick_type,
            goal_type,
            possession_type,
            clean_text(payload.get("gameState")),
        )
        if item
    ).casefold()

    flags = _highlight_flags(soccer, text_blob)
    participant = pick(soccer, "Participant", "participant", default=payload.get("participant"))
    participant_label = _participant_label(participant, payload, fixture)
    possession_label = _participant_label(possession, payload, fixture)
    minute = _match_minute(payload, soccer)
    clock_seconds = _clock_seconds(payload, soccer)
    fixture_id = pick(payload, "fixtureId", "FixtureId") or (fixture or {}).get("fixtureId")

    normalized = {
        "fixtureId": fixture_id,
        "id": pick(payload, "id", "Id"),
        "seq": pick(payload, "seq", "Seq"),
        "ts": pick(payload, "ts", "Ts"),
        "tsIso": epoch_to_iso(pick(payload, "ts", "Ts")),
        "gameState": pick(payload, "gameState", "GameState"),
        "action": action,
        "type": event_type,
        "outcome": outcome,
        "minute": minute,
        "clockSeconds": clock_seconds,
        "participant": participant,
        "participantLabel": participant_label,
        "possession": possession,
        "possessionLabel": possession_label,
        "possessionType": possession_type,
        "possessionChanged": False,
        "previousPossession": None,
        "previousPossessionLabel": None,
        "score": {
            "participant1": _score_goals(score, "Participant1", "participant1"),
            "participant2": _score_goals(score, "Participant2", "participant2"),
        },
        "highlights": flags,
        "isHighlight": bool(flags),
        "description": _description(flags, minute, participant_label, action, event_type, outcome),
        "raw": payload,
    }
    return normalized


def build_timeline(
    records: Iterable[dict[str, Any]],
    *,
    fixture: dict[str, Any] | None = None,
    important_only: bool = True,
    include_possession_changes: bool = True,
    limit: int | None = 300,
) -> dict[str, Any]:
    all_normalized = [normalize_score_record(record, fixture=fixture) for record in records]
    all_normalized.sort(key=_event_sort_key)
    if include_possession_changes:
        annotate_possession_changes(all_normalized)
    latest_score = _latest_score(all_normalized)
    normalized = all_normalized
    if important_only:
        normalized = [record for record in normalized if record["isHighlight"]]

    if limit is not None and limit > 0:
        normalized = normalized[-limit:]

    return {
        "fixtureId": (fixture or {}).get("fixtureId") or (normalized[-1]["fixtureId"] if normalized else None),
        "fixture": fixture,
        "rawCount": len(all_normalized),
        "count": len(normalized),
        "score": latest_score,
        "events": normalized,
    }


def annotate_possession_changes(
    events: list[dict[str, Any]],
    state: dict[Any, dict[str, Any]] | None = None,
) -> None:
    possession_state = state if state is not None else {}
    for event in events:
        possession = event.get("possession")
        if possession is None:
            continue

        fixture_key = event.get("fixtureId") or "__unknown_fixture__"
        previous = possession_state.get(fixture_key)
        current = {
            "possession": possession,
            "label": event.get("possessionLabel"),
        }

        if previous and str(previous.get("possession")) != str(possession):
            _mark_possession_change(event, previous)

        possession_state[fixture_key] = current


def _looks_like_sse_score(raw: dict[str, Any]) -> bool:
    return isinstance(raw.get("data"), dict) and ("event" in raw or "dataSoccer" in raw.get("data", {}))


def _highlight_flags(soccer: dict[str, Any], text_blob: str) -> list[str]:
    flags: list[str] = []

    def add(flag: str, condition: bool) -> None:
        if condition and flag not in flags:
            flags.append(flag)

    add("goal", as_bool(soccer.get("Goal")) or _contains_scoring_goal(text_blob))
    add("penalty", as_bool(soccer.get("Penalty")) or "penalty" in text_blob)
    add(
        "free_kick",
        bool(clean_text(soccer.get("FreeKickType")) or clean_text(nested_get(soccer, "New", "FreeKickType")))
        or "free kick" in text_blob
        or "freekick" in text_blob
        or "coup franc" in text_blob,
    )
    add("corner", as_bool(soccer.get("Corner")) or "corner" in text_blob)
    add("red_card", as_bool(soccer.get("RedCard")) or "red card" in text_blob)
    add("yellow_card", as_bool(soccer.get("YellowCard")) or "yellow card" in text_blob)
    add("var", as_bool(soccer.get("VAR")) or "var" in text_blob)
    return flags


def _participant_label(
    participant: Any,
    payload: dict[str, Any],
    fixture: dict[str, Any] | None = None,
) -> str | None:
    if participant is None:
        return None

    fixture = fixture or {}
    participant1_id = pick(payload, "participant1Id", "Participant1Id", default=fixture.get("participant1Id"))
    participant2_id = pick(payload, "participant2Id", "Participant2Id", default=fixture.get("participant2Id"))
    participant1_name = fixture.get("participant1") or f"Participant 1"
    participant2_name = fixture.get("participant2") or f"Participant 2"

    if str(participant) in {"1", str(participant1_id)}:
        return participant1_name
    if str(participant) in {"2", str(participant2_id)}:
        return participant2_name
    return str(participant)


def _match_minute(payload: dict[str, Any], soccer: dict[str, Any]) -> int | None:
    minute = pick(soccer, "Minutes", "minutes") or nested_get(soccer, "New", "Minutes")
    if minute is not None:
        try:
            return int(minute)
        except (TypeError, ValueError):
            return None

    seconds = _clock_seconds(payload, soccer)
    if seconds is None:
        return None
    return int(seconds // 60) + 1


def _clock_seconds(payload: dict[str, Any], soccer: dict[str, Any]) -> int | None:
    seconds = (
        nested_get(payload, "clock", "seconds")
        or nested_get(soccer, "New", "Clock", "seconds")
        or nested_get(soccer, "Previous", "Clock", "seconds")
    )
    try:
        return int(seconds) if seconds is not None else None
    except (TypeError, ValueError):
        return None


def _score_goals(score: dict[str, Any], *participant_keys: str) -> Any:
    for participant_key in participant_keys:
        participant_score = score.get(participant_key)
        if not isinstance(participant_score, dict):
            continue
        for total_key in ("Total", "total"):
            total = participant_score.get(total_key)
            if isinstance(total, dict):
                goals = pick(total, "Goals", "goals")
                if goals is not None:
                    return goals
        goals = pick(participant_score, "Goals", "goals")
        if goals is not None:
            return goals
    return None


def _event_sort_key(item: dict[str, Any]) -> tuple[Any, Any, Any]:
    return (item.get("ts") or 0, item.get("seq") or 0, item.get("id") or 0)


def _mark_possession_change(event: dict[str, Any], previous: dict[str, Any]) -> None:
    flags = event.setdefault("highlights", [])
    if "possession" not in flags:
        flags.append("possession")
    event["isHighlight"] = True
    event["possessionChanged"] = True
    event["previousPossession"] = previous.get("possession")
    event["previousPossessionLabel"] = previous.get("label")
    event["description"] = _possession_description(event, previous)


def _possession_description(event: dict[str, Any], previous: dict[str, Any]) -> str:
    previous_label = previous.get("label") or f"Participant {previous.get('possession')}"
    current_label = event.get("possessionLabel") or f"Participant {event.get('possession')}"
    bits = ["Possession"]
    minute = event.get("minute")
    if minute is not None:
        bits.append(f"{minute}'")
    bits.append(f"{previous_label} -> {current_label}")
    if event.get("possessionType"):
        bits.append(str(event["possessionType"]))
    elif event.get("action"):
        bits.append(str(event["action"]))
    return " - ".join(bits)


def _contains_scoring_goal(text_blob: str) -> bool:
    if any(non_goal in text_blob for non_goal in ("goal kick", "goal_kick", "goalkick")):
        return False
    tokens = [token for token in re.split(r"[^a-z0-9]+", text_blob) if token]
    return "goal" in tokens or "but" in tokens


def _description(
    flags: list[str],
    minute: int | None,
    participant_label: str | None,
    action: str | None,
    event_type: str | None,
    outcome: str | None,
) -> str:
    label_map = {
        "goal": "But",
        "penalty": "Penalty",
        "free_kick": "Coup franc",
        "corner": "Corner",
        "red_card": "Carton rouge",
        "yellow_card": "Carton jaune",
        "var": "VAR",
        "possession": "Possession",
    }
    title = " / ".join(label_map.get(flag, flag) for flag in flags) if flags else (action or event_type or "Update")
    bits = [title]
    if minute is not None:
        bits.append(f"{minute}'")
    if participant_label:
        bits.append(participant_label)
    detail = outcome or event_type or action
    if detail and detail not in bits:
        bits.append(detail)
    return " - ".join(bits)


def _latest_score(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    for event in reversed(events):
        score = event.get("score")
        if isinstance(score, dict) and (score.get("participant1") is not None or score.get("participant2") is not None):
            return score
    return None


async def retry_once_on_remote_close(call):
    try:
        return await call()
    except httpx.RemoteProtocolError:
        await asyncio.sleep(0.5)
        return await call()
