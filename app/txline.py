from __future__ import annotations

import asyncio
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation
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
    force_ipv4: bool = True

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
            force_ipv4=os.getenv("TXLINE_FORCE_IPV4", "true").strip().casefold() not in {"0", "false", "no"},
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

    def _transport(self) -> httpx.AsyncBaseTransport | None:
        if not self.settings.force_ipv4:
            return None
        return httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1)

    async def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        timeout = httpx.Timeout(self.settings.timeout_seconds)
        async with httpx.AsyncClient(
            base_url=self.settings.base_url,
            timeout=timeout,
            transport=self._transport(),
        ) as client:
            response = await client.get(path, headers=self._headers(), params=_compact_params(params))
            response.raise_for_status()
            if not response.content.strip():
                return []
            if _looks_like_event_stream_response(response):
                return _decode_sse_payloads(response.text)
            try:
                return response.json()
            except json.JSONDecodeError:
                return []

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

    async def score_stat_validation(
        self,
        fixture_id: int,
        seq: int,
        stat_keys: Iterable[int] = (1, 2),
    ) -> dict[str, Any]:
        keys = ",".join(str(int(key)) for key in stat_keys)
        data = await self.get_json(
            "/api/scores/stat-validation",
            {"fixtureId": fixture_id, "seq": seq, "statKeys": keys},
        )
        return data if isinstance(data, dict) else {}

    async def stream_score_events(self) -> AsyncIterator[dict[str, Any]]:
        timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
        async with httpx.AsyncClient(
            base_url=self.settings.base_url,
            timeout=timeout,
            transport=self._transport(),
        ) as client:
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


def _looks_like_event_stream_response(response: httpx.Response) -> bool:
    content_type = response.headers.get("content-type", "")
    return "text/event-stream" in content_type or response.content.lstrip().startswith(b"data:")


def _decode_sse_payloads(text: str) -> list[Any]:
    events: list[Any] = []
    data_lines: list[str] = []

    def flush() -> None:
        if not data_lines:
            return
        payload = "\n".join(data_lines).strip()
        data_lines.clear()
        if not payload:
            return
        try:
            events.append(json.loads(payload))
        except json.JSONDecodeError:
            events.append(payload)

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r")
        if not line:
            flush()
            continue
        if line.startswith(":"):
            continue
        key, separator, value = line.partition(":")
        if not separator:
            continue
        if value.startswith(" "):
            value = value[1:]
        if key == "data":
            data_lines.append(value)

    flush()
    return events


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
    return sorted(
        fixtures,
        key=lambda item: (
            _sortable_value(fixture_start_timestamp(item)),
            _sortable_value(item.get("fixtureId")),
        ),
    )


def fixture_start_timestamp(fixture: dict[str, Any]) -> float | None:
    start_time = fixture.get("startTime")
    if start_time is None:
        return None
    try:
        timestamp = float(start_time)
    except (TypeError, ValueError):
        return None
    if timestamp > 10_000_000_000:
        timestamp /= 1000
    return timestamp


