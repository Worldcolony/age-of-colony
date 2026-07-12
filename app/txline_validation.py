from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Iterable


class TxLineOnChainValidationError(RuntimeError):
    """Raised when the local Anchor bridge cannot validate a TxLINE proof."""


VALIDATOR_SCRIPT = Path(__file__).resolve().parents[1] / "web" / "scripts" / "txline" / "validate-proof.cjs"


def txline_network(base_url: str) -> str:
    return "devnet" if "txline-dev" in base_url.casefold() else "mainnet"


def find_finalized_score_record(records: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    finalized: list[dict[str, Any]] = []
    for record in records:
        action = str(record.get("Action") or record.get("action") or "").strip().casefold()
        status_id = record.get("StatusId") if record.get("StatusId") is not None else record.get("statusId")
        if action == "game_finalised" and str(status_id) == "100":
            finalized.append(record)
    if not finalized:
        return None
    return max(finalized, key=_record_sequence)


def final_score_from_stats(stats: Iterable[dict[str, Any]]) -> dict[str, int | None]:
    values: dict[int, int] = {}
    for stat in stats:
        try:
            values[int(stat.get("key"))] = int(stat.get("value"))
        except (TypeError, ValueError):
            continue
    return {"participant1": values.get(1), "participant2": values.get(2)}


def winner_from_score(score: dict[str, int | None]) -> str | None:
    participant1 = score.get("participant1")
    participant2 = score.get("participant2")
    if participant1 is None or participant2 is None:
        return None
    if participant1 > participant2:
        return "participant1"
    if participant2 > participant1:
        return "participant2"
    return "draw"


async def validate_txline_proof_onchain(
    proof: dict[str, Any],
    *,
    network: str,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    if network != "mainnet":
        raise TxLineOnChainValidationError("The current Anchor bridge supports TxLINE mainnet proofs only.")
    if not VALIDATOR_SCRIPT.exists():
        raise TxLineOnChainValidationError(f"TxLINE validator script is missing: {VALIDATOR_SCRIPT}")

    timeout = timeout_seconds or float(os.getenv("TXLINE_VALIDATION_TIMEOUT_SECONDS", "30"))
    process = await asyncio.create_subprocess_exec(
        "node",
        str(VALIDATOR_SCRIPT),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    payload = json.dumps({"network": network, "proof": proof}, separators=(",", ":")).encode("utf-8")
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(payload), timeout=timeout)
    except TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise TxLineOnChainValidationError(f"TxLINE on-chain validation timed out after {timeout:g}s.") from exc

    if process.returncode != 0:
        detail = _decode_process_message(stderr) or _decode_process_message(stdout) or "Unknown Anchor simulation error."
        raise TxLineOnChainValidationError(detail)

    try:
        result = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TxLineOnChainValidationError("TxLINE validator returned malformed JSON.") from exc
    if not isinstance(result, dict):
        raise TxLineOnChainValidationError("TxLINE validator returned an unexpected result.")
    return result


def _record_sequence(record: dict[str, Any]) -> int:
    value = record.get("Seq") if record.get("Seq") is not None else record.get("seq")
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _decode_process_message(raw: bytes) -> str:
    if not raw:
        return ""
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw.decode("utf-8", errors="replace").strip()
    if not isinstance(decoded, dict):
        return str(decoded)
    message = str(decoded.get("error") or "Anchor simulation failed.")
    simulation_error = decoded.get("simulationError")
    if simulation_error:
        message = f"{message} ({simulation_error})"
    return message
