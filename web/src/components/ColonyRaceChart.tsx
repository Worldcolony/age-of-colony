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
}

export function ColonyRaceChart({
  colonies,
  events,
  compact = false,
}: {
  colonies: Colony[];
  events: GameEvent[];
  compact?: boolean;
}) {
  if (!colonies.length) return null;

  const ranked = [...colonies].sort((a, b) => colonySugar(b) - colonySugar(a));
  const points = buildRacePoints(ranked, events);
  const allValues = points.flatMap((point) => ranked.map((colony) => point.values[colony.colonyId] ?? colonySugar(colony)));
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const padding = Math.max(2, Math.ceil((rawMax - rawMin) * 0.18));
  const minValue = Math.max(0, rawMin - padding);
  const maxValue = Math.max(minValue + 4, rawMax + padding);
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

  return (
    <section
      className={`colony-race ${compact ? "is-compact" : ""}`}
      aria-label={tied ? `Sugar race. ${tiedLeaders.length} colonies are tied at ${colonySugar(leader)} Sugar.` : `Sugar race. ${leader.name} leads by ${lead} Sugar.`}
    >
      <div className="colony-race-head">
        <div>
          <p className="eyebrow">Sugar race</p>
          <h3>{tied ? `${tiedLeaders.length} colonies are level` : `${leader.name} is leading`}</h3>
        </div>
        <span className="colony-race-lead">{tied ? `LEVEL · ${colonySugar(leader)} Sugar` : `👑 +${lead} Sugar`}</span>
      </div>

      <div className="colony-race-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-hidden="true" preserveAspectRatio="none">
          <defs>
            <filter id="raceGlow" x="-20%" y="-20%" width="140%" height="140%">
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
            const visualOffset = allSeriesLevel ? (colonyIndex - (ranked.length - 1) / 2) * 4 : 0;
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
                  filter={!tied && colonyIndex === 0 ? "url(#raceGlow)" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={endX} cy={endY} r={!tied && colonyIndex === 0 ? 7 : 5} fill={color} stroke="#fff8e8" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        <span className="colony-race-axis top">{maxValue}</span>
        <span className="colony-race-axis bottom">{minValue}</span>
      </div>

      <div className="colony-race-legend">
        {ranked.map((colony, index) => (
          <div key={colony.colonyId} className={!tied && index === 0 ? "is-leader" : ""}>
            <span className="colony-race-dot" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            <span className="truncate">{!tied && index === 0 ? "👑 " : ""}{colony.name}</span>
            <b>{colonySugar(colony)}</b>
          </div>
        ))}
      </div>
    </section>
  );
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
    points.push({ index: event.index, values: { ...running } });
  }

  if (points.length === 1) {
    points.push({ index: firstIndex + 1, values: { ...running } });
  }
  return points;
}

function eventDelta(event: GameEvent): number {
  const value = Number(event.data?.sugarDelta ?? event.data?.resourceDelta ?? event.data?.sugar ?? 0);
  return Number.isFinite(value) ? value : 0;
}
