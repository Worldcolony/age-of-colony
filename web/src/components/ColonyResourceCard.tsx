import { colonyAvailableSugar, colonyReservedSugar, colonySugar, colonySugarNet } from "@/lib/sugar";
import { optionLabel, STYLE_OPTIONS } from "@/lib/strategy";
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
    return <div className="glass p-4 text-center text-sm text-ink-faint">Create a colony to compete for Sugar.</div>;
  }

  const sugar = colonySugar(colony);
  const reserved = colonyReservedSugar(colony);
  const available = colonyAvailableSugar(colony);
  const net = colonySugarNet(colony);
  const temperament = optionLabel(STYLE_OPTIONS, colony.style);

  return (
    <section className="glass bracket overflow-hidden p-4" aria-labelledby="colony-sugar-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{spectator ? "Selected colony" : "Your colony"}</p>
          <h2 id="colony-sugar-title" className="text-base font-bold">Most Sugar wins the match</h2>
        </div>
        <span className="status-pill !border-green/50 !text-green">#{rank || "–"}</span>
      </div>

      <div className="resource-granary mt-4 rounded-md border-2 border-[color:rgba(176,126,28,0.48)] p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-gold-deep">Sugar</p>
            <p className="mt-1 flex items-baseline gap-2" aria-live="polite" aria-atomic="true">
              <strong className="font-mono text-4xl text-ink">{sugar}</strong>
              <span className={`font-mono text-xs font-bold ${net < 0 ? "text-rust" : "text-green"}`}>
                {net > 0 ? "+" : ""}{net} this match
              </span>
            </p>
          </div>
          <div className="text-right text-xs font-bold text-ink-faint">
            <p>{available} available</p>
            <p>{reserved > 0 ? `${reserved} backing open calls` : "No Sugar at risk"}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <ResourceMetric label="Temperament" value={temperament} tone="gold" />
        <ResourceMetric label="Fixed voters" value={`${colony.size || 20} ants`} />
      </div>

      <details className="resource-rules mt-3 rounded-md border-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.66)] p-3">
        <summary className="cursor-pointer text-sm font-bold text-ink-soft">How a colony enters a market</summary>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed text-ink-soft">
          <p><b className="text-gold-deep">1. Vote:</b> the colony&apos;s fixed ants choose an outcome or pass.</p>
          <p><b className="text-green">2. Consensus:</b> the colony enters only when support clears its temperament threshold.</p>
          <p><b className="text-rust">3. Result:</b> a correct call adds the displayed Sugar reward; a miss removes the displayed Sugar risk.</p>
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
