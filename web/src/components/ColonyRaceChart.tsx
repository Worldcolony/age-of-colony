import { useId, type CSSProperties } from "react";
import { colonySugar } from "@/lib/sugar";
import type { Colony, GameEvent } from "@/lib/types";

const CHART_COLORS = ["#d94b3d", "#65a7ff", "#4e7e2a", "#c28b18", "#9b6fd3", "#168f91"];
const WIDTH = 680;
const HEIGHT = 220;
const PAD_X = 30;
const PAD_Y = 24;

interface RacePoint {
  index: number;
  values: Record<string, number>;
  changedColonyId?: string;
}

interface EndMarker {
  colonyId: string;
  name: string;
  value: number;
  color: string;
  pointY: number;
}

interface EndLabel {
  key: string;
  names: string[];
  value: number;
  colors: string[];
  pointY: number;
}

export function ColonyRaceChart({
  colonies,
  events,
  compact = false,
  hero = false,
}: {
  colonies: Colony[];
  events: GameEvent[];
  compact?: boolean;
  hero?: boolean;
}) {
  const glowId = useId().replace(/:/g, "");
  if (!colonies.length) return null;

  const ranked = [...colonies].sort((a, b) => colonySugar(b) - colonySugar(a));
  const points = buildRacePoints(ranked, events);
  const allValues = points.flatMap((point) => ranked.map((colony) => point.values[colony.colonyId] ?? colonySugar(colony)));
  const { minValue, maxValue } = focusedChartBounds(allValues);
  const firstIndex = points[0]?.index ?? 0;
  const lastIndex = points.at(-1)?.index ?? firstIndex + 1;
  const leader = ranked[0];
  const runnerUp = ranked[1];
  const lead = runnerUp ? colonySugar(leader) - colonySugar(runnerUp) : colonySugar(leader);
  const tiedLeaders = ranked.filter((colony) => colonySugar(colony) === colonySugar(leader));
  const tied = tiedLeaders.length > 1;
  const allSeriesLevel = ranked.every((colony) => points.every(
    (point) => point.values[colony.colonyId] === point.values[leader.colonyId],
  ));

  function xFor(index: number): number {
    if (lastIndex === firstIndex) return PAD_X;
    return PAD_X + ((index - firstIndex) / (lastIndex - firstIndex)) * (WIDTH - PAD_X * 2);
  }

  function yFor(value: number): number {
    return HEIGHT - PAD_Y - ((value - minValue) / (maxValue - minValue)) * (HEIGHT - PAD_Y * 2);
  }

  function visualOffsetFor(colonyIndex: number): number {
    return allSeriesLevel ? (colonyIndex - (ranked.length - 1) / 2) * 4 : 0;
  }

  const endPoint = points.at(-1);
  const endMarkers = ranked.map((colony, colonyIndex) => {
    const value = endPoint?.values[colony.colonyId] ?? colonySugar(colony);
    const pointY = yFor(value) + visualOffsetFor(colonyIndex);
    return {
      colonyId: colony.colonyId,
      name: colony.name,
      value,
      color: CHART_COLORS[colonyIndex % CHART_COLORS.length],
      pointY,
    };
  });
  const endLabels = groupEndMarkers(endMarkers);

  return (
    <section
      className={`colony-race ${compact ? "is-compact" : ""} ${hero ? "is-hero" : ""}`}
      aria-label={`Sugar race. ${tied ? `${tiedLeaders.length} colonies are tied at ${colonySugar(leader)} Sugar.` : `${leader.name} leads by ${lead} Sugar.`} Focused chart scale from ${minValue} to ${maxValue} Sugar.`}
    >
      <div className="colony-race-head">
        <div>
          <p className="eyebrow">Sugar race</p>
          <h3>{tied ? `${tiedLeaders.length} colonies tied` : `${leader.name} is leading`}</h3>
        </div>
        <span className="colony-race-lead">{tied ? `LEVEL · ${colonySugar(leader)} Sugar` : `LEAD · +${lead} Sugar`}</span>
      </div>

      <div className="colony-race-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-hidden="true" preserveAspectRatio="none">
          <defs>
            <filter
              id={glowId}
              filterUnits="userSpaceOnUse"
              x={-20}
              y={-20}
              width={WIDTH + 40}
              height={HEIGHT + 40}
            >
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = PAD_Y + ratio * (HEIGHT - PAD_Y * 2);
            return <line key={ratio} x1={PAD_X} y1={y} x2={WIDTH - PAD_X} y2={y} className="colony-race-grid" />;
          })}
          {ranked.map((colony, colonyIndex) => {
            const color = CHART_COLORS[colonyIndex % CHART_COLORS.length];
            const visualOffset = visualOffsetFor(colonyIndex);
            const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${xFor(point.index)} ${yFor(point.values[colony.colonyId] ?? colonySugar(colony)) + visualOffset}`).join(" ");
            const end = points.at(-1);
            const endX = xFor(end?.index ?? lastIndex);
            const endY = yFor(end?.values[colony.colonyId] ?? colonySugar(colony)) + visualOffset;
            return (
              <g key={colony.colonyId}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={colonyIndex === 0 ? 5 : 3.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={seriesDash(colonyIndex)}
                  filter={!tied && colonyIndex === 0 ? `url(#${glowId})` : undefined}
                  vectorEffect="non-scaling-stroke"
                />
                {points.slice(1).filter((point) => point.changedColonyId === colony.colonyId).map((point) => (
                  <circle
                    key={`${colony.colonyId}-${point.index}`}
                    cx={xFor(point.index)}
                    cy={yFor(point.values[colony.colonyId] ?? colonySugar(colony)) + visualOffset}
                    r={3.5}
                    fill="#fff8e8"
                    stroke={color}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <circle cx={endX} cy={endY} r={!tied && colonyIndex === 0 ? 7 : 5} fill={color} stroke="#fff8e8" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        <div className="colony-race-end-labels" aria-hidden="true">
          {endLabels.map((label) => (
            <span
              key={label.key}
              className="colony-race-end-tag"
              title={`${label.names.join(" + ")}: ${label.value} Sugar`}
              style={{
                "--marker-y": `${label.pointY / HEIGHT * 100}%`,
                "--series-color": label.colors[0],
              } as CSSProperties}
            >
              <span className="colony-race-end-series">
                {label.colors.map((color) => (
                  <i key={color} style={{ "--series-color": color } as CSSProperties} />
                ))}
              </span>
              <span>{label.names.join(" + ")}</span>
              <b>{label.value}</b>
            </span>
          ))}
        </div>
        <span className="colony-race-axis top">{maxValue}</span>
        <span className="colony-race-axis bottom">{minValue}</span>
        <span className="colony-race-x start">Start</span>
        <span className="colony-race-x end">Now</span>
      </div>

      <div className="colony-race-legend">
        {ranked.map((colony, index) => (
          <div key={colony.colonyId} className={!tied && index === 0 ? "is-leader" : ""}>
            <span
              className="colony-race-line"
              data-series={index % 4}
              style={{ "--series-color": CHART_COLORS[index % CHART_COLORS.length] } as CSSProperties}
            />
            <span className="truncate">{!tied && index === 0 ? "#1 " : ""}{colony.name}</span>
            <b>{colonySugar(colony)} <small>Sugar</small></b>
          </div>
        ))}
      </div>
    </section>
  );
}

function focusedChartBounds(values: number[]): { minValue: number; maxValue: number } {
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rawRange = rawMax - rawMin;
  const padding = Math.max(1, Math.ceil(rawRange * 0.12));
  let minValue = Math.max(0, rawMin - padding);
  let maxValue = rawMax + padding;
  const minimumVisibleSpan = 6;

  if (maxValue - minValue < minimumVisibleSpan) {
    const missing = minimumVisibleSpan - (maxValue - minValue);
    const addBelow = Math.min(minValue, Math.floor(missing / 2));
    minValue -= addBelow;
    maxValue += missing - addBelow;
  }

  return { minValue, maxValue };
}

function groupEndMarkers(markers: EndMarker[]): EndLabel[] {
  const groups = new Map<number, EndMarker[]>();
  for (const marker of markers) {
    groups.set(marker.value, [...(groups.get(marker.value) ?? []), marker]);
  }

  return [...groups.entries()]
    .map(([value, groupedMarkers]) => ({
      key: groupedMarkers.map((marker) => marker.colonyId).join("-"),
      names: groupedMarkers.map((marker) => marker.name),
      value,
      colors: groupedMarkers.map((marker) => marker.color),
      pointY: groupedMarkers.reduce((total, marker) => total + marker.pointY, 0) / groupedMarkers.length,
    }))
    .sort((left, right) => left.pointY - right.pointY);
}

function buildRacePoints(colonies: Colony[], events: GameEvent[]): RacePoint[] {
  const settlements = [...events]
    .filter((event) => event.kind === "settlement" && typeof event.data?.colonyId === "string")
    .sort((a, b) => a.index - b.index);
  const totals: Record<string, number> = {};
  for (const colony of colonies) totals[colony.colonyId] = 0;
  for (const event of settlements) {
    const colonyId = String(event.data?.colonyId ?? "");
    if (!(colonyId in totals)) continue;
    totals[colonyId] += eventDelta(event);
  }

  const running: Record<string, number> = {};
  for (const colony of colonies) running[colony.colonyId] = colonySugar(colony) - totals[colony.colonyId];
  const firstIndex = settlements[0]?.index ?? 0;
  const points: RacePoint[] = [{ index: Math.max(0, firstIndex - 1), values: { ...running } }];

  for (const event of settlements) {
    const colonyId = String(event.data?.colonyId ?? "");
    if (!(colonyId in running)) continue;
    running[colonyId] += eventDelta(event);
    points.push({ index: event.index, values: { ...running }, changedColonyId: colonyId });
  }

  if (points.length === 1) {
    points.push({ index: firstIndex + 1, values: { ...running } });
  }
  return points;
}

function seriesDash(index: number): string | undefined {
  if (index === 1) return "12 7";
  if (index === 2) return "3 7";
  if (index === 3) return "14 5 3 5";
  return undefined;
}

function eventDelta(event: GameEvent): number {
  const value = Number(event.data?.sugarDelta ?? event.data?.resourceDelta ?? event.data?.sugar ?? 0);
  return Number.isFinite(value) ? value : 0;
}
