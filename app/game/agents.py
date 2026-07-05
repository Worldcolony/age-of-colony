from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from inspect import signature
from typing import Any, Protocol

import httpx


class AgentDecisionError(RuntimeError):
    """Raised when the live agent cannot provide the required ant decisions."""

    def __init__(self, message: str, *, details: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.details = details or []


def _load_dotenv(path: str = ".env") -> None:
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


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "y", "oui"}
    return bool(value)


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _truncate(value: Any, limit: int = 700) -> str:
    text = str(value or "")
    return text if len(text) <= limit else f"{text[:limit]}..."


def _message_json(data: dict[str, Any]) -> Any:
    message = (data.get("choices") or [{}])[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise AgentDecisionError(
                "DeepSeek returned invalid JSON.",
                details=[
                    {
                        "category": "invalid_assistant_json",
                        "message": str(exc),
                        "contentSnippet": _truncate(content, 1600),
                    }
                ],
            ) from exc
    if isinstance(content, dict):
        return content
    if isinstance(content, list):
        text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not text.strip():
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise AgentDecisionError(
                "DeepSeek returned invalid JSON.",
                details=[
                    {
                        "category": "invalid_assistant_json",
                        "message": str(exc),
                        "contentSnippet": _truncate(text, 1600),
                    }
                ],
            ) from exc
    return {}


def _safe_response_text(response: httpx.Response | None) -> str | None:
    if response is None:
        return None
    try:
        return _truncate(response.text)
    except Exception:
        return None


def describe_agent_exception(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, AgentDecisionError):
        detail = {"type": exc.__class__.__name__, "message": _truncate(str(exc), 500)}
        if exc.details:
            first = exc.details[0]
            if isinstance(first, dict):
                for key in (
                    "category",
                    "statusCode",
                    "retryable",
                    "responseBody",
                    "contentSnippet",
                    "parsedSnippet",
                    "parsedType",
                    "rejectionReason",
                    "expectedAntIds",
                    "candidateAntIds",
                    "finishReason",
                    "model",
                ):
                    if key in first:
                        detail[key] = first[key]
            detail["details"] = exc.details[:3]
        return detail

    detail: dict[str, Any] = {
        "type": exc.__class__.__name__,
        "message": _truncate(str(exc), 500),
    }
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        detail.update(
            {
                "category": "http_status",
                "statusCode": response.status_code,
                "retryable": should_retry_openrouter_error(exc),
                "responseBody": _safe_response_text(response),
            }
        )
    elif isinstance(exc, httpx.TimeoutException):
        detail.update({"category": "timeout", "retryable": True})
    elif isinstance(exc, httpx.RequestError):
        detail.update({"category": "request_error", "retryable": True})
    elif isinstance(exc, json.JSONDecodeError):
        detail.update({"category": "invalid_json", "retryable": False})
    else:
        detail.update({"category": "unknown", "retryable": False})
    return detail


def _should_retry_ant_output_error(detail: dict[str, Any]) -> bool:
    category = detail.get("category")
    if category in {"invalid_assistant_json", "missing_ant_decision"}:
        return True
    nested = detail.get("details")
    if isinstance(nested, list):
        return any(isinstance(item, dict) and _should_retry_ant_output_error(item) for item in nested)
    return False


def _can_convert_ant_failure_to_abstain(detail: dict[str, Any]) -> bool:
    category = detail.get("category")
    if category in {"invalid_assistant_json", "missing_ant_decision"}:
        return True
    nested = detail.get("details")
    if isinstance(nested, list):
        return any(isinstance(item, dict) and _can_convert_ant_failure_to_abstain(item) for item in nested)
    return False


def _technical_abstain_decision(detail: dict[str, Any]) -> "AntAgentDecision":
    category = str(detail.get("category") or detail.get("type") or "agent_output_error")
    return AntAgentDecision(
        ant_id=str(detail.get("antId") or ""),
        vote="abstain",
        action="neutral",
        option_id=None,
        reason=f"technical abstain: DeepSeek output error ({category})",
        raw={"_callMode": "per_ant", "_technicalAbstain": True, "_failure": detail},
    )


@dataclass(frozen=True)
class OpenRouterSettings:
    api_key: str | None
    model: str = "openai/gpt-4o-mini"
    base_url: str = "https://openrouter.ai/api/v1"
    timeout_seconds: float = 8.0
    max_tokens: int = 1200
    max_calls_per_game: int = 20000
    call_mode: str = "per_ant"
    ant_batch_size: int = 50
    max_parallel_ant_calls: int = 12
    max_retries: int = 2
    retry_delay_seconds: float = 0.5
    input_price_per_million_usd: float = 0.09
    output_price_per_million_usd: float = 0.18
    mode: str = "auto"
    app_title: str = "Age of Colony"
    site_url: str | None = None

    @classmethod
    def from_env(cls) -> "OpenRouterSettings":
        _load_dotenv()
        return cls(
            api_key=os.getenv("OPENROUTER_API_KEY"),
            model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
            base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/"),
            timeout_seconds=float(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "8")),
            max_tokens=max(128, int(os.getenv("OPENROUTER_MAX_TOKENS", "1200"))),
            max_calls_per_game=max(0, int(os.getenv("COLONY_AGENT_MAX_CALLS_PER_GAME", "20000"))),
            call_mode=_normalize_call_mode(os.getenv("COLONY_AGENT_CALL_MODE", "per_ant")),
            ant_batch_size=max(1, min(100, int(os.getenv("COLONY_AGENT_ANT_BATCH_SIZE", "50")))),
            max_parallel_ant_calls=max(1, min(50, int(os.getenv("COLONY_AGENT_MAX_PARALLEL_ANT_CALLS", "12")))),
            max_retries=max(0, min(5, int(os.getenv("OPENROUTER_MAX_RETRIES", "2")))),
            retry_delay_seconds=max(0.0, float(os.getenv("OPENROUTER_RETRY_DELAY_SECONDS", "0.5"))),
            input_price_per_million_usd=float(os.getenv("OPENROUTER_INPUT_PRICE_PER_MILLION_USD", "0.09")),
            output_price_per_million_usd=float(os.getenv("OPENROUTER_OUTPUT_PRICE_PER_MILLION_USD", "0.18")),
            mode=os.getenv("COLONY_AGENT_MODE", "auto").strip().casefold(),
            app_title=os.getenv("OPENROUTER_APP_TITLE", "Age of Colony"),
            site_url=os.getenv("OPENROUTER_SITE_URL") or None,
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.mode != "off" and self.max_calls_per_game > 0)