def filter_upcoming_fixtures(
    fixtures: Iterable[dict[str, Any]],
    *,
    now: datetime | None = None,
    until: datetime | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    now_ts = (now or datetime.now(timezone.utc)).timestamp()
    until_ts = until.timestamp() if until else None
    upcoming: list[dict[str, Any]] = []
    seen: set[Any] = set()

    for fixture in sorted(
        fixtures,
        key=lambda item: (
            fixture_start_timestamp(item) is None,
            _sortable_value(fixture_start_timestamp(item)),
            _sortable_value(item.get("fixtureId")),
        ),
    ):
        fixture_id = fixture.get("fixtureId")
        key = fixture_id if fixture_id is not None else (fixture.get("participant1"), fixture.get("participant2"), fixture.get("startTime"))
        if key in seen:
            continue
        seen.add(key)

        start_ts = fixture_start_timestamp(fixture)
        if start_ts is None or start_ts < now_ts:
            continue
        if until_ts is not None and start_ts > until_ts:
            continue
        upcoming.append(fixture)

    if limit is not None and limit > 0:
        return upcoming[:limit]
    return upcoming


def normalize_score_record(
    raw: dict[str, Any],
    fixture: dict[str, Any] | None = None,
    player_index: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = raw.get("data") if _looks_like_sse_score(raw) else raw
    if not isinstance(payload, dict):
        payload = raw

    soccer = payload.get("dataSoccer") if isinstance(payload.get("dataSoccer"), dict) else {}
    score = payload.get("scoreSoccer") if isinstance(payload.get("scoreSoccer"), dict) else {}
    top_data = _event_data(payload)
    action = clean_text(pick(payload, "action", "Action")) or clean_text(soccer.get("Action"))
    event_type = clean_text(soccer.get("Type")) or clean_text(nested_get(soccer, "New", "Type")) or clean_text(top_data.get("Type"))
    outcome = clean_text(soccer.get("Outcome")) or clean_text(nested_get(soccer, "New", "Outcome")) or clean_text(top_data.get("Outcome"))
    free_kick_type = (
        clean_text(soccer.get("FreeKickType"))
        or clean_text(nested_get(soccer, "New", "FreeKickType"))
        or clean_text(top_data.get("FreeKickType"))
    )
    goal_type = clean_text(soccer.get("GoalType")) or clean_text(nested_get(soccer, "New", "GoalType"))
    possession = pick(payload, "possession", "Possession")
    possession_type = clean_text(pick(payload, "possessionType", "possessiontype", "PossessionType"))
    confirmed = _first_not_none(
        pick(payload, "confirmed", "Confirmedd", "Confirmed"),
        pick(soccer, "confirmed", "Confirmedd", "Confirmed"),
        top_data.get("Confirmed"),
    )
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
            clean_text(payload.get("GameState")),
            clean_text(top_data.get("VAR")),
            clean_text(top_data.get("RedCard")),
            clean_text(top_data.get("YellowCard")),
        )
        if item
    ).casefold()

    flags = _highlight_flags(soccer, text_blob, action=action, event_type=event_type)
    participant = _first_not_none(
        pick(soccer, "Participant", "participant"),
        pick(payload, "participant", "Participant"),
        top_data.get("Participant"),
    )
    participant_label = _participant_label(participant, payload, fixture)
    possession_label = _participant_label(possession, payload, fixture)
    player = _lookup_player(top_data.get("PlayerId"), player_index)
    player_in = _lookup_player(top_data.get("PlayerInId"), player_index)
    player_out = _lookup_player(top_data.get("PlayerOutId"), player_index)
    minute = _match_minute(payload, soccer)
    clock_seconds = _clock_seconds(payload, soccer)
    fixture_id = pick(payload, "fixtureId", "FixtureId") or (fixture or {}).get("fixtureId")
    details = _event_details(
        participant_label=participant_label,
        possession_label=possession_label,
        possession_type=possession_type,
        event_type=event_type,
        outcome=outcome,
        free_kick_type=free_kick_type,
        goal_type=goal_type,
        throw_in_type=clean_text(top_data.get("ThrowInType")),
        confirmed=confirmed,
        top_data=top_data,
        player=player,
        player_in=player_in,
        player_out=player_out,
    )

    raw_score = {
        "participant1": _first_not_none(
            _score_goals(score, "Participant1", "participant1"),
            _score_goals(_event_score(payload), "Participant1", "participant1"),
        ),
        "participant2": _first_not_none(
            _score_goals(score, "Participant2", "participant2"),
            _score_goals(_event_score(payload), "Participant2", "participant2"),
        ),
    }
    official_score = _official_event_score(
        raw_score,
        action=action,
        event_type=event_type,
        outcome=outcome,
        confirmed=confirmed,
        flags=flags,
    )

    normalized = {
        "fixtureId": fixture_id,
        "id": pick(payload, "id", "Id"),
        "seq": pick(payload, "seq", "Seq"),
        "ts": pick(payload, "ts", "Ts"),
        "tsIso": epoch_to_iso(pick(payload, "ts", "Ts")),
        "gameState": pick(payload, "gameState", "GameState"),
        "statusId": pick(payload, "statusId", "StatusId"),
        "action": action,
        "type": event_type,
        "outcome": outcome,
        "freeKickType": free_kick_type,
        "goalType": goal_type,
        "confirmed": confirmed,
        "player": player,
        "playerIn": player_in,
        "playerOut": player_out,
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
        "details": details,
        "score": official_score,
        "highlights": flags,
        "isHighlight": bool(flags),
        "description": _description(
            flags,
            minute,
            participant_label,
            action,
            event_type,
            outcome,
            free_kick_type,
            confirmed,
            player,
            player_in,
            player_out,
        ),
        "raw": payload,
    }
    return normalized


