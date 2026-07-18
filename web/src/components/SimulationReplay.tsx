"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColonyRaceChart } from "@/components/ColonyRaceChart";
import { flag, fmtClockSeconds } from "@/lib/format";
import { colonySugar } from "@/lib/sugar";
import type { Colony, GameEvent, GameState, MatchScore, Opportunity, OpportunityOption } from "@/lib/types";

interface ReplayPoint {
  event: GameEvent;
  offset: number;
}

interface ReplayEventCard {
  code: string;
  title: string;
  detail: string;
  tone: "match" | "market" | "colony" | "result" | "system";
}

type ReplayFeedView = "bets" | "all";
type ReplayBetStatus = "open" | "won" | "lost" | "void";

interface ReplayBetEntry {
  predictionId: string;
  colonyName: string;
  optionLabel: string;
  status: ReplayBetStatus;
  sugarAtRisk: number;
  sugarDelta: number | null;
  eventIndex: number;
  resultEventIndex?: number;
}

interface ReplayBetMarket {
  id: string;
  label: string;
  minute: number | null;
  lastEventIndex: number;
  bets: ReplayBetEntry[];
}

export function SimulationReplay({
  game,
  events,
}: {
  game: GameState;
  events: GameEvent[];
}) {
  const timeline = useMemo(() => buildReplayTimeline(events), [events]);
  const duration = timeline.at(-1)?.offset ?? 0;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  const [feedView, setFeedView] = useState<ReplayFeedView>("bets");
  const positionRef = useRef(0);
  const replayKey = `${game.gameId}:${timeline[0]?.event.index ?? 0}:${timeline.at(-1)?.event.index ?? 0}`;

  useEffect(() => {
    positionRef.current = 0;
    const resetFrame = window.requestAnimationFrame(() => {
      setPosition(0);
      setPlaying(false);
    });
    return () => window.cancelAnimationFrame(resetFrame);
  }, [replayKey]);

  useEffect(() => {
    if (!playing || duration <= 0) return;
    let frame = 0;
    let previousFrame: number | null = null;

    const tick = (now: number) => {
      if (previousFrame == null) previousFrame = now;
      const elapsed = Math.max(0, now - previousFrame) / 1000 * speed;
      previousFrame = now;
      const next = Math.min(duration, positionRef.current + elapsed);
      positionRef.current = next;
      setPosition(next);
      if (next >= duration) {
        setPlaying(false);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, playing, speed]);

  const visiblePoints = useMemo(
    () => timeline.filter((point) => point.offset <= position + 0.02),
    [position, timeline],
  );
  const visibleEvents = useMemo(() => visiblePoints.map((point) => point.event), [visiblePoints]);
  const replayColonies = useMemo(
    () => coloniesAtCursor(game.colonies, timeline.map((point) => point.event), visibleEvents),
    [game.colonies, timeline, visibleEvents],
  );
  const allBetMarkets = useMemo(
    () => buildReplayBetMarkets(timeline.map((point) => point.event), game.colonies),
    [game.colonies, timeline],
  );
  const visibleBetMarkets = useMemo(
    () => buildReplayBetMarkets(visibleEvents, game.colonies),
    [game.colonies, visibleEvents],
  );
  const currentScore = latestScore(visibleEvents);
  const matchClock = latestMatchClock(visibleEvents);
  const recentPoints = visiblePoints.slice(-7).reverse();
  const progress = duration > 0 ? Math.round(position / duration * 100) : 0;
  const totalBetCount = allBetMarkets.reduce((total, market) => total + market.bets.length, 0);
  const visibleBetCount = visibleBetMarkets.reduce((total, market) => total + market.bets.length, 0);

  function seek(next: number) {
    const bounded = Math.max(0, Math.min(duration, next));
    positionRef.current = bounded;
    setPosition(bounded);
  }

  function togglePlayback() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (positionRef.current >= duration) seek(0);
    setPlaying(true);
  }

  if (!timeline.length) return null;

  return (
    <section className="glass p-4" aria-label="Complete simulation replay">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Simulation replay</p>
          <h2 className="text-xl font-bold">Review the completed run</h2>
        </div>
        <span className="status-pill">
          {playing ? `Playing ×${speed}` : position >= duration ? "Replay complete" : `Ready · ×${speed}`}
        </span>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary !min-h-0 !w-auto px-4 py-2" onClick={togglePlayback}>
          <span aria-hidden="true">{playing ? "Ⅱ" : position >= duration ? "↺" : "▶"}</span>{" "}
          {playing ? "Pause" : position >= duration ? "Replay" : "Play"}
        </button>
        {([1, 2, 4] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`btn !min-h-0 !w-auto px-3 py-2 ${speed === value ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={speed === value}
            onClick={() => setSpeed(value)}
          >
            ×{value}
          </button>
        ))}
        <label className="min-w-[180px] flex-1">
          <span className="sr-only">Replay position</span>
          <input
            className="w-full accent-gold-deep"
            type="range"
            min={0}
            max={Math.max(0.1, duration)}
            step={0.05}
            value={Math.min(position, Math.max(0.1, duration))}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </label>
        <span className="font-mono text-xs text-ink-faint">
          {formatReplayDuration(position)} / {formatReplayDuration(duration)}
        </span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,.75fr)]">
        <div className="well p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold">
              {flag(game.participant1)} {game.participant1 || "Team 1"}{" "}
              {currentScore.participant1 ?? 0} – {currentScore.participant2 ?? 0}{" "}
              {game.participant2 || "Team 2"} {flag(game.participant2)}
            </span>
            <span className="font-mono text-sm font-bold">{fmtClockSeconds(matchClock)}</span>
          </div>
          <ColonyRaceChart colonies={replayColonies} events={visibleEvents} hero />
        </div>

        <aside className="well min-h-0 p-3" aria-label="Events reached in the replay">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="eyebrow">{feedView === "bets" ? "Colony bets" : "Replay feed"}</p>
              <strong className="text-sm">
                {feedView === "bets"
                  ? `${visibleBetCount} / ${totalBetCount} bets`
                  : `${visiblePoints.length} / ${timeline.length} actions`}
              </strong>
            </div>
            <span className="status-pill">{progress}%</span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Replay feed filter">
            <button
              type="button"
              className={`btn !min-h-11 py-2 text-xs ${feedView === "bets" ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={feedView === "bets"}
              onClick={() => setFeedView("bets")}
            >
              Bets · {totalBetCount}
            </button>
            <button
              type="button"
              className={`btn !min-h-11 py-2 text-xs ${feedView === "all" ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={feedView === "all"}
              onClick={() => setFeedView("all")}
            >
              All events
            </button>
          </div>

          {feedView === "bets" ? (
            <ol className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1" aria-label="Colony bets reached in the replay">
              {visibleBetMarkets.map((market) => (
                <li key={market.id} className="rounded-md border-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.64)] p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <small className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                        {market.minute != null ? `${Math.floor(market.minute)}'` : "Live"} · #{market.lastEventIndex}
                      </small>
                      <b className="block text-sm leading-snug">{market.label}</b>
                    </div>
                    <span className="status-pill shrink-0">
                      {market.bets.length} bet{market.bets.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {market.bets.map((bet) => (
                      <li
                        key={bet.predictionId}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-[color:var(--brd-soft)] pt-1.5"
                      >
                        <span className={`status-pill ${replayBetStatusTone(bet.status)}`}>
                          {replayBetStatusLabel(bet.status)}
                        </span>
                        <div className="min-w-0">
                          <b className="block truncate text-xs">{bet.colonyName}</b>
                          <p className="truncate text-[11px] text-ink-faint">Picked: {bet.optionLabel}</p>
                        </div>
                        <span className={`font-mono text-[11px] font-bold ${replayBetSugarTone(bet)}`}>
                          {replayBetSugarLabel(bet)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {!visibleBetMarkets.length && (
                <li className="py-6 text-center">
                  <b className="block text-sm">No colony bet at this point</b>
                  <p className="mt-1 text-xs text-ink-faint">
                    Press play to reveal each market, pick and result.
                  </p>
                </li>
              )}
            </ol>
          ) : (
            <ol className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {recentPoints.map((point) => {
                const card = replayEventCard(point.event);
                return (
                  <li key={point.event.index} className="flex gap-2 border-b border-[color:var(--brd-soft)] pb-2">
                    <span className="status-pill shrink-0">{card.code}</span>
                    <div className="min-w-0">
                      <small className="font-mono text-[10px] text-ink-faint">
                        {formatReplayDuration(point.offset)} · #{point.event.index}
                      </small>
                      <b className="block truncate text-sm">{card.title}</b>
                      <p className="truncate text-xs text-ink-faint">{card.detail}</p>
                    </div>
                  </li>
                );
              })}
              {!recentPoints.length && (
                <li className="py-6 text-center">
                  <b className="block text-sm">Press play to review the simulation</b>
                  <p className="mt-1 text-xs text-ink-faint">
                    Match events, markets, colony votes and results will appear here.
                  </p>
                </li>
              )}
            </ol>
          )}
        </aside>
      </div>
    </section>
  );
}

function buildReplayTimeline(events: GameEvent[]): ReplayPoint[] {
  const ordered = [...events].sort((left, right) => left.index - right.index);
  const startedAt = ordered.findIndex((event) => event.kind === "game_started");
  const segmentStart = startedAt >= 0 ? startedAt : 0;
  const finishedAt = ordered.findIndex((event, index) => index >= segmentStart && event.kind === "game_finished");
  const segment = ordered.slice(segmentStart, finishedAt >= 0 ? finishedAt + 1 : undefined);
  const firstTimestamp = segment.find((event) => finiteTimestamp(event.createdAt) != null)?.createdAt;
  const baseTimestamp = finiteTimestamp(firstTimestamp);
  let previousOffset = 0;

  return segment.map((event, index) => {
    const timestamp = finiteTimestamp(event.createdAt);
    const timestampOffset = baseTimestamp != null && timestamp != null ? timestamp - baseTimestamp : null;
    const offset = index === 0
      ? 0
      : Math.max(previousOffset + (timestampOffset == null ? 0.05 : 0), timestampOffset ?? previousOffset + 0.05);
    previousOffset = offset;
    return { event, offset };
  });
}

function coloniesAtCursor(
  finalColonies: Colony[],
  allEvents: GameEvent[],
  visibleEvents: GameEvent[],
): Colony[] {
  const allDeltas = settlementDeltas(allEvents);
  const visibleDeltas = settlementDeltas(visibleEvents);

  return finalColonies.map((colony) => {
    const finalSugar = colonySugar(colony);
    const initialSugar = finalSugar - (allDeltas[colony.colonyId] ?? 0);
    const sugar = initialSugar + (visibleDeltas[colony.colonyId] ?? 0);
    return {
      ...colony,
      sugar,
      food: sugar,
      score: sugar,
      economy: colony.economy ? {
        ...colony.economy,
        balance: sugar,
        available: sugar,
        sugarBalance: sugar,
        sugarAvailable: sugar,
      } : colony.economy,
    };
  });
}

function settlementDeltas(events: GameEvent[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const event of events) {
    if (event.kind !== "settlement" || typeof event.data?.colonyId !== "string") continue;
    const delta = Number(event.data?.sugarDelta ?? event.data?.resourceDelta ?? event.data?.sugar ?? 0);
    if (!Number.isFinite(delta)) continue;
    totals[event.data.colonyId] = (totals[event.data.colonyId] ?? 0) + delta;
  }
  return totals;
}

function buildReplayBetMarkets(events: GameEvent[], colonies: Colony[]): ReplayBetMarket[] {
  const colonyNames = new Map(colonies.map((colony) => [colony.colonyId, colony.name]));
  const opportunities = new Map<string, Opportunity>();
  const markets = new Map<string, ReplayBetMarket>();
  const predictions = new Map<string, ReplayBetEntry>();

  function ensureMarket(
    id: string,
    opportunity: Opportunity | undefined,
    event: GameEvent,
  ): ReplayBetMarket {
    const existing = markets.get(id);
    const minute = finiteTimestamp(opportunity?.minute);
    const label = String(opportunity?.label ?? opportunity?.question ?? event.message ?? "Live market");
    if (existing) {
      if (label && existing.label === "Live market") existing.label = label;
      if (minute != null) existing.minute = minute;
      existing.lastEventIndex = Math.max(existing.lastEventIndex, event.index);
      return existing;
    }
    const market = {
      id,
      label,
      minute,
      lastEventIndex: event.index,
      bets: [],
    };
    markets.set(id, market);
    return market;
  }

  for (const event of [...events].sort((left, right) => left.index - right.index)) {
    const data = event.data ?? {};

    if (event.kind === "opportunity") {
      const opportunity = objectValue<Opportunity>(data.opportunity);
      const opportunityId = identifier(opportunity?.opportunityId);
      if (opportunity && opportunityId) opportunities.set(opportunityId, opportunity);
      continue;
    }

    if (event.kind === "prediction") {
      const marketState = objectValue<Opportunity>(data.market);
      const opportunityId = identifier(data.opportunityId ?? marketState?.opportunityId);
      const predictionId = identifier(data.predictionId) || `prediction-${event.index}`;
      if (!opportunityId) continue;

      const opportunity = marketState ?? opportunities.get(opportunityId);
      const market = ensureMarket(opportunityId, opportunity, event);
      const option = objectValue<OpportunityOption>(data.option);
      const colonyId = identifier(data.colonyId);
      const sugarAtRisk = finiteNumber(data.riskSugar ?? data.sugarReserved ?? data.foodReserved);
      const bet: ReplayBetEntry = {
        predictionId,
        colonyName: String(data.colonyName ?? colonyNames.get(colonyId) ?? "Colony"),
        optionLabel: String(option?.label ?? "Prediction"),
        status: "open",
        sugarAtRisk: sugarAtRisk ?? 0,
        sugarDelta: null,
        eventIndex: event.index,
      };
      market.bets.push(bet);
      predictions.set(predictionId, bet);
      continue;
    }

    if (!["settlement", "void"].includes(event.kind)) continue;
    const predictionId = identifier(data.predictionId);
    const bet = predictions.get(predictionId);
    if (!bet) continue;

    const delta = finiteNumber(data.sugarDelta ?? data.resourceDelta ?? data.sugar);
    bet.status = event.kind === "void" ? "void" : Boolean(data.win) ? "won" : "lost";
    bet.sugarDelta = delta;
    bet.resultEventIndex = event.index;

    const opportunityId = identifier(data.opportunityId);
    const market = markets.get(opportunityId);
    if (market) market.lastEventIndex = Math.max(market.lastEventIndex, event.index);
  }

  for (const market of markets.values()) {
    market.bets.sort((left, right) => left.colonyName.localeCompare(right.colonyName));
  }
  return [...markets.values()]
    .filter((market) => market.bets.length > 0)
    .sort((left, right) => right.lastEventIndex - left.lastEventIndex);
}

function latestScore(events: GameEvent[]): MatchScore {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const score = events[index].data?.score;
    if (score && typeof score === "object") return score as MatchScore;
  }
  return { participant1: 0, participant2: 0 };
}

function latestMatchClock(events: GameEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data;
    const direct = finiteTimestamp(data?.clockSeconds);
    if (direct != null) return direct;
    const opportunity = data?.opportunity as Opportunity | undefined;
    const market = data?.market as Opportunity | undefined;
    const minute = Number(opportunity?.minute ?? market?.minute);
    if (Number.isFinite(minute) && minute >= 0) return minute * 60;
  }
  return 0;
}

function replayEventCard(event: GameEvent): ReplayEventCard {
  const data = event.data ?? {};
  if (event.kind === "match_event") {
    return {
      code: matchEventCode(String(data.visualType ?? "")),
      title: String(data.title ?? event.message ?? "Match event"),
      detail: String(data.detail ?? data.description ?? "TXLine match signal"),
      tone: "match",
    };
  }
  if (event.kind === "opportunity") {
    const opportunity = data.opportunity as Opportunity | undefined;
    return {
      code: "OPEN",
      title: "Market opened",
      detail: String(opportunity?.label ?? event.message),
      tone: "market",
    };
  }
  if (event.kind === "settlement") {
    const win = Boolean(data.win);
    const delta = Number(data.sugarDelta ?? data.resourceDelta ?? data.sugar ?? 0);
    return {
      code: win ? "WIN" : "LOSS",
      title: String(data.colonyName ?? "Colony result"),
      detail: `${Number.isFinite(delta) && delta > 0 ? "+" : ""}${Number.isFinite(delta) ? delta : 0} Sugar · ${event.message}`,
      tone: "result",
    };
  }
  if (event.kind === "market_closed" || event.kind === "markets_closed") {
    return { code: "DONE", title: "Market finished", detail: event.message, tone: "result" };
  }
  if (event.kind === "prediction") {
    return {
      code: "BET",
      title: String(data.colonyName ?? "Colony entered"),
      detail: event.message,
      tone: "colony",
    };
  }
  if (["vote", "ant_agent_vote", "observe", "late_vote"].includes(event.kind)) {
    return {
      code: event.kind === "late_vote" ? "LATE" : event.kind === "observe" ? "PASS" : "VOTE",
      title: String(data.colonyName ?? "Ant decision"),
      detail: event.message,
      tone: "colony",
    };
  }
  if (event.kind === "game_started") return { code: "START", title: "Simulation started", detail: event.message, tone: "system" };
  if (event.kind === "game_finished") return { code: "FT", title: "Simulation finished", detail: event.message, tone: "system" };
  return {
    code: humanizeKind(event.kind).slice(0, 6).toUpperCase(),
    title: humanizeKind(event.kind),
    detail: event.message,
    tone: "system",
  };
}

function matchEventCode(type: string): string {
  return {
    goal: "GOAL",
    penalty_goal: "GOAL",
    penalty: "PEN",
    penalty_missed: "PEN",
    yellow_card: "YC",
    red_card: "RC",
    substitution: "SUB",
    corner: "COR",
    free_kick: "FK",
    foul: "FOUL",
    shot: "SHOT",
    attack: "ATK",
    var: "VAR",
    injury: "MED",
    additional_time: "TIME",
    kickoff: "KO",
    half_time: "HT",
    full_time: "FT",
  }[type] ?? "LIVE";
}

function humanizeKind(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function replayBetStatusLabel(status: ReplayBetStatus): string {
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  if (status === "void") return "Void";
  return "Open";
}

function replayBetStatusTone(status: ReplayBetStatus): string {
  if (status === "won") return "!border-lime/50 !text-lime";
  if (status === "lost") return "!border-rust/50 !text-rust";
  if (status === "void") return "!border-[color:var(--brd-soft)] !text-ink-faint";
  return "!border-gold/50 !text-gold-deep";
}

function replayBetSugarLabel(bet: ReplayBetEntry): string {
  if (bet.status === "open") return `${bet.sugarAtRisk} at risk`;
  if (bet.status === "void") return "Returned";
  const delta = bet.sugarDelta ?? 0;
  return `${delta > 0 ? "+" : ""}${delta} Sugar`;
}

function replayBetSugarTone(bet: ReplayBetEntry): string {
  if (bet.status === "won") return "text-green";
  if (bet.status === "lost") return "text-rust";
  return "text-ink-faint";
}

function formatReplayDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function finiteTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function identifier(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function objectValue<T extends object>(value: unknown): T | undefined {
  return value && typeof value === "object" ? value as T : undefined;
}