@dataclass
class OpenRouterUsage:
    api_responses: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    missing_usage_responses: int = 0
    model: str | None = None

    def add_response(self, data: dict[str, Any]) -> None:
        self.api_responses += 1
        if data.get("model"):
            self.model = str(data["model"])

        usage = data.get("usage")
        if not isinstance(usage, dict):
            self.missing_usage_responses += 1
            return

        input_tokens = _as_int(usage.get("prompt_tokens", usage.get("input_tokens")), 0)
        output_tokens = _as_int(usage.get("completion_tokens", usage.get("output_tokens")), 0)
        total_tokens = _as_int(usage.get("total_tokens"), input_tokens + output_tokens)
        if input_tokens <= 0 and output_tokens <= 0 and total_tokens <= 0:
            self.missing_usage_responses += 1
            return
        if input_tokens <= 0 and output_tokens <= 0:
            self.total_tokens += max(0, total_tokens)
            self.missing_usage_responses += 1
            return

        self.input_tokens += max(0, input_tokens)
        self.output_tokens += max(0, output_tokens)
        self.total_tokens += max(0, total_tokens)

    def public_state(self, settings: OpenRouterSettings, *, budgeted_calls: int = 0) -> dict[str, Any]:
        input_cost = (self.input_tokens / 1_000_000) * settings.input_price_per_million_usd
        output_cost = (self.output_tokens / 1_000_000) * settings.output_price_per_million_usd
        return {
            "model": self.model or settings.model,
            "budgetedCalls": budgeted_calls,
            "apiCalls": self.api_responses,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens or self.input_tokens + self.output_tokens,
            "inputCostUsd": round(input_cost, 8),
            "outputCostUsd": round(output_cost, 8),
            "costUsd": round(input_cost + output_cost, 8),
            "costComplete": self.missing_usage_responses == 0,
            "missingUsageResponses": self.missing_usage_responses,
            "pricing": {
                "inputPerMillionUsd": settings.input_price_per_million_usd,
                "outputPerMillionUsd": settings.output_price_per_million_usd,
            },
        }