def build_match_details(records: Iterable[dict[str, Any]], *, fixture: dict[str, Any] | None = None) -> dict[str, Any]:
    records_list = [record for record in records if isinstance(record, dict)]
    player_index = build_player_index(records_list)
    latest_score = _latest_raw_score(records_list)
    action_counts: dict[str, int] = {}
    weather_conditions: list[str] = []
    pitch_conditions: list[str] = []
    venue_type: str | None = None
    jerseys: dict[str, str] = {}
    additional_time: list[dict[str, Any]] = []

    for record in records_list:
        action = clean_text(pick(record, "Action", "action"))
        data = _event_data(record)
        if action:
            action_counts[action] = action_counts.get(action, 0) + 1
        if action == "weather":
            weather_conditions = [str(item) for item in data.get("Conditions", []) if item]
        elif action == "pitch":
            pitch_conditions = [str(item) for item in data.get("Conditions", []) if item]
        elif action == "venue":
            venue_type = clean_text(data.get("Type"))
        elif action == "jersey":
            participant_label = _participant_label(pick(record, "Participant", "participant"), record, fixture)
            color = clean_text(data.get("Color"))
            if participant_label and color:
                jerseys[participant_label] = color
        elif action == "additional_time" and data.get("Minutes") is not None:
            additional_time.append(
                {
                    "minute": _match_minute(record, {}),
                    "minutes": data.get("Minutes"),
                    "period": _period_from_clock(_clock_seconds(record, {})),
                }
            )

    return {
        "fixture": fixture,
        "recordCount": len(records_list),
        "actionCounts": dict(sorted(action_counts.items())),
        "environment": {
            "venueType": _humanize_token(venue_type) if venue_type else None,
            "pitchConditions": pitch_conditions,
            "weatherConditions": weather_conditions,
            "jerseys": jerseys,
        },
        "lineups": player_index.get("teams", []),
        "stats": _score_summary(latest_score, fixture=fixture),
        "additionalTime": additional_time,
    }


def build_full_match_data(
    records: Iterable[dict[str, Any]],
    *,
    fixture: dict[str, Any] | None = None,
    include_raw: bool = True,
) -> dict[str, Any]:
    records_list = [record for record in records if isinstance(record, dict)]
    timeline = build_timeline(
        records_list,
        fixture=fixture,
        important_only=False,
        include_possession_changes=True,
        limit=None,
    )
    payload = {
        "fixture": fixture,
        "recordCount": len(records_list),
        "details": build_match_details(records_list, fixture=fixture),
        "timeline": timeline,
        "inventory": build_record_inventory(records_list),
        "latestState": _latest_match_state(records_list, fixture=fixture),
    }
    if include_raw:
        payload["rawRecords"] = records_list
    return payload


