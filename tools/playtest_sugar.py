#!/usr/bin/env python3
"""Reproducible Sugar V0 playtests using the real game harness.

The local voter is intentionally synthetic: it replaces only the external
LLM call. Market creation, consensus gates, collateral, settlement and final
ranking all run through the production ``GameHarness``.

The bundled demo is one fixed match, so this tool is an integration and
sensitivity test, not evidence of real football probabilities.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.game.demo import DEMO_FIXTURE, demo_events  # noqa: E402
from app.game.harness import (  # noqa: E402
    MARKET_RISK_SUGAR,
    STARTING_COLONY_SUGAR,
    STYLE_ENTRY_THRESHOLDS,
    GameManager,
    event_targets,
    generate_ants,
    opportunity_options,
    stable_seed,
    truthy,
)


STYLES = ("cautious", "balanced", "aggressive")
POLICIES = {
    "uniform": None,
    "accuracy_50": 0.50,
    "accuracy_60": 0.60,
    "accuracy_70": 0.70,
    "accuracy_100": 1.00,
    "reward_chaser": None,
}
POLICY_DESCRIPTIONS = {
    "uniform": "Each ant chooses an outcome uniformly; there is no abstention.",
    "accuracy_50": "Each ant individually receives the correct outcome with 50% probability.",
    "accuracy_60": "Each ant individually receives the correct outcome with 60% probability.",
    "accuracy_70": "Each ant individually receives the correct outcome with 70% probability.",
    "accuracy_100": "Every ant receives the correct outcome; this exposes the observed outcome mix.",
    "reward_chaser": "Each ant chooses among the highest displayed Sugar rewards.",
}
REWARD_CONTEXTS = (
    "penalties",
    "next_goal_team",
    "next_corner",
    "next_card",
    "next_substitution",
)


class LocalVoterAgent:
    """A deterministic local replacement for ``decide_ants``."""

    def __init__(
        self,
        *,
        policy: str,
        seed: int,
        run_index: int,
        events: list[dict[str, Any]],
        participant1: str | None = None,
        participant2: str | None = None,
    ) -> None:
        if policy not in POLICIES:
            raise ValueError(f"Unknown policy: {policy}")
        self.policy = policy
        self.seed = seed
        self.run_index = run_index
        self.events = events
        self.participant1 = participant1 or str(DEMO_FIXTURE["participant1"])
        self.participant2 = participant2 or str(DEMO_FIXTURE["participant2"])

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
        market = context.get("market") if isinstance(context.get("market"), dict) else {}
        colony = context.get("colony") if isinstance(context.get("colony"), dict) else {}
        votes = [item for item in market.get("availableVotes", []) if item.get("vote") != "abstain"]
        if not votes:
            return [{"antId": str(ant["antId"]), "vote": "abstain", "reason": "No market option."} for ant in ants]

        correct_vote = self._correct_vote(market, votes)
        decisions: list[dict[str, str]] = []
        for ant in ants:
            ant_id = str(ant.get("antId") or "")
            policy_seed = "accuracy" if self.policy.startswith("accuracy_") else self.policy
            rng = random.Random(
                stable_seed(
                    self.seed,
                    self.run_index,
                    policy_seed,
                    colony.get("name"),
                    market.get("marketId"),
                    stage,
                    ant_id,
                )
            )
            chosen = self._choose_vote(votes, correct_vote, rng)
            decisions.append(
                {
                    "antId": ant_id,
                    "vote": str(chosen["vote"]),
                    "reason": f"Local {self.policy} playtest vote.",
                }
            )
        return decisions

    def usage_for_game(self, game_id: str) -> dict[str, Any]:
        return {
            "model": "local/playtest",
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

    def _choose_vote(
        self,
        votes: list[dict[str, Any]],
        correct_vote: str | None,
        rng: random.Random,
    ) -> dict[str, Any]:
        if self.policy == "uniform":
            return rng.choice(votes)
        if self.policy == "reward_chaser":
            best_reward = max(int(item.get("rewardSugar") or 0) for item in votes)
            return rng.choice([item for item in votes if int(item.get("rewardSugar") or 0) == best_reward])

        accuracy = float(POLICIES[self.policy] or 0.0)
        correct = next((item for item in votes if item.get("vote") == correct_vote), None)
        if correct and rng.random() < accuracy:
            return correct
        alternatives = [item for item in votes if not correct or item.get("vote") != correct.get("vote")]
        return rng.choice(alternatives or votes)

    def _correct_vote(self, market: dict[str, Any], votes: list[dict[str, Any]]) -> str | None:
        context = str(market.get("context") or "")
        minute = _as_int(market.get("minute"), 0)
        created_event_index = _market_event_index(market)
        if 1 <= created_event_index <= len(self.events):
            source_event = self.events[created_event_index - 1]
            future = self.events[created_event_index:]
        else:
            source_position = next(
                (index for index, event in enumerate(self.events) if _as_int(event.get("minute"), -1) == minute),
                -1,
            )
            source_event = self.events[source_position] if source_position >= 0 else {}
            future = self.events[source_position + 1 :] if source_position >= 0 else list(self.events)
        future = [
            event
            for event in future
            if event.get("confirmed") is None or truthy(event.get("confirmed"))
        ]
        source_clock = _as_int(source_event.get("clockSeconds"), minute * 60)

        option_id: str | None = None
        if context == "goal_next_10":
            goal = next(
                (
                    event
                    for event in future
                    if "goal" in event_targets(event)
                    and _as_int(event.get("clockSeconds"), 0) < source_clock + 10 * 60
                ),
                None,
            )
            option_id = "goal_next_10_yes" if goal else "goal_next_10_no"
        elif context == "penalties":
            team_label = str(market.get("teamLabel") or "")
            result = None
            for event in future:
                if event.get("confirmed") is not None and not truthy(event.get("confirmed")):
                    continue
                targets = event_targets(event)
                if not targets.intersection({"goal", "miss", "saved", "cancel"}):
                    continue
                if team_label and _event_team(event) != team_label:
                    continue
                result = event
                break
            if result and "cancel" not in event_targets(result):
                option_id = "penalty_goal" if "goal" in event_targets(result) else "penalty_no_goal"
        else:
            target_by_context = {
                "next_goal_team": "goal",
                "next_corner": "corner",
                "next_card": "card",
                "next_substitution": "substitution",
                "next_free_kick": "free_kick",
                "next_yellow_card": "yellow_card",
                "next_foul": "foul",
            }
            target = target_by_context.get(context)
            result = next((event for event in future if target and target in event_targets(event)), None)
            prefix_by_context = {
                "next_goal_team": "next_goal",
                "next_corner": "next_corner",
                "next_card": "next_card",
                "next_substitution": "next_substitution",
                "next_free_kick": "next_free_kick",
                "next_yellow_card": "next_yellow_card",
                "next_foul": "next_foul",
            }
            prefix = prefix_by_context.get(context)
            if prefix and result:
                team = _event_team(result)
                if team == self.participant1:
                    option_id = f"{prefix}_p1"
                elif team == self.participant2:
                    option_id = f"{prefix}_p2"
            elif prefix and context != "next_foul":
                option_id = f"{prefix}_none"

        return next((str(item["vote"]) for item in votes if item.get("optionId") == option_id), None)


def _event_team(event: dict[str, Any]) -> str:
    return str(event.get("participantLabel") or event.get("possessionLabel") or "")


def _market_event_index(market: dict[str, Any]) -> int:
    context = str(market.get("context") or "")
    market_id = str(market.get("marketId") or "")
    if context and market_id.endswith(f"_{context}"):
        market_id = market_id[: -len(context)].rstrip("_")
    return _as_int(market_id.rsplit("_", 1)[-1], 0)


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def reward_audit() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for context in REWARD_CONTEXTS:
        options = opportunity_options(
            context,
            str(DEMO_FIXTURE["participant1"]),
            str(DEMO_FIXTURE["participant2"]),
        )
        break_even = [MARKET_RISK_SUGAR / (option.reward_sugar + MARKET_RISK_SUGAR) for option in options]
        total = sum(break_even)
        rows.append(
            {
                "context": context,
                "rewards": [option.reward_sugar for option in options],
                "breakEven": break_even,
                "breakEvenSum": total,
                "status": "coherent" if math.isclose(total, 1.0, abs_tol=0.01) else "generous" if total < 1.0 else "punitive",
                "openedByCurrentV0": context != "next_foul",
            }
        )
    return rows


def run_playtests(*, policies: Iterable[str], runs: int, seed: int = 7) -> dict[str, Any]:
    return run_fixture_playtests(
        fixture=dict(DEMO_FIXTURE),
        events=demo_events(DEMO_FIXTURE["fixtureId"]),
        policies=policies,
        runs=runs,
        seed=seed,
    )


def run_fixture_playtests(
    *,
    fixture: dict[str, Any],
    events: Iterable[dict[str, Any]],
    policies: Iterable[str],
    runs: int,
    seed: int = 7,
) -> dict[str, Any]:
    if runs <= 0:
        raise ValueError("runs must be positive")
    clean_policies = list(policies)
    replay_events = list(events)
    unknown = [policy for policy in clean_policies if policy not in POLICIES]
    if unknown:
        raise ValueError(f"Unknown policies: {', '.join(unknown)}")
    return {
        "fixture": dict(fixture),
        "runsPerPolicy": runs,
        "seed": seed,
        "rewardAudit": reward_audit(),
        "policies": {
            policy: _run_policy(
                policy=policy,
                runs=runs,
                seed=seed,
                fixture=fixture,
                source_events=replay_events,
            )
            for policy in clean_policies
        },
    }


def _run_policy(
    *,
    policy: str,
    runs: int,
    seed: int,
    fixture: dict[str, Any] | None = None,
    source_events: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    fixture = dict(fixture or DEMO_FIXTURE)
    fixture_id = fixture.get("fixtureId")
    participant1 = str(fixture.get("participant1") or "A")
    participant2 = str(fixture.get("participant2") or "B")
    replay_events = list(source_events) if source_events is not None else demo_events(DEMO_FIXTURE["fixtureId"])
    style_totals: dict[str, dict[str, Any]] = {
        style: {
            "offers": 0,
            "entries": 0,
            "wins": 0,
            "losses": 0,
            "voids": 0,
            "sugarDelta": 0,
            "firstCredit": 0.0,
            "finalSugar": [],
            "observeReasons": Counter(),
        }
        for style in STYLES
    }
    context_totals: dict[str, Counter[str]] = defaultdict(Counter)
    option_totals: dict[str, Counter[str]] = defaultdict(Counter)
    style_context_totals: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    style_option_totals: dict[tuple[str, str, str], Counter[str]] = defaultdict(Counter)
    invariant_failures: list[str] = []

    for run_index in range(runs):
        events = [dict(event) for event in replay_events]
        agent = LocalVoterAgent(
            policy=policy,
            seed=seed,
            run_index=run_index,
            events=events,
            participant1=participant1,
            participant2=participant2,
        )
        manager = GameManager(decision_agent=agent)
        room = manager.create_room(
            fixture_id=fixture_id,
            participant1=participant1,
            participant2=participant2,
            seed=seed + run_index,
        )
        harness = manager.harness(room.game_id)
        rotated = list(STYLES[run_index % len(STYLES) :] + STYLES[: run_index % len(STYLES)])
        for style in rotated:
            colony = harness.add_colony(
                name=f"{style}-{run_index}",
                size=20,
                style=style,
                favorite_context="balanced",
                info_need="medium",
            )
            colony.seed = stable_seed(seed, run_index, style)
            colony.ants = generate_ants(colony)

        harness.process_events(events)
        colony_styles = {colony.colony_id: colony.style for colony in room.colonies.values()}
        opportunity_context: dict[str, str] = {}
        opportunity_option_ids: dict[str, list[str]] = {}
        opportunity_count = Counter()
        for event in room.log:
            data = event.data if isinstance(event.data, dict) else {}
            if event.kind == "opportunity":
                market = data.get("opportunity") if isinstance(data.get("opportunity"), dict) else {}
                opportunity_id = str(market.get("opportunityId") or "")
                context = str(market.get("context") or "unknown")
                if opportunity_id:
                    opportunity_context[opportunity_id] = context
                    opportunity_option_ids[opportunity_id] = [
                        str(option.get("optionId") or option.get("option_id"))
                        for option in market.get("options", [])
                        if isinstance(option, dict) and (option.get("optionId") or option.get("option_id"))
                    ]
                    opportunity_count[context] += 1

        offered = sum(opportunity_count.values())
        for style in STYLES:
            style_totals[style]["offers"] += offered
        for context, count in opportunity_count.items():
            context_totals[context]["offers"] += count * len(STYLES)
            for style in STYLES:
                style_context_totals[(style, context)]["offers"] += count
        for opportunity_id, option_ids in opportunity_option_ids.items():
            context = opportunity_context[opportunity_id]
            for option_id in option_ids:
                option_totals[f"{context}:{option_id}"]["offers"] += len(STYLES)
                for style in STYLES:
                    style_option_totals[(style, context, option_id)]["offers"] += 1

        for event in room.log:
            data = event.data if isinstance(event.data, dict) else {}
            colony_id = str(data.get("colonyId") or "")
            style = colony_styles.get(colony_id)
            opportunity_id = str(data.get("opportunityId") or "")
            context = opportunity_context.get(opportunity_id, "unknown")
            if not style:
                continue
            if event.kind == "prediction":
                option = data.get("option") if isinstance(data.get("option"), dict) else {}
                option_id = str(option.get("optionId") or option.get("option_id") or "unknown")
                style_totals[style]["entries"] += 1
                context_totals[context]["entries"] += 1
                style_context_totals[(style, context)]["entries"] += 1
                option_totals[f"{context}:{option_id}"]["entries"] += 1
                style_option_totals[(style, context, option_id)]["entries"] += 1
            elif event.kind == "observe":
                style_totals[style]["observeReasons"][str(data.get("reason") or "unknown")] += 1
            elif event.kind == "settlement":
                delta = _as_int(data.get("sugarDelta", data.get("sugar")), 0)
                won = bool(data.get("win"))
                option = data.get("option") if isinstance(data.get("option"), dict) else {}
                option_id = str(option.get("optionId") or option.get("option_id") or "unknown")
                style_totals[style]["wins" if won else "losses"] += 1
                style_totals[style]["sugarDelta"] += delta
                context_totals[context]["wins" if won else "losses"] += 1
                context_totals[context]["sugarDelta"] += delta
                style_context_totals[(style, context)]["wins" if won else "losses"] += 1
                style_context_totals[(style, context)]["sugarDelta"] += delta
                option_totals[f"{context}:{option_id}"]["wins" if won else "losses"] += 1
                option_totals[f"{context}:{option_id}"]["sugarDelta"] += delta
                style_option_totals[(style, context, option_id)]["wins" if won else "losses"] += 1
                style_option_totals[(style, context, option_id)]["sugarDelta"] += delta
            elif event.kind == "void":
                option = data.get("option") if isinstance(data.get("option"), dict) else {}
                option_id = str(option.get("optionId") or option.get("option_id") or "unknown")
                style_totals[style]["voids"] += 1
                context_totals[context]["voids"] += 1
                style_context_totals[(style, context)]["voids"] += 1
                option_totals[f"{context}:{option_id}"]["voids"] += 1
                style_option_totals[(style, context, option_id)]["voids"] += 1

        final_sugar = {colony.style: colony.food for colony in room.colonies.values()}
        best = max(final_sugar.values())
        leaders = [style for style, sugar in final_sugar.items() if sugar == best]
        for style in STYLES:
            colony = next(colony for colony in room.colonies.values() if colony.style == style)
            style_totals[style]["finalSugar"].append(colony.food)
            if style in leaders:
                style_totals[style]["firstCredit"] += 1 / len(leaders)
            if colony.food < 0:
                invariant_failures.append(f"run {run_index} {style}: negative Sugar")
            if colony.food_reserved != 0:
                invariant_failures.append(f"run {run_index} {style}: {colony.food_reserved} Sugar still reserved")
            if colony.public_state(room.event_index)["score"] != colony.food:
                invariant_failures.append(f"run {run_index} {style}: score differs from Sugar")

    styles = {}
    for style, totals in style_totals.items():
        final_values = list(totals.pop("finalSugar"))
        reasons = dict(totals.pop("observeReasons"))
        entries = int(totals["entries"])
        resolved = int(totals["wins"] + totals["losses"])
        styles[style] = {
            **totals,
            "entryRate": entries / max(1, int(totals["offers"])),
            "winRate": int(totals["wins"]) / max(1, resolved),
            "sugarPerEntry": int(totals["sugarDelta"]) / max(1, entries),
            "meanFinalSugar": statistics.fmean(final_values),
            "p05FinalSugar": _percentile(final_values, 0.05),
            "medianFinalSugar": statistics.median(final_values),
            "p95FinalSugar": _percentile(final_values, 0.95),
            "firstShare": float(totals["firstCredit"]) / runs,
            "observeReasons": reasons,
        }

    contexts = {
        context: _finalize_counter(counter)
        for context, counter in sorted(context_totals.items())
    }
    options = {
        option: _finalize_counter(counter)
        for option, counter in sorted(option_totals.items())
    }
    style_contexts = {
        style: {
            context: _finalize_counter(style_context_totals[(style, context)])
            for context in sorted({key_context for key_style, key_context in style_context_totals if key_style == style})
        }
        for style in STYLES
    }
    style_options = {
        style: {
            f"{context}:{option_id}": _finalize_counter(style_option_totals[(style, context, option_id)])
            for key_style, context, option_id in sorted(style_option_totals)
            if key_style == style
        }
        for style in STYLES
    }
    return {
        "styles": styles,
        "contexts": contexts,
        "options": options,
        "styleContexts": style_contexts,
        "styleOptions": style_options,
        "invariantFailures": invariant_failures,
    }


def _finalize_counter(counter: Counter[str]) -> dict[str, Any]:
    values = dict(counter)
    entries = int(values.get("entries", 0))
    resolved = int(values.get("wins", 0) + values.get("losses", 0))
    return {
        **values,
        "entryRate": entries / max(1, int(values.get("offers", entries))),
        "winRate": int(values.get("wins", 0)) / max(1, resolved),
        "sugarPerEntry": int(values.get("sugarDelta", 0)) / max(1, entries),
    }


def _percentile(values: list[int], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return float(ordered[low])
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def format_report(report: dict[str, Any]) -> str:
    lines = [
        "Sugar V0 local playtest",
        f"Fixture: {report['fixture']['participant1']} vs {report['fixture']['participant2']}",
        f"Runs per policy: {report['runsPerPolicy']}",
        "",
        "Reward audit (sum of break-even probabilities; 100% is coherent):",
    ]
    for row in report["rewardAudit"]:
        rewards = "/".join(f"+{value}" for value in row["rewards"])
        availability = "" if row["openedByCurrentV0"] else " (not currently opened)"
        lines.append(
            f"  {row['context']:<22} {rewards:<10} {row['breakEvenSum'] * 100:6.1f}%  "
            f"{row['status']}{availability}"
        )

    for policy, result in report["policies"].items():
        lines.extend(
            [
                "",
                f"Policy: {policy}",
                f"  {POLICY_DESCRIPTIONS[policy]}",
                "  style       entry    final mean   p05 / p50 / p95   first share   Sugar/entry",
            ]
        )
        for style in STYLES:
            row = result["styles"][style]
            lines.append(
                f"  {style:<11} {row['entryRate'] * 100:5.1f}%"
                f"      {row['meanFinalSugar']:6.2f}"
                f"      {row['p05FinalSugar']:4.1f} / {row['medianFinalSugar']:4.1f} / {row['p95FinalSugar']:4.1f}"
                f"       {row['firstShare'] * 100:5.1f}%"
                f"         {row['sugarPerEntry']:+.2f}"
            )
        lines.append("  context                entry    win rate   Sugar/entry")
        for context, row in result["contexts"].items():
            lines.append(
                f"  {context:<22} {row['entryRate'] * 100:5.1f}%"
                f"      {row['winRate'] * 100:5.1f}%"
                f"         {row['sugarPerEntry']:+.2f}"
            )
        if result["invariantFailures"]:
            lines.append(f"  INVARIANT FAILURES: {len(result['invariantFailures'])}")
    lines.extend(
        [
            "",
            "Caution: this is one fixed demo timeline. Use the sensitivity gap between policies/styles;",
            "do not treat its market win rates as real football probabilities. Accuracy policies describe",
            "individual ant signals; the 20-ant vote can amplify them into much higher colony accuracy.",
            "The local policy intentionally ignores ant personalities, so style gaps isolate entry thresholds.",
        ]
    )
    return "\n".join(lines)


def _parse_policies(raw: str) -> list[str]:
    if raw == "all":
        return list(POLICIES)
    return [item.strip() for item in raw.split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=100, help="Replays per policy (default: 100).")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--policies", default="all", help="Comma-separated policy names or 'all'.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()
    report = run_playtests(policies=_parse_policies(args.policies), runs=args.runs, seed=args.seed)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else format_report(report))


if __name__ == "__main__":
    main()