@dataclass
class ColonyAgentDecision:
    source: str
    stage: str
    action: str
    buy_info: bool = False
    option_id: str | None = None
    stake_fraction: float = 0.0
    confidence: float = 0.0
    reason: str = ""
    squad_votes: list[dict[str, Any]] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def authoritative(self) -> bool:
        return self.source in {"openrouter", "test"}

    def public_state(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "stage": self.stage,
            "action": self.action,
            "buyInfo": self.buy_info,
            "optionId": self.option_id,
            "stakeFraction": round(self.stake_fraction, 3),
            "confidence": round(self.confidence, 3),
            "reason": self.reason,
            "squadVotes": self.squad_votes,
        }


@dataclass
class AntAgentDecision:
    ant_id: str
    vote: str
    action: str
    option_id: str | None = None
    reason: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def public_state(self) -> dict[str, Any]:
        return {
            "antId": self.ant_id,
            "vote": self.vote,
            "action": self.action,
            "optionId": self.option_id,
            "reason": self.reason,
        }


class ColonyDecisionAgent(Protocol):
    def decide(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
    ) -> ColonyAgentDecision | None:
        ...


def should_retry_openrouter_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in {408, 429} or exc.response.status_code >= 500
    return isinstance(exc, httpx.RequestError)


class OpenRouterColonyAgent:
    def __init__(self, settings: OpenRouterSettings) -> None:
        self.settings = settings
        self.calls_by_game: dict[str, int] = {}
        self.usage_by_game: dict[str, OpenRouterUsage] = {}
        self._calls_lock = threading.Lock()
        self._usage_lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "OpenRouterColonyAgent | None":
        settings = OpenRouterSettings.from_env()
        if not settings.configured:
            return None
        return cls(settings)

    def decide(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
    ) -> ColonyAgentDecision | None:
        if not self.settings.configured:
            raise AgentDecisionError("OpenRouter/DeepSeek agent is not configured.")
        if not self._reserve_agent_call(game_id):
            raise AgentDecisionError("Budget d'appels agent atteint pour cette partie.")

        data = self._call_openrouter(game_id=game_id, stage=stage, context=context)
        return self._parse_decision(stage, data, context)

    def usage_for_game(self, game_id: str) -> dict[str, Any]:
        with self._usage_lock:
            usage = self.usage_by_game.get(game_id, OpenRouterUsage())
            budgeted_calls = self.calls_by_game.get(game_id, 0)
            return usage.public_state(self.settings, budgeted_calls=budgeted_calls)

    def _record_usage(self, game_id: str, data: dict[str, Any]) -> None:
        with self._usage_lock:
            usage = self.usage_by_game.setdefault(game_id, OpenRouterUsage())
            usage.add_response(data)

    def _reserve_agent_call(self, game_id: str) -> bool:
        with self._calls_lock:
            calls = self.calls_by_game.get(game_id, 0)
            if calls >= self.settings.max_calls_per_game:
                return False
            self.calls_by_game[game_id] = calls + 1
            return True

    def _call_openrouter(self, *, stage: str, context: dict[str, Any], game_id: str | None = None) -> dict[str, Any]:
        return self._post_chat_completion(self._colony_payload(stage=stage, context=context), game_id=game_id)

    def decide_ants(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
    ) -> list[AntAgentDecision] | None:
        if not self.settings.configured:
            raise AgentDecisionError("OpenRouter/DeepSeek agent is not configured.")
        if not ants:
            return []

        if self.settings.call_mode == "batch":
            return self._decide_ants_batch(game_id=game_id, stage=stage, context=context, ants=ants)
        return self._decide_ants_per_ant(game_id=game_id, stage=stage, context=context, ants=ants)

    def _decide_ants_per_ant(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
    ) -> list[AntAgentDecision] | None:
        with self._calls_lock:
            calls = self.calls_by_game.get(game_id, 0)
        if calls + len(ants) > self.settings.max_calls_per_game:
            raise AgentDecisionError("Agent call budget is too low to control all active ants.")

        vote_map = _vote_map_from_context(context)
        max_workers = min(self.settings.max_parallel_ant_calls, len(ants))
        decisions: list[AntAgentDecision] = []

        def call_single_ant(ant: dict[str, Any]) -> AntAgentDecision | None:
            attempts = self.settings.max_retries + 1
            last_error: Exception | None = None
            for attempt in range(attempts):
                if not self._reserve_agent_call(game_id):
                    raise AgentDecisionError("Budget d'appels agent atteint pour cette partie.")
                try:
                    data = self._call_openrouter_ants_for_game(game_id=game_id, stage=stage, context=context, ants=[ant])
                    parsed = self._parse_ant_decisions(data, [ant], vote_map)
                    if parsed:
                        parsed[0].raw["_callMode"] = "per_ant"
                        if attempt:
                            parsed[0].raw["_retryCount"] = attempt
                        return parsed[0]
                    raise AgentDecisionError(
                        "DeepSeek did not return a decision for this ant.",
                        details=[_ant_decision_failure_detail(data, [ant])],
                    )
                except Exception as exc:
                    last_error = exc
                    detail = describe_agent_exception(exc)
                    if attempt < attempts - 1 and _should_retry_ant_output_error(detail):
                        time.sleep(self.settings.retry_delay_seconds * (2**attempt))
                        continue
                    if isinstance(exc, AgentDecisionError):
                        raise
                    raise
            if isinstance(last_error, AgentDecisionError):
                raise last_error
            raise AgentDecisionError("OpenRouter request failed.")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(call_single_ant, ant): ant for ant in ants}
            failure_details: list[dict[str, Any]] = []
            for future in as_completed(futures):
                ant = futures[future]
                try:
                    decision = future.result()
                except Exception as exc:  # pragma: no cover - provider/network details vary.
                    detail = describe_agent_exception(exc)
                    detail.update(
                        {
                            "antId": str(ant.get("antId") or ""),
                            "archetype": ant.get("archetype"),
                            "stage": stage,
                        }
                    )
                    failure_details.append(detail)
                    continue
                if decision:
                    decisions.append(decision)

        if failure_details:
            if decisions and all(_can_convert_ant_failure_to_abstain(detail) for detail in failure_details):
                decisions.extend(_technical_abstain_decision(detail) for detail in failure_details)
            else:
                first = failure_details[0]
                first_hint = first.get("category") or first.get("type") or "unknown"
                status = f" HTTP {first['statusCode']}" if first.get("statusCode") else ""
                raise AgentDecisionError(
                    f"{len(failure_details)} DeepSeek ant call(s) failed. First failure: {first_hint}{status}.",
                    details=failure_details,
                )
        answered_ids = {decision.ant_id for decision in decisions}
        missing_ids = [str(ant.get("antId") or "") for ant in ants if str(ant.get("antId") or "") not in answered_ids]
        if missing_ids:
            raise AgentDecisionError(
                f"DeepSeek answered for {len(decisions)}/{len(ants)} ants.",
                details=[
                    {
                        "category": "missing_ant_decisions",
                        "missingAntIds": missing_ids[:20],
                        "missingCount": len(missing_ids),
                    }
                ],
            )
        decision_by_id = {decision.ant_id: decision for decision in decisions}
        return [decision_by_id[str(ant.get("antId") or "")] for ant in ants]

    def _decide_ants_batch(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
    ) -> list[AntAgentDecision] | None:
        decisions: list[AntAgentDecision] = []
        batch_size = max(1, self.settings.ant_batch_size)
        for start in range(0, len(ants), batch_size):
            calls = self.calls_by_game.get(game_id, 0)
            if calls >= self.settings.max_calls_per_game or not self._reserve_agent_call(game_id):
                raise AgentDecisionError("Budget d'appels agent atteint pour cette partie.")

            batch = ants[start : start + batch_size]
            data = self._call_openrouter_ants_for_game(game_id=game_id, stage=stage, context=context, ants=batch)
            parsed = self._parse_ant_decisions(data, batch, _vote_map_from_context(context))
            if len(parsed) != len(batch):
                answered_ids = {decision.ant_id for decision in parsed}
                missing_ids = [str(ant.get("antId") or "") for ant in batch if str(ant.get("antId") or "") not in answered_ids]
                raise AgentDecisionError(
                    f"DeepSeek answered for {len(parsed)}/{len(batch)} ants in a batch.",
                    details=[
                        {
                            "category": "missing_ant_decisions",
                            "missingAntIds": missing_ids[:20],
                            "missingCount": len(missing_ids),
                        }
                    ],
                )
            for decision in parsed:
                decision.raw["_callMode"] = "batch"
            decisions.extend(parsed)
        return decisions

    def _call_openrouter_ants_for_game(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
    ) -> dict[str, Any]:
        call = self._call_openrouter_ants
        if "game_id" in signature(call).parameters:
            return call(game_id=game_id, stage=stage, context=context, ants=ants)
        return call(stage=stage, context=context, ants=ants)

    def _call_openrouter_ants(
        self,
        *,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
        game_id: str | None = None,
    ) -> dict[str, Any]:
        return self._post_chat_completion(self._ant_payload(stage=stage, context=context, ants=ants), game_id=game_id)

    def _post_chat_completion(self, payload: dict[str, Any], *, game_id: str | None = None) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
            "X-Title": self.settings.app_title,
        }
        if self.settings.site_url:
            headers["HTTP-Referer"] = self.settings.site_url

        attempts = self.settings.max_retries + 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with httpx.Client(base_url=self.settings.base_url, timeout=self.settings.timeout_seconds) as client:
                    response = client.post("/chat/completions", headers=headers, json=payload)
                    if response.status_code in {400, 422}:
                        fallback_payload = dict(payload)
                        fallback_payload["response_format"] = {"type": "json_object"}
                        response = client.post("/chat/completions", headers=headers, json=fallback_payload)
                    if response.status_code in {400, 422}:
                        fallback_payload = dict(payload)
                        fallback_payload["response_format"] = {"type": "json_object"}
                        fallback_payload.pop("reasoning", None)
                        response = client.post("/chat/completions", headers=headers, json=fallback_payload)
                    response.raise_for_status()
                    try:
                        data = response.json()
                    except ValueError as exc:
                        raise AgentDecisionError(
                            "OpenRouter returned invalid JSON.",
                            details=[
                                {
                                    "category": "invalid_provider_json",
                                    "statusCode": response.status_code,
                                    "responseBody": _safe_response_text(response),
                                }
                            ],
                        ) from exc
                    if game_id:
                        self._record_usage(game_id, data)
                    return data
            except Exception as exc:
                last_error = exc
                if attempt >= attempts - 1 or not should_retry_openrouter_error(exc):
                    if isinstance(exc, AgentDecisionError):
                        raise
                    raise AgentDecisionError(
                        "OpenRouter request failed.",
                        details=[describe_agent_exception(exc) | {"attempt": attempt + 1, "maxAttempts": attempts}],
                    ) from exc
                time.sleep(self.settings.retry_delay_seconds * (2**attempt))
        if isinstance(last_error, AgentDecisionError):
            raise last_error
        raise AgentDecisionError(
            "OpenRouter request failed.",
            details=[describe_agent_exception(last_error) if last_error else {"category": "unknown"}],
        )

    def _colony_payload(self, *, stage: str, context: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "model": self.settings.model,
            "temperature": 0.2,
            "max_tokens": self.settings.max_tokens,
            "reasoning": {"effort": "none", "exclude": True},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "colony_decision",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "action": {"type": "string", "enum": ["predict", "observe"]},
                            "buyInfo": {"type": "boolean"},
                            "optionId": {"type": ["string", "null"]},
                            "stakeFraction": {"type": "number", "minimum": 0, "maximum": 0.8},
                            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                            "reason": {"type": "string", "maxLength": 180},
                            "squadVotes": {
                                "type": "array",
                                "maxItems": 5,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "squad": {"type": "string", "maxLength": 32},
                                        "ants": {"type": "integer", "minimum": 0, "maximum": 500},
                                        "action": {"type": "string", "enum": ["predict", "info", "observe"]},
                                        "optionId": {"type": ["string", "null"]},
                                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                                        "reason": {"type": "string", "maxLength": 80},
                                    },
                                    "required": ["squad", "ants", "action", "optionId", "confidence", "reason"],
                                },
                            },
                        },
                        "required": ["action", "buyInfo", "optionId", "stakeFraction", "confidence", "reason", "squadVotes"],
                    },
                },
            },
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You control a colony in a live football prediction game. "
                        "Simulate internal AI squads (data, momentum, risk, survival, chaos depending on context), "
                        "then return a final queen decision. Squads represent groups of ants, not individuals. "
                        "Respect the ant vote: choose an option only if it has support, and preserve the colony when confidence is low. "
                        "Buy info if ants request it or if it can change the decision. "
                        "Explain each squad briefly in squadVotes. Return only JSON matching the schema."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"stage": stage, "game": context}, ensure_ascii=False, separators=(",", ":")),
                },
            ],
        }
        return payload

    def _ant_payload(self, *, stage: str, context: dict[str, Any], ants: list[dict[str, Any]]) -> dict[str, Any]:
        vote_values = _vote_values_from_context(context)
        if len(ants) == 1:
            max_tokens = min(self.settings.max_tokens, 96)
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": "single_ant_agent_decision",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "antId": {"type": "string"},
                            "vote": {"type": "string", "enum": vote_values},
                        },
                        "required": ["antId", "vote"],
                    },
                },
            }
        else:
            max_tokens = max(128, min(9000, 220 + len(ants) * 70, self.settings.max_tokens))
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": "ant_agent_decisions",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "antDecisions": {
                                "type": "array",
                                "minItems": len(ants),
                                "maxItems": len(ants),
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "antId": {"type": "string"},
                                        "vote": {"type": "string", "enum": vote_values},
                                    },
                                    "required": ["antId", "vote"],
                                },
                            }
                        },
                        "required": ["antDecisions"],
                    },
                },
            }
        return {
            "model": self.settings.model,
            "temperature": 0.35,
            "max_tokens": max_tokens,
            "reasoning": {"effort": "none", "exclude": True},
            "response_format": response_format,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You control individual ants in a football prediction game. "
                        "Each item in ants is an autonomous agent with its own personality and memory. "
                        "Your job is not to guess what the colony wants: each ant follows its own objective "
                        "and decides whether to help the colony now or preserve its strength. "
                        "Do not return a global decision: return exactly one decision per provided antId. "
                        "The only allowed output for each ant is one vote from game.market.availableVotes. "
                        "Do not invent confidence, score, probability, stake or info requests. "
                        "Paid info is disabled for now because paid tools will be added later. "
                        "Use abstain only if you do not want to commit this ant to this market. "
                        "Ants may disagree. JSON only, no explanation."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"stage": stage, "game": context, "ants": ants},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                },
            ],
        }

    def _parse_decision(self, stage: str, data: dict[str, Any], context: dict[str, Any]) -> ColonyAgentDecision:
        parsed = _message_json(data)

        if not isinstance(parsed, dict):
            raise AgentDecisionError(
                "DeepSeek returned a JSON value that is not an object.",
                details=[_assistant_shape_failure_detail(data, parsed)],
            )

        option_ids = {option.get("optionId") for option in context.get("opportunity", {}).get("options", [])}
        action = parsed.get("action") if parsed.get("action") in {"predict", "observe"} else "observe"
        option_id = parsed.get("optionId") if parsed.get("optionId") in option_ids else None
        if action == "predict" and not option_id:
            action = "observe"
        raw = dict(parsed)
        raw["_model"] = data.get("model")
        return ColonyAgentDecision(
            source="openrouter",
            stage=stage,
            action=action,
            buy_info=_as_bool(parsed.get("buyInfo")),
            option_id=option_id,
            stake_fraction=_clamp(_as_float(parsed.get("stakeFraction")), 0.0, 0.8),
            confidence=_clamp(_as_float(parsed.get("confidence")), 0.0, 1.0),
            reason=str(parsed.get("reason") or "").strip()[:180],
            squad_votes=_parse_squad_votes(parsed.get("squadVotes"), option_ids),
            raw=raw,
        )

    def _parse_ant_decisions(
        self,
        data: dict[str, Any],
        ants: list[dict[str, Any]],
        vote_map: dict[str, Any],
    ) -> list[AntAgentDecision]:
        parsed = _message_json(data)
        allowed_ant_ids = {str(ant.get("antId")) for ant in ants}
        decisions: list[AntAgentDecision] = []
        seen: set[str] = set()
        items = _candidate_ant_decision_items(parsed)
        for item in items:
            if not isinstance(item, dict):
                continue
            ant_id = str(item.get("antId") or "")
            if ant_id not in allowed_ant_ids or ant_id in seen:
                continue
            seen.add(ant_id)
            vote = _normalize_vote(item.get("vote"))
            if not vote:
                vote = _vote_from_legacy_decision(item, vote_map)
            option_id = vote_map.get(vote)
            action = "predict" if option_id else "neutral"
            decisions.append(
                AntAgentDecision(
                    ant_id=ant_id,
                    vote=vote,
                    action=action,
                    option_id=option_id,
                    reason=str(item.get("reason") or "").strip()[:90],
                    raw=dict(item),
                )
            )
        return decisions


