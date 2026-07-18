"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColonyRaceChart } from "@/components/ColonyRaceChart";
import { flag, fmtClockSeconds } from "@/lib/format";
import { colonySugar } from "@/lib/sugar";
import type { Colony, GameEvent, GameState, MatchScore, Opportunity } from "@/lib/types";

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
  const [speed, setSpeed] = useState<1 | 4>(4);
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
  const currentScore = latestScore(visibleEvents);
  const matchClock = latestMatchClock(visibleEvents);
  const recentPoints = visiblePoints.slice(-7).reverse();
  const progress = duration > 0 ? Math.round(position / duration * 100) : 0;

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
    <section className="simulation-replay" aria-label="Complete simulation replay">
      <header className="simulation-replay-head">
        <div>
          <p>Simulation tape</p>
          <h2>Replay everything that happened</h2>
        </div>
        <span data-playing={playing}>{playing ? `Playing ×${speed}` : position >= duration ? "Replay complete" : `Ready · ×${speed}`}</span>
      </header>

      <div className="simulation-replay-score">
        <span className="simulation-replay-team">
          <i aria-hidden="true">{flag(game.participant1)}</i>
          <b>{game.participant1 || "Team 1"}</b>
        </span>
        <strong>{currentScore.participant1 ?? 0} – {currentScore.participant2 ?? 0}</strong>
        <span className="simulation-replay-team is-away">
          <i aria-hidden="true">{flag(game.participant2)}</i>
          <b>{game.participant2 || "Team 2"}</b>
        </span>
        <span className="simulation-replay-match-clock">{fmtClockSeconds(matchClock)}</span>
      </div>

      <div className="simulation-replay-stage">
        <div className="simulation-replay-race">
          <ColonyRaceChart colonies={replayColonies} events={visibleEvents} hero />
        </div>

        <aside className="simulation-replay-events" aria-label="Events reached in the replay">
          <div className="simulation-replay-events-head">
            <div>
              <p>Now on tape</p>
              <strong>{visiblePoints.length} / {timeline.length} actions</strong>
            </div>
            <span>{progress}%</span>
          </div>
          <ol>
            {recentPoints.map((point) => {
              const card = replayEventCard(point.event);
              return (
                <li key={point.event.index} data-tone={card.tone}>
                  <span>{card.code}</span>
                  <div>
                    <small>{formatReplayDuration(point.offset)} · #{point.event.index}</small>
                    <b>{card.title}</b>
                    <p>{card.detail}</p>
                  </div>
                </li>
              );
            })}
            {!recentPoints.length && (
              <li className="is-empty">
                <span>READY</span>
                <div>
                  <b>Press play to review the simulation</b>
                  <p>Match events, markets, colony votes and results will appear here.</p>
                </div>
              </li>
            )}
          </ol>
        </aside>
      </div>

      <div className="simulation-replay-controls">
        <button type="button" className="simulation-replay-play" onClick={togglePlayback}>
          <span aria-hidden="true">{playing ? "Ⅱ" : position >= duration ? "↺" : "▶"}</span>
          {playing ? "Pause replay" : position >= duration ? `Replay again ×${speed}` : `Play replay ×${speed}`}
        </button>
        <div className="simulation-replay-speeds" aria-label="Replay speed">
          {([1, 4] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-active={speed === value}
              aria-pressed={speed === value}
              onClick={() => setSpeed(value)}
            >
              ×{value}
            </button>
          ))}
        </div>
        <label className="simulation-replay-scrubber">
          <span className="sr-only">Replay position</span>
          <input
            type="range"
            min={0}
            max={Math.max(0.1, duration)}
            step={0.05}
            value={Math.min(position, Math.max(0.1, duration))}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </label>
        <span className="simulation-replay-elapsed">
          {formatReplayDuration(position)} / {formatReplayDuration(duration)}
        </span>
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

function formatReplayDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function finiteTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
