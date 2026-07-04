"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, Opportunity } from "@/lib/types";
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
  voteCounts?: Record<string, number>;
  voteLabels?: Record<string, string>;
  predictions?: Record<string, number>;
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
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await api.getGame(id);
        if (cancelled) return;
        setGame(g);
        if (!myColonyId && g.colonies[0]) setMyColonyId(g.colonies[0].colonyId);
        if (!RUNNING.has(g.status)) {
          const rep = await api.getReplay(id).catch(() => null);
          rep?.events?.forEach(addEvent);
        }
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function addEvent(e: GameEvent) {
    if (seen.current.has(e.index)) return;
    seen.current.add(e.index);
    if (PULSE[e.kind]) worldBus.pulse(PULSE[e.kind]);
    setEvents((prev) => [e, ...prev].slice(0, 120));
  }

  useGameStream(id, {
    onEvent: addEvent,
    onState: (g) => setGame(g),
  });

  const walletAccent = useStore((s) => s.wallet.accent);
  useEffect(() => {
    worldBus.setAccent(walletAccent || "#e6a13a");
  }, [walletAccent]);
  useEffect(() => {
    worldBus.setIntensity(RUNNING.has(game?.status ?? "") ? 0.9 : 0.4);
  }, [game?.status]);

  const sorted = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => (b.score || 0) - (a.score || 0)), [game?.colonies]);
  const myIdx = sorted.findIndex((c) => c.colonyId === myColonyId);
  const mine = myIdx >= 0 ? sorted[myIdx] : sorted[0];
  const rank = (myIdx < 0 ? 0 : myIdx) + 1;
  const p1 = teamName(mf?.participant1 ?? game?.participant1);
  const p2 = teamName(mf?.participant2 ?? game?.participant2);
  const status = game?.status ?? "";
  const activeOpportunities = game?.activeOpportunities ?? [];
  const feedRows = events.filter((e) => isUsefulLiveEvent(e)).slice(0, 7);

  function latestVoteFor(opportunityId?: string): PublicVote | null {
    if (!opportunityId) return null;
    for (const event of events) {
      if (!["ant_agent_vote", "vote"].includes(event.kind)) continue;
      if (event.data?.opportunityId !== opportunityId) continue;
      const vote = event.data?.vote as PublicVote | undefined;
      if (vote) return vote;
    }
    return null;
  }

  return (
    <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-4">
      <header className="page-top">
        <button className="icon-btn" aria-label="Back" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>←</button>
        <h1 className="text-xl font-bold">Live</h1>
        <span className={`status-pill ${RUNNING.has(status) ? "!border-rust/50 !text-rust" : ""}`}>
          {RUNNING.has(status) && <span className="live-dot" />}
          {status === "created" ? "Not started" : status.replace("_", " ") || "Live"}
        </span>
      </header>

      <section className="glass match-card-media flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="plate grid h-11 w-14 place-items-center text-2xl">{flag(p1)}</span>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-2xl font-bold">{p1} <span className="text-4xl text-gold">{fmtScore(game?.match?.score)}</span> {p2}</p>
            <p className="font-mono text-sm text-cyan">{game?.match?.possessionLabel || "Watching live"}</p>
          </div>
          <span className="plate grid h-11 w-14 place-items-center text-2xl">{flag(p2)}</span>
        </div>
      </section>

      {status === "created" ? (
        <section className="glass flex flex-col gap-3 p-4 text-center">
          <h2 className="text-lg font-bold">Room is not live yet</h2>
          <p className="text-sm text-ink-soft">Start the match from the room once every player has a colony.</p>
          <button className="btn btn-primary" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>
            Back to room
          </button>
        </section>
      ) : activeOpportunities.length ? (
        activeOpportunities.map((op) => <MarketCard key={op.opportunityId || op.label || op.question} opportunity={op} vote={latestVoteFor(op.opportunityId)} />)
      ) : (
        <section className="glass flex flex-col gap-2 p-4">
          <p className="status-pill">No market open</p>
          <h2 className="text-lg font-bold">Waiting for the next prediction moment</h2>
          <p className="text-sm text-ink-soft">Your ants will vote automatically when the engine opens a market.</p>
        </section>
      )}

      <RankCard mine={mine} rank={rank} />

      <section className="glass flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Match feed</h2>
          <button className="quiet-link text-sm" onClick={() => router.push(`/results/${id}`)}>View ranks</button>
        </div>
        <div className="flex max-h-80 flex-col divide-y divide-[color:var(--brd-soft)] overflow-y-auto">
          {feedRows.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">Waiting for events...</span>
          ) : (
            feedRows.map((e) => (
              <div
                key={e.index}
                className="flex items-start gap-3 border-l-4 px-1 py-3"
                style={{ borderLeftColor: KIND_EDGE[e.kind] ?? "rgba(244,234,216,0.2)" }}
              >
                <span className="text-lg">{kindIcon(e.kind)}</span>
                <span className="flex-1 text-sm leading-snug text-ink-soft">{e.message || e.kind}</span>
                <span className="font-mono text-[10px] text-ink-faint">#{e.index}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="bottom-action">
        <div className="bottom-action-inner">
          <p className="py-3 text-center text-sm font-bold text-ink-faint">Watching live</p>
        </div>
      </div>
    </div>
  );
}

function MarketCard({ opportunity, vote }: { opportunity: Opportunity; vote: PublicVote | null }) {
  const rows = voteRows(vote);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const answered = vote?.agentDecisionCount ?? vote?.activeCount ?? total;
  return (
    <section className="glass flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold">{opportunity.label || "Next prediction window"}</p>
          {opportunity.question && <p className="text-sm text-ink-soft">{opportunity.question}</p>}
        </div>
        {opportunity.deadlineLabel && <span className="status-pill">{opportunity.deadlineLabel}</span>}
      </div>

      <div className="flex items-center gap-2 text-gold">
        <span>🐜</span>
        <strong>{answered ? `${answered} ants voted automatically` : "Ants voting automatically"}</strong>
      </div>

      {rows.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex h-3 overflow-hidden rounded-full bg-black/30">
            {rows.map((row) => (
              <span
                key={row.key}
                className={row.className}
                style={{ width: `${Math.max(4, Math.round((row.count / Math.max(1, total)) * 100))}%` }}
              />
            ))}
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
            {rows.map((row) => (
              <div key={row.key} className="border-r border-[color:var(--brd-soft)] last:border-r-0">
                <p className={row.textClass}>{row.label}</p>
                <p className="font-mono text-xl font-bold">{Math.round((row.count / Math.max(1, total)) * 100)}%</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, opportunity.options?.length || 1)}, minmax(0, 1fr))` }}>
          {(opportunity.options || [{ label: "Waiting" }]).map((op, index) => (
            <div key={op.optionId || op.value || op.label || index} className="rounded-lg border border-[color:var(--brd-soft)] bg-black/20 p-3 text-center text-sm font-bold text-ink-soft">
              {op.label || op.value}
            </div>
          ))}
        </div>
      )}

      <p className="text-sm font-bold text-gold">{rows.length ? "Waiting for result" : "Waiting for ants"}</p>
    </section>
  );
}

function RankCard({ mine, rank }: { mine?: Colony; rank: number }) {
  if (!mine) return <div className="glass p-4 text-center text-sm text-ink-faint">Create a colony to compete.</div>;
  return (
    <section className="glass grid grid-cols-4 gap-1 p-4 text-center">
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
      <p className="text-xs font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function voteRows(vote: PublicVote | null) {
  const counts = vote?.voteCounts || {};
  const labels = vote?.voteLabels || {};
  const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
  return entries.map(([key, count], index) => {
    const normalized = key.toLowerCase();
    const label = labels[key] || (normalized === "option_a" ? "Option A" : normalized === "option_b" ? "Option B" : key);
    const isYes = normalized === "yes" || normalized === "option_a";
    const isNo = normalized === "no" || normalized === "option_b";
    return {
      key,
      label: label.replace(/^vote\s+/i, ""),
      count: Number(count),
      className: isYes ? "bg-green" : isNo ? "bg-rust" : index === 2 ? "bg-ink-faint" : "bg-gold",
      textClass: isYes ? "font-bold text-green" : isNo ? "font-bold text-rust" : "font-bold text-ink-soft",
    };
  });
}

function isUsefulLiveEvent(e: GameEvent) {
  return ["opportunity", "vote", "ant_agent_vote", "settlement", "void", "hatch", "starvation", "game_error", "game_started", "markets_closed"].includes(e.kind) || isMatchEvent(e);
}