def _candidate_ant_decision_items(parsed: Any) -> list[Any]:
    if isinstance(parsed, list):
        return parsed
    if not isinstance(parsed, dict):
        return []
    items = parsed.get("antDecisions")
    if isinstance(items, list):
        return items
    if isinstance(parsed.get("antDecision"), dict):
        return [parsed["antDecision"]]
    if parsed.get("antId") and (parsed.get("vote") or parsed.get("action") or parsed.get("choice")):
        return [parsed]
    return []


def _ant_decision_failure_detail(data: dict[str, Any], ants: list[dict[str, Any]]) -> dict[str, Any]:
    expected_ant_ids = [str(ant.get("antId") or "") for ant in ants]
    detail: dict[str, Any] = {
        "category": "missing_ant_decision",
        "expectedAntIds": expected_ant_ids,
        "model": data.get("model"),
    }
    choice = (data.get("choices") or [{}])[0]
    if isinstance(choice, dict):
        if choice.get("finish_reason"):
            detail["finishReason"] = choice.get("finish_reason")
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            detail["contentSnippet"] = _truncate(content, 1600)
        elif content is not None:
            detail["contentSnippet"] = _truncate(json.dumps(content, ensure_ascii=False, separators=(",", ":")), 1600)

    parsed = _message_json(data)
    detail["parsedType"] = type(parsed).__name__
    if isinstance(parsed, dict):
        detail["parsedKeys"] = sorted(str(key) for key in parsed.keys())[:20]
    detail["parsedSnippet"] = _truncate(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), 1600)

    candidates = [item for item in _candidate_ant_decision_items(parsed) if isinstance(item, dict)]
    detail["candidateCount"] = len(candidates)
    if candidates:
        candidate_ant_ids = [str(item.get("antId") or "") for item in candidates]
        detail["candidateAntIds"] = candidate_ant_ids[:20]
        if not any(ant_id in expected_ant_ids for ant_id in candidate_ant_ids):
            detail["rejectionReason"] = "unexpected_ant_id"
    else:
        detail["rejectionReason"] = "no_ant_decision_object"
    return detail


