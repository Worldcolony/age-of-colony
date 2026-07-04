"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { getAnonId } from "@/lib/anon";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, GameState, Opportunity } from "@/lib/types";
import { worldBus } from "@/three/worldBus";

const RUNNING = new Set(["running_replay", "running_live"]);
const PULSE: Record<string, number> = { opportunity: 3, vote: 1.4, ant_agent_vote: 1.4, settlement: 2.4, hatch: 1.6, game_started: 3 };
const KIND_EDGE: Record<string, string> = {
  opportunity: "#e6a13a", markets_closed: "#e6a13a",
  settlement: "#8fbd50", hatch: "#8fbd50", info_result: "#8fbd50",
  vote: "#d96150", ant_agent_vote: "#d96150", prediction: "#d96150",
  game_error: "#d96150", starvation: "#d96150", void: "#d96150",
};

interface PublicVote {
  activeCount?: number;
  neutralCount?: number;
  agentDecisionCount?: number;
  aliveCount?: number;
  engagedCount?: number;
  woundedCount?: number;
  voteCounts?: Record<string, number>;
  voteLabels?: Record<string, string>;
  predictions?: Record<string, { count?: number; weight?: number } | number>;
}

interface MarketModel {
  id: string;
  label: string;
  minute?: number;
  opportunity?: Opportunity;
  status: "open" | "settled" | "void" | "closed";
  starts: GameEvent[];
  votes: GameEvent[];
  predictions: GameEvent[];
  settlements: GameEvent[];
  voids: GameEvent[];
  lastIndex: number;
}

