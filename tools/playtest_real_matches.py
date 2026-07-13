#!/usr/bin/env python3
"""Run Sugar V0 balance simulations on finalized TXLine match replays.

TXLine supplies the real event timelines. A deterministic local voter replaces
only the paid LLM call; market creation, colony consensus, Sugar reservation,
settlement, and ranking all use the production ``GameHarness``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterable, Iterator


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.game.harness as harness_module  # noqa: E402
from app.game.harness import (  # noqa: E402
    MARKET_RISK_SUGAR,
    GameManager,
    opportunity_options,
    resolved_market_outcome,
    stable_seed,
)
from app.main import _choose_best_source, _fetch_score_sources, _recent_past_fixtures  # noqa: E402
from app.txline import TxLineClient, TxLineSettings, build_timeline  # noqa: E402
from app.txline_validation import find_finalized_score_record  # noqa: E402
from tools.playtest_sugar import (  # noqa: E402
    POLICIES,
    STYLES,
    LocalVoterAgent,
    run_fixture_playtests,
)


DEFAULT_POLICIES = ("uniform", "accuracy_50", "accuracy_60", "accuracy_70", "reward_chaser")
RULE_SETS = ("current", "candidate_simple", "candidate_cadence")
COUNT_KEYS = ("offers", "entries", "wins", "losses", "voids", "sugarDelta")
TEAM_EVENT_CONTEXTS = {"next_goal_team", "next_corner", "next_free_kick", "next_yellow_card"}


class AbstainAgent:
    """Expose every eligible market without occupying a Sugar slot."""

    def decide(self, *, game_id: str, stage: str, context: dict[str, Any]) -> None:
        return None

    def decide_ants(
        self,
        *,
        game_id: str,
        stage: str,
        context: dict[str, Any],
        ants: list[dict[str, Any]],
    ) -> list[dict[str, str]]:
        return [
            {
                "antId": str(ant.get("antId") or ""),
                "vote": "abstain",
                "reason": "Market-catalog audit.",
            }
            for ant in ants
        ]

    def usage_for_game(self, game_id: str) -> dict[str, Any]:
        return {
            "model": "local/catalog",
            "budgetedCalls": 0,
            "apiCalls": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "inputCostUsd": 0.0,
            "outputCostUsd": 0.0,
            "costUsd": 0.0,
            "costComplete": True,
            "missingUsageResponses": 0,
        }


async def fetch_finalized_matches(
    *,
    days: int,
    matches: int,
    scan_limit: int,
    competition_id: int | None,
    search: str | None,
    concurrency: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    settings = TxLineSettings.from_env()
    client = TxLineClient(settings)
    fixtures = await _recent_past_fixtures(
        client,
        days=days,
        limit=scan_limit,
        competition_id=competition_id if competition_id is not None else settings.default_competition_id,
        search=search,
    )
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def inspect(fixture: dict[str, Any]) -> dict[str, Any]:
        fixture_id = fixture.get("fixtureId")
        if fixture_id is None:
            return {"status": "skipped", "reason": "missing_fixture_id", "fixture": fixture}
        try:
            async with semaphore:
                sources = await _fetch_score_sources(client, int(fixture_id))
        except Exception as exc:  # One unavailable fixture must not abort the campaign.
            return {
                "status": "skipped",
                "reason": f"fetch_error:{type(exc).__name__}",
                "fixture": fixture,
            }

        source_name, records = _choose_best_source(sources)
        source_counts = {name: len(items) for name, items in sources.items()}
        finalized_source = next(
            (name for name, items in sources.items() if find_finalized_score_record(items) is not None),
            None,
        )
        if finalized_source is None:
            return {
                "status": "skipped",
                "reason": "not_finalized",
                "fixture": fixture,
                "sourceCounts": source_counts,
            }
        if not records:
            return {
                "status": "skipped",
                "reason": "no_score_records",
                "fixture": fixture,
                "sourceCounts": source_counts,
            }

        timeline = build_timeline(
            records,
            fixture=dict(fixture),
            important_only=False,
            include_possession_changes=True,
            limit=None,
        )
        events = timeline.get("events") if isinstance(timeline.get("events"), list) else []
        if not events:
            return {
                "status": "skipped",
                "reason": "empty_timeline",
                "fixture": fixture,
                "sourceCounts": source_counts,
            }
        return {
            "status": "ready",
            "fixture": dict(fixture),
            "events": events,
            "source": source_name,
            "finalizedSource": finalized_source,
            "sourceCounts": source_counts,
            "rawCount": timeline.get("rawCount"),
            "score": timeline.get("score"),
        }

    inspected = await asyncio.gather(*(inspect(fixture) for fixture in fixtures))
    ready = [item for item in inspected if item.get("status") == "ready"][:matches]
    reasons = Counter(str(item.get("reason")) for item in inspected if item.get("status") != "ready")
    return ready, {
        "fixturesScanned": len(fixtures),
        "readyFound": sum(item.get("status") == "ready" for item in inspected),
        "selected": len(ready),
        "skippedReasons": dict(reasons),
    }


def catalog_markets(match: dict[str, Any], *, seed: int) -> dict[str, Any]:
    fixture = match["fixture"]
    events = [dict(event) for event in match["events"]]
    manager = GameManager(decision_agent=AbstainAgent())
    room = manager.create_room(
        fixture_id=fixture.get("fixtureId"),
        participant1=str(fixture.get("participant1") or "A"),
        participant2=str(fixture.get("participant2") or "B"),
        seed=seed,
        room_kind="admin",
    )
    manager.harness(room.game_id).add_colony("Market catalog", 20, "balanced", "balanced", "medium")
    manager.harness(room.game_id).process_events(events)

    oracle = LocalVoterAgent(
        policy="accuracy_100",
        seed=seed,
        run_index=0,
        events=events,
        participant1=str(fixture.get("participant1") or "A"),
        participant2=str(fixture.get("participant2") or "B"),
    )
    contexts: dict[str, Counter[str]] = defaultdict(Counter)
    minute_buckets: Counter[str] = Counter()
    for log_event in room.log:
        if log_event.kind != "opportunity" or not isinstance(log_event.data, dict):
            continue
        market = log_event.data.get("opportunity")
        if not isinstance(market, dict):
            continue
        market = _agent_market_from_public(market)
        context = str(market.get("context") or "unknown")
        contexts[context]["offers"] += 1
        correct_vote = oracle._correct_vote(market, list(market.get("availableVotes") or []))
        option_id = next(
            (
                str(vote.get("optionId"))
                for vote in market.get("availableVotes") or []
                if vote.get("vote") == correct_vote and vote.get("optionId")
            ),
            None,
        )
        if option_id:
            contexts[context][f"outcome:{option_id}"] += 1
        else:
            contexts[context]["unknown"] += 1
        minute_buckets[_minute_bucket(market.get("minute"))] += 1

    return {
        "offers": sum(counter["offers"] for counter in contexts.values()),
        "contexts": {context: dict(counter) for context, counter in sorted(contexts.items())},
        "minuteBuckets": dict(minute_buckets),
    }


def _agent_market_from_public(market: dict[str, Any]) -> dict[str, Any]:
    options = [item for item in market.get("options") or [] if isinstance(item, dict)]
    vote_names = ["yes", "no"] if len(options) <= 2 else ["option_a", "option_b", "option_c", "option_d"]
    available_votes = [
        {
            "vote": vote_names[index] if index < len(vote_names) else f"option_{index + 1}",
            "optionId": option.get("optionId"),
            "rewardSugar": option.get("rewardSugar"),
        }
        for index, option in enumerate(options)
    ]
    available_votes.append({"vote": "abstain", "optionId": None, "rewardSugar": 0})
    return {
        **market,
        "marketId": market.get("opportunityId"),
        "availableVotes": available_votes,
    }


def _minute_bucket(value: Any) -> str:
    try:
        minute = int(value)
    except (TypeError, ValueError):
        return "unknown"
    if minute <= 30:
        return "00-30"
    if minute <= 60:
        return "31-60"
    if minute <= 75:
        return "61-75"
    return "76-end"


@contextmanager
def use_rule_set(name: str) -> Iterator[None]:
    if name == "current":
        yield
        return
    if name not in {"candidate_simple", "candidate_cadence"}:
        raise ValueError(f"Unknown rule set: {name}")

    original_options = harness_module.opportunity_options
    original_finish = harness_module.GameHarness._finish_open_markets
    original_event_contexts = harness_module.event_contexts
    original_claim = harness_module.GameHarness._claim_opportunity_slot

    def candidate_options(
        context: str,
        participant1: str = "A",
        participant2: str = "B",
        team_label: str | None = None,
    ) -> list[harness_module.OpportunityOption]:
        options = original_options(context, participant1, participant2, team_label)
        if context == "penalties":
            return [replace(option, reward_sugar=4) if option.option_id == "penalty_no_goal" else option for option in options]
        if context == "goal_next_10" and name == "candidate_cadence":
            return [replace(option, reward_sugar=5) if option.option_id == "goal_next_10_yes" else option for option in options]
        if context in TEAM_EVENT_CONTEXTS:
            return [
                replace(option, reward_sugar=2)
                for option in options
                if option.team_scope in {"participant1", "participant2"}
            ]
        return options

    def candidate_finish(self: harness_module.GameHarness) -> None:
        closed = 0
        for prediction in list(self.room.predictions.values()):
            if prediction.resolved:
                continue
            opportunity = self.room.opportunities.get(prediction.opportunity_id)
            if not opportunity:
                continue
            if opportunity.context == "goal_next_10":
                self._apply_settlement(
                    prediction,
                    opportunity,
                    win=prediction.option.target == "no_goal",
                    reason="full_time",
                    outcome=resolved_market_outcome(opportunity, None, reason="full_time"),
                )
            else:
                self._void_prediction(prediction, opportunity, reason="full_time")
            closed += 1
        self.room.opportunities.clear()
        if closed:
            self.room.add_log(
                "markets_closed",
                f"Full time: {closed} open prediction(s) are closed.",
                {"closed": closed, "reason": "full_time"},
            )

    def cadence_event_contexts(event: dict[str, Any]) -> list[str]:
        contexts = original_event_contexts(event)
        if contexts == ["penalties"]:
            action = harness_module._event_token(event.get("action"))
            if action in {"penalty_outcome", "penalty_result", "penalty_shootout_outcome"}:
                return []
            return contexts
        if not contexts:
            return []
        raw_clock = event.get("clockSeconds")
        try:
            clock = int(raw_clock) if raw_clock is not None else int(event.get("minute")) * 60
        except (TypeError, ValueError):
            clock = 0
        secondary_contexts = ("next_goal_team", "next_corner", "next_free_kick", "next_yellow_card")
        secondary = secondary_contexts[(clock // (15 * 60)) % len(secondary_contexts)]
        return ["goal_next_10", secondary]

    def cadence_claim(self: harness_module.GameHarness, opportunity: harness_module.Opportunity) -> bool:
        key = self._opportunity_slot_key(opportunity)
        if self._has_open_slot_prediction(key):
            return False
        raw_clock = opportunity.source_event.get("clockSeconds")
        if raw_clock is None and opportunity.minute is not None:
            raw_clock = int(opportunity.minute) * 60
        try:
            clock = int(raw_clock) if raw_clock is not None else None
        except (TypeError, ValueError):
            clock = None
        if clock is None:
            return original_claim(self, opportunity)

        cadence_key = "penalties" if opportunity.context == "penalties" else key
        cooldown_seconds = 5 * 60 if opportunity.context == "penalties" else 10 * 60 if opportunity.context == "goal_next_10" else 15 * 60
        last_by_key = getattr(self.room, "_playtest_last_market_clock_by_key", None)
        if not isinstance(last_by_key, dict):
            last_by_key = {}
            setattr(self.room, "_playtest_last_market_clock_by_key", last_by_key)
        last_clock = last_by_key.get(cadence_key)
        if last_clock is not None and clock - int(last_clock) < cooldown_seconds:
            return False
        last_by_key[cadence_key] = clock
        return True

    harness_module.opportunity_options = candidate_options
    harness_module.GameHarness._finish_open_markets = candidate_finish
    if name == "candidate_cadence":
        harness_module.event_contexts = cadence_event_contexts
        harness_module.GameHarness._claim_opportunity_slot = cadence_claim
    try:
        yield
    finally:
        harness_module.opportunity_options = original_options
        harness_module.GameHarness._finish_open_markets = original_finish
        harness_module.event_contexts = original_event_contexts
        harness_module.GameHarness._claim_opportunity_slot = original_claim


def simulate_campaign(
    matches: list[dict[str, Any]],
    *,
    rules: Iterable[str],
    policies: Iterable[str],
    runs: int,
    seed: int,
    verbose: bool = True,
) -> dict[str, Any]:
    catalogs = []
    for match in matches:
        fixture_id = match["fixture"].get("fixtureId")
        catalogs.append(catalog_markets(match, seed=stable_seed(seed, fixture_id, "catalog")))

    rule_reports: dict[str, Any] = {}
    for rule_name in rules:
        fixture_reports = []
        with use_rule_set(rule_name):
            rule_catalogs = [
                catalog_markets(
                    match,
                    seed=stable_seed(seed, match["fixture"].get("fixtureId"), rule_name, "catalog"),
                )
                for match in matches
            ]
            for index, match in enumerate(matches, start=1):
                fixture = match["fixture"]
                if verbose:
                    print(
                        f"[{rule_name}] {index}/{len(matches)} "
                        f"{fixture.get('participant1')} - {fixture.get('participant2')}",
                        flush=True,
                    )
                fixture_seed = stable_seed(seed, fixture.get("fixtureId"), rule_name)
                playtest = run_fixture_playtests(
                    fixture=fixture,
                    events=match["events"],
                    policies=policies,
                    runs=runs,
                    seed=fixture_seed,
                )
                fixture_reports.append({**match, "playtest": playtest})
        rule_reports[rule_name] = {
            "aggregate": _aggregate_fixture_reports(fixture_reports, runs=runs),
            "fixtures": [
                _fixture_result_summary(item, rule_catalogs[index], runs=runs)
                for index, item in enumerate(fixture_reports)
            ],
            "marketCatalog": _aggregate_catalogs(rule_catalogs),
        }

    return {
        "matches": len(matches),
        "runsPerMatchPolicy": runs,
        "policies": list(policies),
        "ruleSets": rule_reports,
        "marketCatalog": _aggregate_catalogs(catalogs),
    }


def _aggregate_fixture_reports(fixture_reports: list[dict[str, Any]], *, runs: int) -> dict[str, Any]:
    policy_names = list(fixture_reports[0]["playtest"]["policies"]) if fixture_reports else []
    return {
        policy: _aggregate_policy([item["playtest"]["policies"][policy] for item in fixture_reports], runs=runs)
        for policy in policy_names
    }


def _aggregate_policy(reports: list[dict[str, Any]], *, runs: int) -> dict[str, Any]:
    samples = max(1, len(reports) * runs)
    styles: dict[str, Any] = {}
    for style in STYLES:
        rows = [report["styles"][style] for report in reports]
        totals = {key: sum(float(row.get(key, 0)) for row in rows) for key in COUNT_KEYS}
        entries = totals["entries"]
        resolved = totals["wins"] + totals["losses"]
        reasons: Counter[str] = Counter()
        for row in rows:
            reasons.update(row.get("observeReasons") or {})
        fixture_means = [float(row.get("meanFinalSugar", 0)) for row in rows]
        styles[style] = {
            **{key: int(value) if float(value).is_integer() else value for key, value in totals.items()},
            "entryRate": entries / max(1.0, totals["offers"]),
            "winRate": totals["wins"] / max(1.0, resolved),
            "sugarPerEntry": totals["sugarDelta"] / max(1.0, entries),
            "meanFinalSugar": sum(float(row.get("meanFinalSugar", 0)) * runs for row in rows) / samples,
            "minFixtureMean": min(fixture_means, default=0.0),
            "maxFixtureMean": max(fixture_means, default=0.0),
            "meanFixtureP05": statistics.fmean(float(row.get("p05FinalSugar", 0)) for row in rows) if rows else 0.0,
            "worstFixtureP05": min((float(row.get("p05FinalSugar", 0)) for row in rows), default=0.0),
            "firstShare": sum(float(row.get("firstCredit", 0)) for row in rows) / samples,
            "reserveLimitRate": reasons["reserve_limit"] / max(1.0, totals["offers"]),
            "insufficientSugarRate": reasons["insufficient_sugar"] / max(1.0, totals["offers"]),
            "observeReasons": dict(reasons),
        }

    return {
        "styles": styles,
        "contexts": _aggregate_named_counters(reports, "contexts"),
        "options": _aggregate_named_counters(reports, "options"),
        "invariantFailures": [failure for report in reports for failure in report.get("invariantFailures") or []],
    }


def _aggregate_named_counters(reports: list[dict[str, Any]], section: str) -> dict[str, Any]:
    names = sorted({name for report in reports for name in (report.get(section) or {})})
    result: dict[str, Any] = {}
    for name in names:
        totals = Counter()
        for report in reports:
            row = (report.get(section) or {}).get(name) or {}
            for key in COUNT_KEYS:
                totals[key] += row.get(key, 0)
        entries = float(totals["entries"])
        resolved = float(totals["wins"] + totals["losses"])
        result[name] = {
            **dict(totals),
            "entryRate": entries / max(1.0, float(totals["offers"])),
            "winRate": float(totals["wins"]) / max(1.0, resolved),
            "sugarPerEntry": float(totals["sugarDelta"]) / max(1.0, entries),
        }
    return result


def _fixture_result_summary(item: dict[str, Any], catalog: dict[str, Any], *, runs: int) -> dict[str, Any]:
    policies = item["playtest"]["policies"]
    first_policy = next(iter(policies.values()))
    mixed_offers = first_policy["styles"]["cautious"]["offers"] / runs
    return {
        "fixture": item["fixture"],
        "source": item.get("source"),
        "sourceCounts": item.get("sourceCounts"),
        "events": len(item.get("events") or []),
        "score": item.get("score"),
        "catalogOffers": catalog["offers"],
        "mixedRoomOffers": mixed_offers,
        "catalogContexts": catalog["contexts"],
    }


def _aggregate_catalogs(catalogs: list[dict[str, Any]]) -> dict[str, Any]:
    contexts: dict[str, Counter[str]] = defaultdict(Counter)
    minutes: Counter[str] = Counter()
    for catalog in catalogs:
        minutes.update(catalog.get("minuteBuckets") or {})
        for context, row in (catalog.get("contexts") or {}).items():
            contexts[context].update(row)

    context_rows: dict[str, Any] = {}
    for context, counts in sorted(contexts.items()):
        offers = counts.get("offers", 0)
        outcomes = {
            key.removeprefix("outcome:"): value
            for key, value in counts.items()
            if key.startswith("outcome:")
        }
        known = sum(outcomes.values())
        reward_map = {option.option_id: option.reward_sugar for option in opportunity_options(context, "A", "B")}
        options = {
            option_id: {
                "count": count,
                "rate": count / max(1, known),
                "currentReward": reward_map.get(option_id),
                "netIfAlwaysPicked": (
                    count / max(1, known) * int(reward_map[option_id])
                    - (1 - count / max(1, known)) * MARKET_RISK_SUGAR
                )
                if option_id in reward_map
                else None,
            }
            for option_id, count in sorted(outcomes.items())
        }
        context_rows[context] = {
            "offers": offers,
            "knownOutcomes": known,
            "coverage": known / max(1, offers),
            "unknown": counts.get("unknown", 0),
            "options": options,
        }
    return {
        "offers": sum(catalog.get("offers", 0) for catalog in catalogs),
        "offersPerMatch": statistics.fmean(catalog.get("offers", 0) for catalog in catalogs) if catalogs else 0.0,
        "contexts": context_rows,
        "minuteBuckets": dict(minutes),
    }


def format_report(report: dict[str, Any]) -> str:
    lines = [
        "Sugar V0 real-match playtest",
        f"Fixtures scanned: {report['fetch']['fixturesScanned']}",
        f"Finalized matches simulated: {report['campaign']['matches']}",
        f"Runs per match and policy: {report['campaign']['runsPerMatchPolicy']}",
        f"Policies: {', '.join(report['campaign']['policies'])}",
        "",
        "Current-rule market catalog (one abstaining colony; no Sugar-cap censoring):",
        f"  {report['campaign']['marketCatalog']['offers']} markets total; "
        f"{report['campaign']['marketCatalog']['offersPerMatch']:.1f} per match",
    ]
    for context, row in report["campaign"]["marketCatalog"]["contexts"].items():
        outcomes = ", ".join(
            f"{option_id} {option['rate'] * 100:.1f}%"
            for option_id, option in row["options"].items()
        )
        lines.append(
            f"  {context:<22} {row['offers']:>4} offers  "
            f"known {row['coverage'] * 100:5.1f}%  {outcomes}"
        )

    for rule_name, rule_report in report["campaign"]["ruleSets"].items():
        lines.extend(["", f"Rule set: {rule_name}"])
        lines.append(
            f"  Market cadence without entries: {rule_report['marketCatalog']['offersPerMatch']:.1f} per match"
        )
        for policy, policy_report in rule_report["aggregate"].items():
            lines.append(f"  Policy: {policy}")
            lines.append("    style       entry    final mean   worst fixture p05   first share   Sugar/entry   cap / broke")
            for style in STYLES:
                row = policy_report["styles"][style]
                lines.append(
                    f"    {style:<11} {row['entryRate'] * 100:5.1f}%"
                    f"      {row['meanFinalSugar']:6.2f}"
                    f"          {row['worstFixtureP05']:6.2f}"
                    f"          {row['firstShare'] * 100:5.1f}%"
                    f"         {row['sugarPerEntry']:+.2f}"
                    f"       {row['reserveLimitRate'] * 100:4.1f}% / {row['insufficientSugarRate'] * 100:4.1f}%"
                )
            failures = policy_report.get("invariantFailures") or []
            if failures:
                lines.append(f"    INVARIANT FAILURES: {len(failures)}")

        lines.append("  Matches:")
        for item in rule_report["fixtures"]:
            fixture = item["fixture"]
            score = item.get("score") or {}
            score_text = f"{score.get('participant1', '?')}-{score.get('participant2', '?')}" if isinstance(score, dict) else "?"
            lines.append(
                f"    {fixture.get('fixtureId')} {fixture.get('participant1')} - {fixture.get('participant2')} "
                f"({score_text}), {item['events']} events, "
                f"catalog {item['catalogOffers']} / mixed room {item['mixedRoomOffers']:.1f} markets"
            )

    lines.extend(
        [
            "",
            "Interpretation limits:",
            "  Real timelines validate event cadence and settlement exposure, not LLM prediction skill.",
            "  Seeds vary ant signals; football probability confidence comes from unique fixtures only.",
            "  candidate_simple is simulated in memory: A/B only (+2/+2), no-event void, penalty +1/+4.",
            "  candidate_cadence also limits arrivals by match clock, opens two contexts, and uses goal-next-10 +5/+1.",
        ]
    )
    return "\n".join(lines)


def _parse_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--matches", type=int, default=10)
    parser.add_argument("--scan-limit", type=int, default=40)
    parser.add_argument("--runs", type=int, default=40, help="Seeds per match, policy and rule set.")
    parser.add_argument("--seed", type=int, default=20260713)
    parser.add_argument("--competition-id", type=int)
    parser.add_argument("--search")
    parser.add_argument("--fetch-concurrency", type=int, default=6)
    parser.add_argument("--policies", default=",".join(DEFAULT_POLICIES))
    parser.add_argument("--rule-sets", default=",".join(RULE_SETS))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    policies = _parse_csv(args.policies)
    rules = _parse_csv(args.rule_sets)
    unknown_policies = [policy for policy in policies if policy not in POLICIES]
    unknown_rules = [rule for rule in rules if rule not in RULE_SETS]
    if unknown_policies:
        parser.error(f"unknown policies: {', '.join(unknown_policies)}")
    if unknown_rules:
        parser.error(f"unknown rule sets: {', '.join(unknown_rules)}")
    if args.matches <= 0 or args.runs <= 0 or args.scan_limit <= 0:
        parser.error("matches, runs and scan-limit must be positive")

    matches, fetch_summary = asyncio.run(
        fetch_finalized_matches(
            days=args.days,
            matches=args.matches,
            scan_limit=max(args.scan_limit, args.matches),
            competition_id=args.competition_id,
            search=args.search,
            concurrency=args.fetch_concurrency,
        )
    )
    if not matches:
        raise SystemExit(f"No finalized TXLine replay found: {json.dumps(fetch_summary, sort_keys=True)}")
    if not args.json:
        print(
            f"Fetched {len(matches)} finalized matches from {fetch_summary['fixturesScanned']} fixtures.",
            flush=True,
        )
    campaign = simulate_campaign(
        matches,
        rules=rules,
        policies=policies,
        runs=args.runs,
        seed=args.seed,
        verbose=not args.json,
    )
    report = {"fetch": fetch_summary, "campaign": campaign}
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else format_report(report))


if __name__ == "__main__":
    main()