def _assistant_shape_failure_detail(data: dict[str, Any], parsed: Any) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "category": "invalid_assistant_shape",
        "parsedType": type(parsed).__name__,
        "parsedSnippet": _truncate(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), 1600),
        "model": data.get("model"),
    }
    choice = (data.get("choices") or [{}])[0]
    if isinstance(choice, dict) and choice.get("finish_reason"):
        detail["finishReason"] = choice.get("finish_reason")
    return detail


def _parse_squad_votes(value: Any, option_ids: set[Any]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    parsed_votes: list[dict[str, Any]] = []
    for item in value[:5]:
        if not isinstance(item, dict):
            continue
        action = item.get("action") if item.get("action") in {"predict", "info", "observe"} else "observe"
        option_id = item.get("optionId") if item.get("optionId") in option_ids else None
        if action == "predict" and not option_id:
            action = "observe"
        ants = int(_clamp(_as_float(item.get("ants")), 0, 500))
        parsed_votes.append(
            {
                "squad": str(item.get("squad") or "squad").strip()[:32],
                "ants": ants,
                "action": action,
                "optionId": option_id,
                "confidence": round(_clamp(_as_float(item.get("confidence")), 0.0, 1.0), 3),
                "reason": str(item.get("reason") or "").strip()[:80],
            }
        )
    return parsed_votes


def _normalize_call_mode(value: str | None) -> str:
    mode = (value or "per_ant").strip().casefold().replace("-", "_")
    return "batch" if mode == "batch" else "per_ant"


def _vote_map_from_context(context: dict[str, Any]) -> dict[str, Any]:
    market = context.get("market")
    if isinstance(market, dict):
        available_votes = market.get("availableVotes")
        if isinstance(available_votes, list):
            parsed = {
                str(item.get("vote")): item.get("optionId")
                for item in available_votes
                if isinstance(item, dict) and item.get("vote")
            }
            if parsed:
                return parsed
        parsed = {"yes": market.get("yesOptionId"), "no": market.get("noOptionId"), "abstain": None}
        if parsed:
            return parsed

    option_ids = [option.get("optionId") for option in context.get("opportunity", {}).get("options", [])]
    if len(option_ids) <= 2:
        return {
            "yes": option_ids[0] if len(option_ids) >= 1 else None,
            "no": option_ids[1] if len(option_ids) >= 2 else None,
            "abstain": None,
        }
    parsed = {f"option_{chr(97 + index)}": option_id for index, option_id in enumerate(option_ids)}
    parsed["abstain"] = None
    return parsed


def _vote_values_from_context(context: dict[str, Any]) -> list[str]:
    vote_map = _vote_map_from_context(context)
    values = [vote for vote in vote_map if vote and vote != "None"]
    return values or ["yes", "no", "abstain"]


def _normalize_vote(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    vote = value.strip().casefold()
    if vote in {"yes", "oui", "y"}:
        return "yes"
    if vote in {"no", "non", "n"}:
        return "no"
    if vote in {"option_a", "option a", "team_a", "team a"}:
        return "option_a"
    if vote in {"option_b", "option b", "team_b", "team b"}:
        return "option_b"
    if vote in {"option_c", "option c", "none", "no_goal", "no goal"}:
        return "option_c"
    if vote in {"abstain", "abstention", "neutral", "neutre", "skip"}:
        return "abstain"
    if vote == "a":
        return "yes"
    if vote == "b":
        return "no"
    if vote == "c":
        return "abstain"
    return None


def _vote_from_legacy_decision(item: dict[str, Any], vote_map: dict[str, Any]) -> str:
    option_id = item.get("optionId")
    for vote, mapped_option_id in vote_map.items():
        if option_id is not None and option_id == mapped_option_id:
            return vote
    action = item.get("action")
    if action == "neutral":
        return "abstain"
    choice = _normalize_vote(item.get("choice"))
    if choice:
        return choice
    return "abstain"
