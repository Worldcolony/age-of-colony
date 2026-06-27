from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .txline import (
    TxLineClient,
    TxLineConfigError,
    TxLineSettings,
    annotate_possession_changes,
    build_timeline,
    epoch_day_from_date,
    normalize_fixture,
    normalize_fixtures,
    normalize_score_record,
    parse_date_to_epoch_day,
)


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Age of Colony TXLine Monitor", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.exception_handler(TxLineConfigError)
async def txline_config_error_handler(_: Request, exc: TxLineConfigError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "detail": str(exc),
            "hint": "Configure TXLINE_JWT and TXLINE_API_TOKEN before calling TXLine endpoints.",
        },
    )


@app.exception_handler(httpx.HTTPStatusError)
async def txline_status_error_handler(_: Request, exc: httpx.HTTPStatusError) -> JSONResponse:
    response = exc.response
    detail: Any
    try:
        detail = response.json()
    except ValueError:
        detail = response.text
    return JSONResponse(
        status_code=response.status_code,
        content={"detail": detail, "upstream_status": response.status_code},
    )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    settings = TxLineSettings.from_env()
    return {
        "ok": True,
        "txlineConfigured": settings.configured,
        "baseUrl": settings.base_url,
        "defaultCompetitionId": settings.default_competition_id,
    }


@app.get("/api/fixtures")
async def fixtures(
    date_: date | None = Query(default=None, alias="date"),
    start_epoch_day: int | None = Query(default=None),
    competition_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    if date_ is not None:
        start_epoch_day = epoch_day_from_date(date_)
    client = TxLineClient()
    raw = await client.fixture_snapshot(start_epoch_day=start_epoch_day, competition_id=competition_id)
    normalized = normalize_fixtures(raw, search=search)
    return {"count": len(normalized), "fixtures": normalized}


@app.get("/api/scores/{fixture_id}/snapshot")
async def score_snapshot(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_snapshot(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/updates")
async def score_updates(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_updates(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/historical")
async def score_historical(fixture_id: int) -> dict[str, Any]:
    client = TxLineClient()
    records = await client.score_historical(fixture_id)
    return {"fixtureId": fixture_id, "count": len(records), "records": records}


@app.get("/api/scores/{fixture_id}/timeline")
async def score_timeline(
    fixture_id: int,
    source: str = Query(default="historical", pattern="^(historical|snapshot|updates)$"),
    important_only: bool = Query(default=True),
    include_possession: bool = Query(default=True),
    limit: int = Query(default=300, ge=1, le=2000),
    participant1: str | None = Query(default=None),
    participant2: str | None = Query(default=None),
) -> dict[str, Any]:
    client = TxLineClient()
    if source == "snapshot":
        records = await client.score_snapshot(fixture_id)
        resolved_source = "snapshot"
    elif source == "updates":
        records = await client.score_updates(fixture_id)
        resolved_source = "updates"
    else:
        records = await client.score_historical(fixture_id)
        resolved_source = "historical"
        if not records:
            records = await client.score_updates(fixture_id)
            resolved_source = "updates"

    fixture = {
        "fixtureId": fixture_id,
        "participant1": participant1,
        "participant2": participant2,
    }
    timeline = build_timeline(
        records,
        fixture=fixture,
        important_only=important_only,
        include_possession_changes=include_possession,
        limit=limit,
    )
    timeline["source"] = source
    timeline["resolvedSource"] = resolved_source
    timeline["includePossession"] = include_possession
    return timeline


@app.get("/api/scores/interval")
async def score_interval(
    epoch_day: int | None = Query(default=None),
    date_: str | None = Query(default=None, alias="date"),
    hour: int = Query(ge=0, le=23),
    interval: int = Query(ge=0, le=11),
    important_only: bool = Query(default=True),
    include_possession: bool = Query(default=True),
    limit: int = Query(default=300, ge=1, le=2000),
) -> dict[str, Any]:
    if epoch_day is None:
        if not date_:
            raise HTTPException(status_code=422, detail="Provide either epoch_day or date=YYYY-MM-DD.")
        epoch_day = parse_date_to_epoch_day(date_)

    client = TxLineClient()
    records = await client.score_interval(epoch_day, hour, interval)
    timeline = build_timeline(
        records,
        important_only=important_only,
        include_possession_changes=include_possession,
        limit=limit,
    )
    timeline.update({"epochDay": epoch_day, "hour": hour, "interval": interval, "includePossession": include_possession})
    return timeline


@app.get("/api/live/events")
async def live_events(
    fixture_id: int | None = Query(default=None),
    important_only: bool = Query(default=False),
    include_possession: bool = Query(default=True),
) -> StreamingResponse:
    async def generate() -> AsyncIterator[str]:
        client = TxLineClient()
        possession_state: dict[Any, dict[str, Any]] = {}
        try:
            async for event in client.stream_score_events():
                event_name = event.get("event") or "score"
                if event_name == "heartbeat":
                    yield _sse("heartbeat", event.get("data") or {})
                    continue

                data = event.get("data")
                if not isinstance(data, dict):
                    yield _sse("raw", event)
                    continue

                normalized = normalize_score_record(data)
                if include_possession:
                    annotate_possession_changes([normalized], possession_state)
                if fixture_id is not None and str(normalized.get("fixtureId")) != str(fixture_id):
                    continue
                if important_only and not normalized["isHighlight"]:
                    continue

                yield _sse("score", normalized, event_id=event.get("id"))
        except TxLineConfigError as exc:
            yield _sse("txline_error", {"detail": str(exc)})
        except httpx.HTTPStatusError as exc:
            yield _sse("txline_error", {"detail": "TXLine stream refused the request.", "status": exc.response.status_code})
        except asyncio.CancelledError:
            return
        except Exception as exc:  # Keeps EventSource clients informed instead of silently closing.
            yield _sse("txline_error", {"detail": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sse(event: str, data: Any, event_id: str | None = None) -> str:
    lines = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for line in payload.splitlines() or ["{}"]:
        lines.append(f"data: {line}")
    return "\n".join(lines) + "\n\n"