def build_record_inventory(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    records_list = [record for record in records if isinstance(record, dict)]
    action_counts: Counter[str] = Counter()
    top_field_counts: Counter[str] = Counter()
    data_field_counts: Counter[str] = Counter()
    nested_path_counts: Counter[str] = Counter()
    score_field_counts: Counter[str] = Counter()
    stats_field_counts: Counter[str] = Counter()
    participant_state_field_counts: Counter[str] = Counter()
    possible_event_field_counts: Counter[str] = Counter()
    possession_type_counts: Counter[str] = Counter()
    type_counts: Counter[str] = Counter()
    game_state_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    coverage_counts: Counter[str] = Counter()
    confirmed_counts: Counter[str] = Counter()
    sample_values: dict[str, list[Any]] = {}

    for record in records_list:
        action = clean_text(pick(record, "Action", "action"))
        if action:
            action_counts[action] += 1

        for key, value in record.items():
            key_text = str(key)
            top_field_counts[key_text] += 1
            _add_sample(sample_values, key_text, value)

        _collect_paths(record, nested_path_counts, max_depth=4)

        data = _event_data(record)
        for key, value in data.items():
            key_text = str(key)
            data_field_counts[key_text] += 1
            _add_sample(sample_values, f"Data.{key_text}", value)

        score = _event_score(record)
        if not score and isinstance(record.get("scoreSoccer"), dict):
            score = record["scoreSoccer"]
        _collect_paths(score, score_field_counts, max_depth=4)

        stats = record.get("Stats")
        if isinstance(stats, dict):
            _collect_paths(stats, stats_field_counts, max_depth=4)

        for state_key in ("Parti1State", "Parti2State"):
            state = record.get(state_key)
            if isinstance(state, dict):
                _collect_paths(state, participant_state_field_counts, prefix=state_key, max_depth=4)

        possible_event = record.get("PossibleEvent")
        if isinstance(possible_event, dict):
            _collect_paths(possible_event, possible_event_field_counts, max_depth=4)

        for key, counter in (
            ("PossessionType", possession_type_counts),
            ("Type", type_counts),
            ("GameState", game_state_counts),
            ("StatusId", status_counts),
            ("CoverageType", coverage_counts),
            ("Confirmedd", confirmed_counts),
        ):
            value = pick(record, key, key[:1].lower() + key[1:])
            text = clean_text(value)
            if text:
                counter[text] += 1

    return {
        "recordCount": len(records_list),
        "actionCounts": _counter_to_dict(action_counts),
        "topFieldCounts": _counter_to_dict(top_field_counts),
        "dataFieldCounts": _counter_to_dict(data_field_counts),
        "nestedFieldPaths": _counter_to_dict(nested_path_counts),
        "scoreFieldPaths": _counter_to_dict(score_field_counts),
        "statsFieldPaths": _counter_to_dict(stats_field_counts),
        "participantStateFieldPaths": _counter_to_dict(participant_state_field_counts),
        "possibleEventFieldPaths": _counter_to_dict(possible_event_field_counts),
        "possessionTypeCounts": _counter_to_dict(possession_type_counts),
        "typeCounts": _counter_to_dict(type_counts),
        "gameStateCounts": _counter_to_dict(game_state_counts),
        "statusCounts": _counter_to_dict(status_counts),
        "coverageTypeCounts": _counter_to_dict(coverage_counts),
        "confirmedCounts": _counter_to_dict(confirmed_counts),
        "sampleValues": sample_values,
    }


def build_timeline(
    records: Iterable[dict[str, Any]],
    *,
    fixture: dict[str, Any] | None = None,
    important_only: bool = True,
    include_possession_changes: bool = True,
    limit: int | None = 300,
) -> dict[str, Any]:
    records_list = [record for record in records if isinstance(record, dict)]
    player_index = build_player_index(records_list)
    all_normalized = [normalize_score_record(record, fixture=fixture, player_index=player_index) for record in records_list]
    all_normalized.sort(key=_event_sort_key)
    annotate_discarded_actions(all_normalized)
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
        "playersIndexed": len(player_index.get("byNormativeId", {})),
        "count": len(normalized),
        "score": latest_score,
        "latestState": _latest_match_state(records_list, fixture=fixture),
        "events": normalized,
    }


def annotate_discarded_actions(events: list[dict[str, Any]]) -> None:
    by_id: dict[tuple[Any, Any], dict[str, Any]] = {}
    for event in events:
        event_id = event.get("id")
        fixture_id = event.get("fixtureId")
        action = event.get("action")
        if event_id is None:
            continue

        key = (fixture_id, event_id)
        if action == "action_discarded":
            previous = by_id.get(key)
            _mark_discarded_action(event, previous)
        else:
            by_id[key] = event


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


