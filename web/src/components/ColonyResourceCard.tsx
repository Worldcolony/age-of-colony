import type { Colony } from "@/lib/types";

export function ColonyResourceCard({
  colony,
  rank,
  spectator = false,
}: {
  colony?: Colony;
  rank: number;
  spectator?: boolean;
}) {
  if (!colony) {
    return <div className="glass p-4 text-center text-sm text-ink-faint">Create a colony to compete.</div>;
  }

  const economy = colony.economy;
  const food = economy?.balance ?? colony.food ?? 0;
  const reserved = economy?.reserved ?? 0;
  const available = economy?.available ?? Math.max(0, food - reserved);
  const foodNet = economy?.net ?? colony.foodNet ?? food - 20;
  const upkeep = economy?.upkeepCost ?? Math.max(1, Math.ceil((colony.antsAlive ?? 0) / 50));
  const upkeepEvery = economy?.upkeepEveryEvents ?? 24;
  const nextUpkeep = economy?.nextUpkeepInEvents ?? upkeepEvery;
  const runway = economy?.runwayUpkeeps ?? (upkeep > 0 ? Math.floor(available / upkeep) : null);
  const status = economy?.status ?? (available <= upkeep ? "critical" : available <= upkeep * 3 ? "watch" : "stable");
  const runwayWidth = runway == null ? 100 : Math.max(4, Math.min(100, (runway / 12) * 100));
  const statusCopy = status === "critical" ? "critical" : status === "watch" ? "watch" : "steady";
  const statusClass = status === "critical"
    ? "!border-rust/60 !text-rust"
    : status === "watch"
      ? "!border-gold/60 !text-gold-deep"
      : "!border-green/50 !text-green";

  return (
    <section className="glass bracket overflow-hidden p-4" aria-labelledby="colony-reserves-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Colony reserves</p>
          <h2 id="colony-reserves-title" className="text-base font-bold">Food keeps every order alive</h2>
        </div>
        <span className={`status-pill ${statusClass}`}>{statusCopy}</span>
      </div>

      <div className="mt-4 grid grid-cols-[1.25fr_1fr] gap-3">
        <div className="resource-granary rounded-md border-2 border-[color:rgba(176,126,28,0.48)] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-gold-deep">Food bank</p>
          <p className="mt-1 flex items-baseline gap-2" aria-live="polite" aria-atomic="true">
            <strong className="font-mono text-4xl text-ink">{food}</strong>
            <span className={`font-mono text-xs font-bold ${foodNet < 0 ? "text-rust" : "text-green"}`}>
              {foodNet > 0 ? "+" : ""}{foodNet} net
            </span>
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[rgba(74,58,30,0.16)]" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${status === "critical" ? "bg-rust" : status === "watch" ? "bg-gold" : "bg-green"}`}
              style={{ width: `${runwayWidth}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] font-bold text-ink-faint">
            {runway == null ? "No upkeep while the colony is empty" : `${runway} upkeep cycle${runway === 1 ? "" : "s"} covered`}
          </p>
          <p className="mt-1 text-[11px] text-ink-faint">
            {available} available{reserved > 0 ? ` · ${reserved} backing open calls` : " · nothing locked"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-center">
          <ResourceMetric label="Rank" value={`#${rank || "–"}`} tone="gold" />
          <ResourceMetric label={spectator ? "Lead ants" : "Ants"} value={colony.antsAlive ?? 0} />
          <ResourceMetric label="Upkeep" value={`-${upkeep}`} />
          <ResourceMetric label="Due in" value={`${nextUpkeep} ev`} />
        </div>
      </div>

      <details className="resource-rules mt-3 rounded-md border-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.66)] p-3">
        <summary className="cursor-pointer text-sm font-bold text-ink-soft">How food works</summary>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed text-ink-soft">
          <p><b className="text-green">Win:</b> ant support × the market payout adds food.</p>
          <p><b className="text-rust">Risk:</b> ant support × the displayed loss rate is locked until the result, then returned on a win or removed on a loss.</p>
          <p><b className="text-gold-deep">Upkeep:</b> {upkeep} food every {upkeepEvery} match events. No food means no new backing; a shortage costs ants.</p>
        </div>
      </details>
    </section>
  );
}

function ResourceMetric({ label, value, tone }: { label: string; value: number | string; tone?: "gold" }) {
  return (
    <div className="well grid min-h-[62px] place-content-center px-2 py-2">
      <p className="truncate text-[10px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-base font-bold ${tone === "gold" ? "text-gold" : "text-ink"}`}>{value}</p>
    </div>
  );
}