export default function CockpitPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const myColonyId = useStore((s) => s.myColonyId);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const mf = useStore((s) => s.matchFixture);

  const [events, setEvents] = useState<GameEvent[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const anonId = useMemo(() => getAnonId(), []);

  function addEvent(e: GameEvent) {
    addEvents([e]);
  }

  function addEvents(incoming: GameEvent[]) {
    const fresh: GameEvent[] = [];
    for (const event of incoming) {
      if (seen.current.has(event.index)) continue;
      seen.current.add(event.index);
      if (PULSE[event.kind]) worldBus.pulse(PULSE[event.kind]);
      fresh.push(event);
    }
    if (!fresh.length) return;
    setEvents((prev) => [...fresh, ...prev].sort((a, b) => b.index - a.index).slice(0, 700));
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const replay = await api.getReplay(id);
        if (cancelled) return;
        setGame(replay.game);
        const ownColony = findOwnColony(replay.game, anonId);
        if (ownColony) setMyColonyId(ownColony.colonyId);
        addEvents(replay.events ?? []);
        setLastSyncAt(Date.now());
      } catch {
        try {
          const g = await api.getGame(id);
          if (cancelled) return;
          setGame(g);
          const ownColony = findOwnColony(g, anonId);
          if (ownColony) setMyColonyId(ownColony.colonyId);
          setLastSyncAt(Date.now());
        } catch { /* keep current screen */ }
      }
    }

    loadSnapshot();
    const interval = window.setInterval(loadSnapshot, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useGameStream(id, {
    onOpen: () => setStreamState("live"),
    onError: () => setStreamState("reconnecting"),
    onEvent: (e) => {
      setStreamState("live");
      addEvent(e);
    },
    onState: (g) => {
      setStreamState("live");
      setGame(g);
      setLastSyncAt(Date.now());
    },
  });

  const walletAccent = useStore((s) => s.wallet.accent);
  useEffect(() => {
    worldBus.setAccent(walletAccent || "#e6a13a");
  }, [walletAccent]);
  useEffect(() => {
    worldBus.setIntensity(RUNNING.has(game?.status ?? "") ? 0.9 : 0.4);
  }, [game?.status]);

  const sorted = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => (b.score || 0) - (a.score || 0)), [game?.colonies]);
  const ownColony = useMemo(() => findOwnColony(game, anonId), [game, anonId]);
  const spectatorFallback = (game?.players?.length ?? 0) === 0 ? sorted[0] : undefined;
  const mine = ownColony ?? spectatorFallback;
  const myIdx = mine ? sorted.findIndex((c) => c.colonyId === mine.colonyId) : -1;
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const status = game?.status ?? "";
  const markets = useMemo(() => buildMarkets(game?.activeOpportunities ?? [], events), [game?.activeOpportunities, events]);
  const openMarkets = markets.filter((market) => market.status === "open");
  const settledMarkets = markets.filter((market) => market.status !== "open" && (market.settlements.length || market.voids.length));
  const visibleOpen = openMarkets.slice(0, 3);
  const olderOpen = openMarkets.slice(3);
  const visibleSettled = settledMarkets.slice(0, 5);
  const olderSettled = settledMarkets.slice(5);
  const feedRows = events.filter((e) => isUsefulLiveEvent(e)).slice(0, 5);

  useEffect(() => {
    if (ownColony?.colonyId && myColonyId !== ownColony.colonyId) {
      setMyColonyId(ownColony.colonyId);
    }
  }, [myColonyId, ownColony?.colonyId, setMyColonyId]);

  return (
    <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-3">
      <header className="page-top">
        <button className="icon-btn" aria-label="Back" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>←</button>
        <div className="text-center">
          <h1 className="text-xl font-bold">Live cockpit</h1>
          <p className="text-xs text-ink-faint">{lastSyncAt ? `Synced ${formatClock(lastSyncAt)}` : "Syncing..."}</p>
        </div>
        <span className={`status-pill ${RUNNING.has(status) ? "!border-rust/50 !text-rust" : ""}`}>
          {RUNNING.has(status) && <span className="live-dot" />}
          {streamState === "reconnecting" ? "reconnect" : status === "created" ? "not started" : status.replace("_", " ") || "live"}
        </span>
      </header>

      <section className="glass match-card-media flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p1)}</span>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-bold text-ink-soft">{p1} vs {p2}</p>
            <p className="font-mono text-4xl font-bold text-gold">{fmtScore(game?.match?.score)}</p>
            <p className="truncate font-mono text-xs text-cyan">{game?.match?.possessionLabel || "TXLine live"}</p>
          </div>
          <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p2)}</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <PulseMetric label="Open" value={openMarkets.length} tone="gold" />
          <PulseMetric label="Settled" value={settledMarkets.length} tone="green" />
          <PulseMetric label="Events" value={game?.eventIndex ?? events[0]?.index ?? 0} />
        </div>
      </section>

      <RankCard mine={mine} rank={rank} />

      {status === "created" ? (
        <section className="glass flex flex-col gap-3 p-4 text-center">
          <h2 className="text-lg font-bold">Room is not live yet</h2>
          <p className="text-sm text-ink-soft">Start the match from the room once every player has a colony.</p>
          <button className="btn btn-primary" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>
            Back to room
          </button>
        </section>
      ) : (
        <>
          <section className="glass flex flex-col gap-3 p-4">
            <SectionTitle title="Open markets" count={openMarkets.length} accent="Ants are voting" />
            {visibleOpen.length ? visibleOpen.map((market) => <MarketPanel key={market.id} market={market} />) : (
              <EmptyState title="No market open" body="The next prediction window will appear here." />
            )}
            {olderOpen.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer list-none rounded-lg border border-[color:var(--brd-soft)] px-3 py-2 text-sm font-bold text-ink-soft">
                  Show {olderOpen.length} older open market{olderOpen.length > 1 ? "s" : ""}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  {olderOpen.map((market) => <MarketPanel key={market.id} market={market} compact />)}
                </div>
              </details>
            )}
          </section>

          <section className="glass flex flex-col gap-3 p-4">
            <SectionTitle title="Settled" count={settledMarkets.length} accent="Resolved results" />
            {visibleSettled.length ? visibleSettled.map((market) => <SettledPanel key={market.id} market={market} />) : (
              <EmptyState title="No settled market yet" body="Results will appear here as markets expire or resolve." />
            )}
            {olderSettled.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer list-none rounded-lg border border-[color:var(--brd-soft)] px-3 py-2 text-sm font-bold text-ink-soft">
                  Show {olderSettled.length} older settlement{olderSettled.length > 1 ? "s" : ""}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  {olderSettled.map((market) => <SettledPanel key={market.id} market={market} compact />)}
                </div>
              </details>
            )}
          </section>
        </>
      )}

      <section className="glass flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Latest signals</h2>
          <button className="quiet-link text-sm" onClick={() => router.push(`/results/${id}`)}>Ranks</button>
        </div>
        <div className="flex flex-col divide-y divide-[color:var(--brd-soft)]">
          {feedRows.length === 0 ? (
            <span className="py-4 text-center text-sm text-ink-faint">Waiting for live signals...</span>
          ) : (
            feedRows.map((e) => (
              <div
                key={e.index}
                className="grid grid-cols-[4px_1fr_auto] gap-3 py-2"
              >
                <span className="rounded-full" style={{ background: KIND_EDGE[e.kind] ?? "rgba(244,234,216,0.2)" }} />
                <span className="text-sm leading-snug text-ink-soft">{compactEventMessage(e)}</span>
                <span className="font-mono text-[10px] text-ink-faint">#{e.index}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="bottom-action">
        <div className="bottom-action-inner">
          <p className="py-3 text-center text-sm font-bold text-ink-faint">
            {streamState === "reconnecting" ? "Reconnecting stream..." : "Watching live"}
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, count, accent }: { title: string; count: number; accent: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="text-xs text-ink-faint">{accent}</p>
      </div>
      <span className="status-pill">{count}</span>
    </div>
  );
}

function findOwnColony(game: GameState | null | undefined, anonId: string): Colony | undefined {
  if (!game || !anonId) return undefined;
  const player = (game.players ?? []).find((candidate) => candidate.anonymousId === anonId);
  return (game.colonies ?? []).find((colony) => (
    Boolean(player?.colonyId && colony.colonyId === player.colonyId)
    || colony.playerAnonymousId === anonId
    || Boolean(player?.playerId && colony.playerId === player.playerId)
  ));
}

function PulseMetric({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "green" }) {
  const color = tone === "gold" ? "text-gold" : tone === "green" ? "text-green" : "text-ink";
  return (
    <div className="plate px-2 py-2">
      <p className="text-[11px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function MarketPanel({ market, compact = false }: { market: MarketModel; compact?: boolean }) {
  const distribution = aggregateVotes(market.votes);
  const pending = pendingAntCount(market, distribution.total);
  return (
    <article className="rounded-xl border border-[color:var(--brd-soft)] bg-black/18 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-gold">{marketLabelPrefix(market)}</p>
          <h3 className={`${compact ? "text-sm" : "text-base"} font-bold leading-snug`}>{cleanMarketLabel(market.label)}</h3>
        </div>
        <span className="rounded-full border border-gold/40 px-2 py-1 font-mono text-[10px] uppercase text-gold">open</span>
      </div>

      {distribution.rows.length ? (
        <Distribution distribution={distribution} />
      ) : (
        <OptionPreview opportunity={market.opportunity} />
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-ink-faint">
        <span className="rounded-full bg-[rgba(230,161,58,0.1)] px-2 py-1 text-gold">
          {distribution.voters ? `${distribution.voters} ants answered` : "Waiting for ants"}
        </span>
        <span className="rounded-full bg-black/25 px-2 py-1">
          {market.votes.length}/{Math.max(1, market.starts.length || market.votes.length)} colonies reported
        </span>
        {pending > 0 && <span className="rounded-full bg-black/25 px-2 py-1">{pending} calls pending</span>}
      </div>
    </article>
  );
}

function SettledPanel({ market, compact = false }: { market: MarketModel; compact?: boolean }) {
  const summary = settlementSummary(market);
  return (
    <article className="rounded-xl border border-[color:var(--brd-soft)] bg-black/18 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-ink-soft">{marketLabelPrefix(market)}</p>
          <h3 className={`${compact ? "text-sm" : "text-base"} font-bold leading-snug`}>{cleanMarketLabel(market.label)}</h3>
        </div>
        <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase ${summary.tone}`}>
          {summary.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <PulseMetric label="Food" value={summary.food > 0 ? `+${summary.food}` : 0} tone={summary.food > 0 ? "green" : undefined} />
        <PulseMetric label="Dead" value={summary.dead} />
        <PulseMetric label="Void" value={summary.voided} />
      </div>

      {!compact && (
        <div className="mt-3 flex flex-col gap-1">
          {[...market.settlements, ...market.voids].slice(0, 3).map((event) => (
            <p key={event.index} className="text-xs leading-snug text-ink-soft">{compactEventMessage(event)}</p>
          ))}
        </div>
      )}
    </article>
  );
}

function Distribution({ distribution }: { distribution: ReturnType<typeof aggregateVotes> }) {
  return (
    <div className="mt-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-black/35" aria-label={`Vote distribution, ${distribution.total} ants`}>
        {distribution.rows.map((row) => (
          <span
            key={row.key}
            style={{
              width: `${Math.max(4, Math.round((row.count / Math.max(1, distribution.total)) * 100))}%`,
              background: row.color,
            }}
          />
        ))}
      </div>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, distribution.rows.length)}, minmax(0, 1fr))` }}>
        {distribution.rows.slice(0, 3).map((row) => (
          <div key={row.key} className="rounded-lg border border-[color:var(--brd-soft)] px-2 py-2">
            <p className="truncate text-xs font-bold" style={{ color: row.color }}>{row.label}</p>
            <p className="font-mono text-xl font-bold">{row.count}</p>
            <p className="text-[11px] text-ink-faint">{Math.round((row.count / Math.max(1, distribution.total)) * 100)}%</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionPreview({ opportunity }: { opportunity?: Opportunity }) {
  const options = opportunity?.options ?? [];
  if (!options.length) {
    return <p className="mt-3 rounded-lg border border-[color:var(--brd-soft)] bg-black/20 p-3 text-sm text-ink-faint">Waiting for ant decisions...</p>;
  }
  return (
    <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, options.length)}, minmax(0, 1fr))` }}>
      {options.slice(0, 3).map((option) => (
        <div key={option.optionId || option.label} className="rounded-lg border border-[color:var(--brd-soft)] bg-black/20 p-2 text-center text-xs font-bold text-ink-soft">
          {option.label || option.value}
        </div>
      ))}
    </div>
  );
}

function RankCard({ mine, rank }: { mine?: Colony; rank: number }) {
  if (!mine) return <div className="glass p-4 text-center text-sm text-ink-faint">Create a colony to compete.</div>;
  return (
    <section className="glass grid grid-cols-4 gap-1 p-3 text-center">
      <Vital label="Rank" value={`#${rank}`} tone="gold" />
      <Vital label="Ants" value={mine.antsAlive} />
      <Vital label="Food" value={mine.food} tone="green" />
      <Vital label="Larvae" value={mine.larvae} />
    </section>
  );
}

function Vital({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "green" }) {
  const color = tone === "gold" ? "text-gold" : tone === "green" ? "text-green" : "text-ink";
  return (
    <div className="border-r border-[color:var(--brd-soft)] last:border-r-0">
      <p className="text-[11px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[color:var(--brd-soft)] p-4 text-center">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm text-ink-faint">{body}</p>
    </div>
  );
}

function buildMarkets(activeOpportunities: Opportunity[], events: GameEvent[]): MarketModel[] {
  const activeIds = new Set(activeOpportunities.map((opportunity) => opportunity.opportunityId).filter(Boolean));
  const map = new Map<string, MarketModel>();
  const sortedEvents = [...events].sort((a, b) => a.index - b.index);

  function ensure(id: string, label = "Market"): MarketModel {
    const existing = map.get(id);
    if (existing) return existing;
    const market: MarketModel = {
      id,
      label,
      status: "closed",
      starts: [],
      votes: [],
      predictions: [],
      settlements: [],
      voids: [],
      lastIndex: -1,
    };
    map.set(id, market);
    return market;
  }

  for (const opportunity of activeOpportunities) {
    if (!opportunity.opportunityId) continue;
    const market = ensure(opportunity.opportunityId, opportunity.label || opportunity.question || "Open market");
    market.opportunity = opportunity;
    market.label = opportunity.label || market.label;
    market.minute = minuteFromLabel(market.label);
  }

  for (const event of sortedEvents) {
    const opportunity = opportunityFromEvent(event);
    const opportunityId = opportunity?.opportunityId || eventOpportunityId(event);
    if (!opportunityId) continue;

    const market = ensure(opportunityId, opportunity?.label || event.message || "Market");
    market.lastIndex = Math.max(market.lastIndex, event.index);
    if (opportunity) {
      market.opportunity = opportunity;
      market.label = opportunity.label || market.label;
      market.minute = minuteFromLabel(market.label);
    }

    if (event.kind === "ant_agent_start") market.starts.push(event);
    if (event.kind === "ant_agent_vote" || event.kind === "vote") upsertVote(market.votes, event);
    if (event.kind === "prediction") market.predictions.push(event);
    if (event.kind === "settlement") market.settlements.push(event);
    if (event.kind === "void") market.voids.push(event);
  }

  return [...map.values()]
    .map((market) => {
      const marketStatus: MarketModel["status"] = activeIds.has(market.id)
        ? "open"
        : market.settlements.length
          ? "settled"
          : market.voids.length
            ? "void"
            : "closed";
      return { ...market, status: marketStatus };
    })
    .sort((a, b) => b.lastIndex - a.lastIndex);
}

function upsertVote(votes: GameEvent[], event: GameEvent) {
  const colonyId = String(event.data?.colonyId ?? event.index);
  const index = votes.findIndex((vote) => String(vote.data?.colonyId ?? vote.index) === colonyId);
  if (index < 0) {
    votes.push(event);
    return;
  }
  if (event.kind === "vote" || votes[index].kind !== "vote") votes[index] = event;
}

function aggregateVotes(votes: GameEvent[]) {
  const counts: Record<string, number> = {};
  const labels: Record<string, string> = {};
  let voters = 0;

  for (const event of votes) {
    const vote = event.data?.vote as PublicVote | undefined;
    if (!vote) continue;
    voters += vote.agentDecisionCount ?? vote.activeCount ?? 0;
    Object.assign(labels, vote.voteLabels ?? {});
    for (const [key, value] of Object.entries(vote.voteCounts ?? {})) {
      counts[key] = (counts[key] ?? 0) + Number(value || 0);
    }
  }

  const order = ["yes", "no", "option_a", "option_b", "option_c", "option_d", "abstain"];
  const keys = [...order.filter((key) => key in counts), ...Object.keys(counts).filter((key) => !order.includes(key))];
  const rows = keys
    .filter((key) => counts[key] > 0)
    .map((key, index) => ({
      key,
      label: shortVoteLabel(labels[key] || key),
      count: counts[key],
      color: voteColor(key, index),
    }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, total, voters };
}

function pendingAntCount(market: MarketModel, answered: number) {
  const expected = market.starts.reduce((sum, event) => sum + Number(event.data?.activeCount ?? 0), 0);
  return Math.max(0, expected - answered);
}

function settlementSummary(market: MarketModel) {
  let food = 0;
  let dead = 0;
  let voided = 0;
  let wins = 0;
  let losses = 0;

  for (const event of market.settlements) {
    if (event.data?.win) wins += 1;
    else losses += 1;
    food += Number(event.data?.food ?? 0);
    dead += Number(event.data?.dead ?? 0);
  }
  for (const event of market.voids) voided += Number(event.data?.ants ?? 0) || 1;

  const label = wins && !losses && !voided ? "won" : voided && !wins && !losses ? "void" : wins || losses ? "mixed" : "closed";
  const tone = label === "won"
    ? "border-green/50 text-green"
    : label === "void"
      ? "border-ink-faint/50 text-ink-faint"
      : "border-gold/50 text-gold";
  return { food, dead, voided, wins, losses, label, tone };
}

function opportunityFromEvent(event: GameEvent): Opportunity | undefined {
  const raw = event.data?.opportunity;
  return raw && typeof raw === "object" ? raw as Opportunity : undefined;
}

function eventOpportunityId(event: GameEvent): string | undefined {
  const direct = event.data?.opportunityId;
  if (typeof direct === "string") return direct;
  const vote = event.data?.vote as PublicVote | undefined;
  const marketId = (vote as { market?: { marketId?: unknown } } | undefined)?.market?.marketId;
  return typeof marketId === "string" ? marketId : undefined;
}

function minuteFromLabel(label?: string) {
  const match = label?.match(/^(\d+)'/);
  return match ? Number(match[1]) : undefined;
}

function marketLabelPrefix(market: MarketModel) {
  return market.minute != null ? `${market.minute}' window` : `#${market.lastIndex}`;
}

function cleanMarketLabel(label: string) {
  return label.replace(/^\d+'\s*-\s*/, "");
}

function shortVoteLabel(label: string) {
  return label
    .replace("do not commit this ant to this market", "abstain")
    .replace("before the deadline", "before deadline")
    .replace("in the next 10 min", "next 10 min");
}

function voteColor(key: string, index: number) {
  if (key === "abstain") return "#8f8370";
  if (key === "yes" || key === "option_a") return "#8fbd50";
  if (key === "no" || key === "option_b") return "#d96150";
  if (key === "option_c") return "#58b7aa";
  return index % 2 ? "#c9bca2" : "#e6a13a";
}

function compactEventMessage(event: GameEvent) {
  const message = event.message || event.kind;
  if (event.kind === "ant_agent_vote" || event.kind === "vote") {
    return message.replace(/^DeepSeek vote from /, "").replace(/Will there be /, "Will ");
  }
  if (event.kind === "settlement") return message.replace(/^Result /, "");
  return `${kindIcon(event.kind)} ${message}`;
}

function formatClock(ms: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function isUsefulLiveEvent(e: GameEvent) {
  return ["opportunity", "settlement", "void", "hatch", "starvation", "game_error", "game_started", "markets_closed", "live_sync"].includes(e.kind) || isMatchEvent(e);
}
