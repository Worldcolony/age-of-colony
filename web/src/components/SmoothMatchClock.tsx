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
 * those snapshots as authoritative anchors, then advances locally between
 * updates so the displayed match time never freezes during a processing batch.
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
  const replayBound = status === "running_replay" && rawClock != null && validReplayTarget != null
    ? Math.max(rawClock, validReplayTarget)
    : null;
  const [displayClock, setDisplayClock] = useState<number | null>(() => rawClock);
  const anchorRef = useRef<ClockPoint | null>(null);
  const displayClockRef = useRef<number | null>(rawClock);

  useEffect(() => {
    if (rawClock == null) {
      anchorRef.current = null;
      displayClockRef.current = null;
      const clearFrame = window.requestAnimationFrame(() => setDisplayClock(null));
      return () => window.cancelAnimationFrame(clearFrame);
    }

    const now = performance.now();
    const currentDisplay = displayClockRef.current;
    const nextAnchor = status === "running_replay"
      ? replayBound == null
        ? rawClock
        : Math.min(Math.max(rawClock, currentDisplay ?? rawClock), replayBound)
      : running && currentDisplay != null
        ? Math.max(rawClock, currentDisplay)
        : rawClock;
    anchorRef.current = { clock: nextAnchor, at: now };
    displayClockRef.current = Math.floor(nextAnchor);
    const snapFrame = window.requestAnimationFrame(() => setDisplayClock(Math.floor(nextAnchor)));
    return () => window.cancelAnimationFrame(snapFrame);
  }, [rawClock, replayBound, running, status]);

  useEffect(() => {
    if (!running || rawClock == null) return;
    let frame = 0;

    const tick = (now: number) => {
      const anchor = anchorRef.current;
      if (anchor) {
        const configuredReplayRate = Number(replayTimeScale);
        const fallbackRate = Number.isFinite(configuredReplayRate) && configuredReplayRate > 0
          ? configuredReplayRate
          : 1;
        const rate = status === "running_live" || mode === "live"
          ? 1
          : fallbackRate;
        const interpolatedClock = anchor.clock + Math.max(0, now - anchor.at) / 1000 * rate;
        const boundedClock = status === "running_replay"
          ? replayBound == null
            ? rawClock
            : Math.min(interpolatedClock, replayBound)
          : interpolatedClock;
        const nextClock = Math.floor(boundedClock);
        displayClockRef.current = nextClock;
        setDisplayClock((current) => current === nextClock ? current : nextClock);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [mode, rawClock, replayBound, replayTimeScale, running, status]);

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