def _highlight_flags(soccer: dict[str, Any], text_blob: str, *, action: str | None = None, event_type: str | None = None) -> list[str]:
    flags: list[str] = []

    def add(flag: str, condition: bool) -> None:
        if condition and flag not in flags:
            flags.append(flag)

    add("goal", as_bool(soccer.get("Goal")) or _contains_scoring_goal(text_blob))
    add("penalty", as_bool(soccer.get("Penalty")) or _is_penalty_action(action, event_type))
    add(
        "free_kick",
        bool(clean_text(soccer.get("FreeKickType")) or clean_text(nested_get(soccer, "New", "FreeKickType")))
        or "free kick" in text_blob
        or "free_kick" in text_blob
        or "freekick" in text_blob
        or "coup franc" in text_blob,
    )
    add("corner", as_bool(soccer.get("Corner")) or "corner" in text_blob)
    add("red_card", as_bool(soccer.get("RedCard")) or "red card" in text_blob or "red_card" in text_blob)
    add("yellow_card", as_bool(soccer.get("YellowCard")) or "yellow card" in text_blob or "yellow_card" in text_blob)
    add("var", as_bool(soccer.get("VAR")) or "var" in text_blob or "true" in text_blob and "possible" in text_blob)
    add("discarded", "action_discarded" in text_blob)
    add("substitution", "substitution" in text_blob)
    add("injury", "injury" in text_blob)
    add("additional_time", "additional_time" in text_blob)
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
    minute = _first_int(
        soccer.get("Minutes"),
        soccer.get("minutes"),
        nested_get(soccer, "New", "Minutes"),
        nested_get(soccer, "New", "minutes"),
    )
    if minute is not None:
        return minute

    seconds = _clock_seconds(payload, soccer)
    if seconds is None:
        return None
    return int(seconds // 60) + 1


def _clock_seconds(payload: dict[str, Any], soccer: dict[str, Any]) -> int | None:
    return _first_int(
        nested_get(payload, "clock", "seconds"),
        nested_get(payload, "Clock", "Seconds"),
        nested_get(payload, "Clock", "seconds"),
        nested_get(soccer, "New", "Clock", "seconds"),
        nested_get(soccer, "Previous", "Clock", "seconds"),
    )


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


def _event_data(payload: dict[str, Any]) -> dict[str, Any]:
    data = pick(payload, "Data", "data")
    return data if isinstance(data, dict) else {}


def _event_score(payload: dict[str, Any]) -> dict[str, Any]:
    score = pick(payload, "Score", "score")
    return score if isinstance(score, dict) else {}


def _official_event_score(
    score: dict[str, Any],
    *,
    action: str | None,
    event_type: str | None,
    outcome: str | None,
    confirmed: Any,
    flags: list[str],
) -> dict[str, Any]:
    if not _score_has_value(score):
        return {"participant1": None, "participant2": None}
    if confirmed is not None and not as_bool(confirmed):
        return {"participant1": None, "participant2": None}
    if _event_score_is_cancelled(action, event_type, outcome, flags):
        return {"participant1": None, "participant2": None}
    return score


def _score_has_value(score: dict[str, Any]) -> bool:
    return score.get("participant1") is not None or score.get("participant2") is not None


def _event_score_is_cancelled(action: Any, event_type: Any, outcome: Any, flags: list[str]) -> bool:
    text = " ".join(
        str(part)
        for part in (
            action,
            event_type,
            outcome,
            " ".join(flags),
        )
        if part is not None
    ).casefold()
    return any(
        marker in text
        for marker in (
            "action_discarded",
            "discarded",
            "overturned",
            "cancelled",
            "canceled",
            "annule",
            "annulé",
            "no goal",
            "no_goal",
        )
    )


def _latest_raw_score(records: list[dict[str, Any]]) -> dict[str, Any]:
    for record in reversed(records):
        score = _event_score(record)
        if score:
            return score
    return {}


def _first_not_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _first_int(*values: Any) -> int | None:
    """Return the first integer-like value, skipping empty or malformed fallbacks."""
    for value in values:
        if value is None or value == "":
            continue
        try:
            return int(value)
        except (TypeError, ValueError, OverflowError):
            continue
    return None


def _event_details(
    *,
    participant_label: str | None,
    possession_label: str | None,
    possession_type: str | None,
    event_type: str | None,
    outcome: str | None,
    free_kick_type: str | None,
    goal_type: str | None,
    throw_in_type: str | None,
    confirmed: Any,
    top_data: dict[str, Any],
    player: dict[str, Any] | None,
    player_in: dict[str, Any] | None,
    player_out: dict[str, Any] | None,
) -> list[str]:
    details: list[str] = []
    if participant_label:
        details.append(f"Team: {participant_label}")
    if possession_label:
        possession_detail = f"Possession: {possession_label}"
        if possession_type:
            possession_detail += f" ({_humanize_token(possession_type)})"
        details.append(possession_detail)
    elif possession_type:
        details.append(f"Possession type: {_humanize_token(possession_type)}")
    if event_type:
        details.append(f"Type: {_humanize_token(event_type)}")
    if outcome:
        details.append(f"Result: {_humanize_token(outcome)}")
    if goal_type:
        details.append(f"Goal type: {_humanize_token(goal_type)}")
    if free_kick_type:
        details.append(f"Free kick: {_humanize_token(free_kick_type)}")
    if throw_in_type:
        details.append(f"Throw-in: {_humanize_token(throw_in_type)}")
    if player:
        details.append(f"Player: {_player_label(player)}")
    if player_in:
        details.append(f"Player in: {_player_label(player_in)}")
    if player_out:
        details.append(f"Player out: {_player_label(player_out)}")
    if top_data.get("Minutes") is not None:
        details.append(f"Added time: +{top_data['Minutes']} min")
    if confirmed is not None:
        details.append("Confirmed" if as_bool(confirmed) else "Pending confirmation")
    possible_cards = []
    if "RedCard" in top_data:
        possible_cards.append(f"red={'yes' if as_bool(top_data.get('RedCard')) else 'no'}")
    if "YellowCard" in top_data:
        possible_cards.append(f"yellow={'yes' if as_bool(top_data.get('YellowCard')) else 'no'}")
    if "VAR" in top_data:
        possible_cards.append(f"VAR={'yes' if as_bool(top_data.get('VAR')) else 'no'}")
    if possible_cards:
        details.append("Check possible: " + ", ".join(possible_cards))
    return details


def build_player_index(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    by_normative_id: dict[str, dict[str, Any]] = {}
    by_fixture_player_id: dict[str, dict[str, Any]] = {}
    teams_by_id: dict[str, dict[str, Any]] = {}
    seen_players_by_team: dict[str, set[str]] = {}

    for record in records:
        lineups = record.get("Lineups") or record.get("lineups")
        if not isinstance(lineups, list):
            continue
        for team in lineups:
            if not isinstance(team, dict):
                continue
            team_id = str(team.get("normativeId") or team.get("id") or team.get("preferredName"))
            team_entry = teams_by_id.setdefault(
                team_id,
                {
                    "teamId": team.get("normativeId"),
                    "teamName": team.get("preferredName"),
                    "starters": [],
                    "substitutes": [],
                    "players": [],
                },
            )
            for lineup_player in team.get("lineups") or []:
                if not isinstance(lineup_player, dict):
                    continue
                player = lineup_player.get("player") if isinstance(lineup_player.get("player"), dict) else {}
                normalized = {
                    "fixturePlayerId": lineup_player.get("fixturePlayerId"),
                    "normativeId": player.get("normativeId"),
                    "id": player.get("id"),
                    "name": player.get("preferredName"),
                    "country": player.get("country"),
                    "dateOfBirth": player.get("dateOfBirth"),
                    "rosterNumber": lineup_player.get("rosterNumber"),
                    "starter": bool(lineup_player.get("starter")),
                    "positionId": lineup_player.get("positionId"),
                    "teamId": team.get("normativeId"),
                    "teamName": team.get("preferredName"),
                }
                if normalized["normativeId"] is not None:
                    by_normative_id[str(normalized["normativeId"])] = normalized
                if normalized["fixturePlayerId"] is not None:
                    by_fixture_player_id[str(normalized["fixturePlayerId"])] = normalized
                player_key = _lineup_player_key(normalized)
                seen_players = seen_players_by_team.setdefault(team_id, set())
                if player_key in seen_players:
                    continue
                seen_players.add(player_key)
                team_entry["players"].append(normalized)
                if normalized["starter"]:
                    team_entry["starters"].append(normalized)
                else:
                    team_entry["substitutes"].append(normalized)

    return {
        "byNormativeId": by_normative_id,
        "byFixturePlayerId": by_fixture_player_id,
        "teams": list(teams_by_id.values()),
    }


def _lineup_player_key(player: dict[str, Any]) -> str:
    for key in ("normativeId", "fixturePlayerId", "id"):
        value = player.get(key)
        if value is not None:
            return f"{key}:{value}"
    return f"fallback:{player.get('teamId')}:{player.get('rosterNumber')}:{player.get('name')}"


def _lookup_player(player_id: Any, player_index: dict[str, Any] | None) -> dict[str, Any] | None:
    if player_id is None or not player_index:
        return None
    key = str(player_id)
    return player_index.get("byNormativeId", {}).get(key) or player_index.get("byFixturePlayerId", {}).get(key)


def _player_label(player: dict[str, Any]) -> str:
    number = player.get("rosterNumber")
    name = player.get("name") or f"Player {player.get('normativeId')}"
    return f"#{number} {name}" if number else str(name)


def _score_summary(score: dict[str, Any], *, fixture: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "participant1": _team_score_summary(score.get("Participant1") or score.get("participant1") or {}, (fixture or {}).get("participant1")),
        "participant2": _team_score_summary(score.get("Participant2") or score.get("participant2") or {}, (fixture or {}).get("participant2")),
    }


def _team_score_summary(team_score: dict[str, Any], label: str | None) -> dict[str, Any]:
    total = team_score.get("Total") if isinstance(team_score.get("Total"), dict) else {}
    return {
        "label": label,
        "goals": total.get("Goals"),
        "corners": total.get("Corners"),
        "yellowCards": total.get("YellowCards"),
        "redCards": total.get("RedCards"),
    }


def _period_from_clock(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    return "H1" if seconds < 60 * 60 else "H2"


def _latest_match_state(records: list[dict[str, Any]], *, fixture: dict[str, Any] | None = None) -> dict[str, Any]:
    latest = next((record for record in reversed(records) if isinstance(record, dict)), {})
    latest_score = _latest_raw_score(records)
    participant = pick(latest, "Participant", "participant")
    possession = pick(latest, "Possession", "possession")
    return {
        "fixtureId": pick(latest, "FixtureId", "fixtureId", default=(fixture or {}).get("fixtureId")),
        "gameState": pick(latest, "GameState", "gameState"),
        "statusId": pick(latest, "StatusId", "statusId"),
        "type": pick(latest, "Type", "type"),
        "clock": pick(latest, "Clock", "clock"),
        "kickoff": pick(latest, "Kickoff", "kickoff"),
        "coverageType": pick(latest, "CoverageType", "coverageType"),
        "coverageSecondaryData": pick(latest, "CoverageSecondaryData", "coverageSecondaryData"),
        "participant": participant,
        "participantLabel": _participant_label(participant, latest, fixture),
        "possession": possession,
        "possessionLabel": _participant_label(possession, latest, fixture),
        "possessionType": pick(latest, "PossessionType", "possessionType"),
        "confirmed": pick(latest, "Confirmedd", "confirmed"),
        "score": _score_summary(latest_score, fixture=fixture),
        "parti1State": latest.get("Parti1State"),
        "parti2State": latest.get("Parti2State"),
        "possibleEvent": latest.get("PossibleEvent"),
    }


def _collect_paths(
    value: Any,
    counter: Counter[str],
    *,
    prefix: str = "",
    depth: int = 0,
    max_depth: int = 4,
) -> None:
    if depth >= max_depth:
        return
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            counter[path] += 1
            _collect_paths(child, counter, prefix=path, depth=depth + 1, max_depth=max_depth)
    elif isinstance(value, list):
        path = f"{prefix}[]" if prefix else "[]"
        counter[path] += 1
        for child in value[:3]:
            _collect_paths(child, counter, prefix=path, depth=depth + 1, max_depth=max_depth)


def _add_sample(samples: dict[str, list[Any]], key: str, value: Any, limit: int = 5) -> None:
    sample = _sample_value(value)
    if sample is None:
        return
    bucket = samples.setdefault(key, [])
    if sample in bucket or len(bucket) >= limit:
        return
    bucket.append(sample)


def _sample_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return {"type": "list", "length": len(value)}
    if isinstance(value, dict):
        return {"type": "object", "keys": list(value.keys())[:8]}
    return clean_text(value)


def _counter_to_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items(), key=lambda item: (-item[1], item[0])))


def _sortable_value(value: Any) -> tuple[int, Decimal, str]:
    """Return a stable key for upstream identifiers that may mix numbers and strings."""
    if value is None or value == "":
        return (0, Decimal(0), "")
    try:
        numeric = Decimal(str(value))
        if numeric.is_finite():
            return (0, numeric, "")
    except (InvalidOperation, TypeError, ValueError):
        pass
    return (1, Decimal(0), str(value))


def _event_sort_key(item: dict[str, Any]) -> tuple[Any, Any, Any]:
    return (
        _sortable_value(item.get("ts")),
        _sortable_value(item.get("seq")),
        _sortable_value(item.get("id")),
    )


def _mark_discarded_action(event: dict[str, Any], previous: dict[str, Any] | None) -> None:
    flags = event.setdefault("highlights", [])
    if "discarded" not in flags:
        flags.append("discarded")
    event["isHighlight"] = True
    event["discardedAction"] = previous.get("action") if previous else None
    event["discardedParticipantLabel"] = previous.get("participantLabel") if previous else None
    action_label = _event_title(previous.get("action") if previous else None)
    bits = ["Action discarded"]
    if action_label:
        bits.append(action_label)
    if previous and previous.get("participantLabel"):
        bits.append(previous["participantLabel"])
    event["description"] = " - ".join(bits)
    event["details"] = [
        detail
        for detail in [
            f"Annule l'action Seq {previous.get('seq')}" if previous and previous.get("seq") is not None else None,
            f"Action originale: {_humanize_token(previous.get('action'))}" if previous and previous.get("action") else None,
        ]
        if detail
    ]


def _mark_possession_change(event: dict[str, Any], previous: dict[str, Any]) -> None:
    flags = event.setdefault("highlights", [])
    had_action_highlight = bool([flag for flag in flags if flag != "possession"])
    if "possession" not in flags:
        flags.append("possession")
    event["isHighlight"] = True
    event["possessionChanged"] = True
    event["previousPossession"] = previous.get("possession")
    event["previousPossessionLabel"] = previous.get("label")
    possession_detail = _possession_description(event, previous)
    if had_action_highlight:
        details = event.setdefault("details", [])
        if possession_detail not in details:
            details.append(possession_detail)
    else:
        event["description"] = possession_detail


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


def _is_penalty_action(*values: Any) -> bool:
    false_prefixes = ("penalty_area", "penalty_box", "penalty_arc", "penalty_possible")
    true_tokens = {
        "penalty",
        "penalties",
        "penalty_awarded",
        "penalty_given",
        "penalty_kick",
        "penalty_scored",
        "penalty_saved",
        "penalty_missed",
        "penalty_confirmed",
        "spot_kick",
    }
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        token = re.sub(r"[^a-z0-9]+", "_", text.casefold()).strip("_")
        if not token or token.startswith(false_prefixes):
            continue
        if token in true_tokens:
            return True
        if token.startswith("penalty_") and "possible" not in token:
            return True
    return False


def _event_title(action: str | None) -> str | None:
    if not action:
        return None
    return {
        "goal": "Goal",
        "penalty": "Penalty",
        "free_kick": "Free kick",
        "corner": "Corner",
        "var": "VAR",
        "var_end": "VAR end",
        "shot": "Shot",
        "possible": "Check possible",
        "action_discarded": "Action discarded",
    }.get(action, _humanize_token(action))


def _humanize_token(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    words = re.sub(r"(?<!^)([A-Z])", r" \1", text.replace("_", " ")).split()
    return " ".join(words).capitalize()


def _description(
    flags: list[str],
    minute: int | None,
    participant_label: str | None,
    action: str | None,
    event_type: str | None,
    outcome: str | None,
    free_kick_type: str | None,
    confirmed: Any,
    player: dict[str, Any] | None,
    player_in: dict[str, Any] | None,
    player_out: dict[str, Any] | None,
) -> str:
    label_map = {
        "goal": "Goal",
        "penalty": "Penalty",
        "free_kick": "Free kick",
        "corner": "Corner",
        "red_card": "Red card",
        "yellow_card": "Yellow card",
        "var": "VAR",
        "possession": "Possession",
        "discarded": "Action discarded",
        "substitution": "Substitution",
        "injury": "Blessure",
        "additional_time": "Added time",
    }
    title = " / ".join(label_map.get(flag, flag) for flag in flags) if flags else (_event_title(action) or event_type or "Update")
    bits = [title]
    if minute is not None:
        bits.append(f"{minute}'")
    if participant_label:
        bits.append(participant_label)
    if player:
        bits.append(_player_label(player))
    if player_in or player_out:
        change_bits = []
        if player_in:
            change_bits.append(f"entre {_player_label(player_in)}")
        if player_out:
            change_bits.append(f"sort {_player_label(player_out)}")
        bits.append(", ".join(change_bits))
    detail = outcome or event_type or free_kick_type or action
    detail_text = _humanize_token(detail)
    if detail_text and detail_text.casefold() not in title.casefold():
        bits.append(detail_text)
    if confirmed is not None:
        bits.append("confirme" if as_bool(confirmed) else "not confirmed")
    return " - ".join(bits)


def _latest_score(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    score = {"participant1": 0, "participant2": 0}
    seen_score = False
    for event in events:
        event_score = event.get("score")
        if not isinstance(event_score, dict):
            continue
        for participant in ("participant1", "participant2"):
            value = event_score.get(participant)
            if value is not None:
                score[participant] = value
                seen_score = True
    if seen_score:
        return score
    return None


async def retry_once_on_remote_close(call):
    try:
        return await call()
    except httpx.RemoteProtocolError:
        await asyncio.sleep(0.5)
        return await call()
