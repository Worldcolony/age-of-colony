"use client";

import { useEffect, useRef, useState } from "react";
import { fmtClockSeconds, fmtMatchTime } from "@/lib/format";
import type { GameState } from "@/lib/types";

interface SmoothMatchClockProps {
  match?: GameState["match"] | null;
  status?: GameState["status"] | string | null;
  mode?: GameState["mode"];
  replayTimeScale?: number | null;
  replayClockTargetSeconds?: number | null;
  className?: string;
  showLiveDot?: boolean;
}

interface ClockPoint {
  clock: number;
  at: number;
}

function matchClockSeconds(match?: GameState["match"] | null): number | null {
  const seconds = Number(match?.clockSeconds);
  if (match?.clockSeconds != null && Number.isFinite(seconds) && seconds >= 0) return seconds;
  const minute = Number(match?.minute);
  if (match?.minute != null && Number.isFinite(minute) && minute >= 0) return minute * 60;
  return null;
}

function isRunningStatus(status?: string | null): boolean {
  return status === "running_live" || status === "running_replay";
}

/**
 * Match snapshots only move when a TXLine event is processed. This clock uses
 * those snapshots as authoritative anchors, then advances locally at the
 * configured replay rate without ever passing the server's next-event bound.
 */
export function SmoothMatchClock({
  match,
  status,
  mode,
  replayTimeScale,
  replayClockTargetSeconds,
  className = "",
  showLiveDot = false,
}: SmoothMatchClockProps) {
  const rawClock = matchClockSeconds(match);
  const replayTarget = Number(replayClockTargetSeconds);
  const validReplayTarget = replayClockTargetSeconds != null
    && Number.isFinite(replayTarget)
    && replayTarget >= 0
    ? replayTarget
    : null;
  const running = isRunningStatus(status);
  const [displayClock, setDisplayClock] = useState<number | null>(() => rawClock);
  const anchorRef = useRef<ClockPoint | null>(null);

  useEffect(() => {
    if (rawClock == null) {
      anchorRef.current = null;
      const clearFrame = window.requestAnimationFrame(() => setDisplayClock(null));
      return () => window.cancelAnimationFrame(clearFrame);
    }

    const now = performance.now();
    anchorRef.current = { clock: rawClock, at: now };
    const snapFrame = window.requestAnimationFrame(() => setDisplayClock(Math.floor(rawClock)));
    return () => window.cancelAnimationFrame(snapFrame);
  }, [rawClock, validReplayTarget]);

  useEffect(() => {
    if (!running || rawClock == null) return;
    let frame = 0;

    const tick = (now: number) => {
      const anchor = anchorRef.current;
      if (anchor) {
        const configuredReplayRate = Number(replayTimeScale);
        const fallbackRate = Number.isFinite(configuredReplayRate) && configuredReplayRate > 0
          ? configuredReplayRate
          : 0;
        const rate = status === "running_live" || mode === "live"
          ? 1
          : validReplayTarget == null ? 0 : fallbackRate;
        const interpolatedClock = anchor.clock + Math.max(0, now - anchor.at) / 1000 * rate;
        const boundedClock = status === "running_replay" && validReplayTarget != null
          ? Math.min(interpolatedClock, Math.max(anchor.clock, validReplayTarget))
          : interpolatedClock;
        const nextClock = Math.floor(boundedClock);
        setDisplayClock((current) => current === nextClock ? current : nextClock);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [mode, rawClock, replayTimeScale, running, status, validReplayTarget]);

  const text = status === "finished"
    ? "FT"
    : displayClock == null
      ? fmtMatchTime(match, status)
      : fmtClockSeconds(displayClock);
  const label = displayClock == null
    ? `Match time ${text}`
    : `Match time ${Math.floor(displayClock / 60)} minutes ${displayClock % 60} seconds`;

  return (
    <span
      className={`smooth-match-clock ${className}`.trim()}
      data-running={running}
      role="timer"
      aria-label={label}
    >
      {showLiveDot && running && <span className="live-dot" aria-hidden="true" />}
      <span className="smooth-match-clock-value">{text}</span>
    </span>
  );
}
