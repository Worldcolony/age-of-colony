"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { Segmented, Chips } from "@/components/Segmented";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, FavoriteContext, InfoNeed, Style } from "@/lib/types";

const RUNNING = new Set(["running_replay", "running_live"]);
// feed row left-edge tint by event kind (amber = markets, lichen = wins, clay = votes, red = trouble)
const KIND_EDGE: Record<string, string> = {
  opportunity: "#d8943a", markets_closed: "#d8943a",
  settlement: "#92b85f", hatch: "#92b85f", info_result: "#92b85f",
  vote: "#c76e3a", ant_agent_vote: "#c76e3a", prediction: "#c76e3a",
  game_error: "#ef5f49", starvation: "#ef5f49", void: "#ef5f49",
};

export default function CockpitPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const myColonyId = useStore((s) => s.myColonyId);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const mf = useStore((s) => s.matchFixture);

  const [events, setEvents] = useState<GameEvent[]>([]);
  const [feedTab, setFeedTab] = useState<"match" | "colony">("match");
  const [starting, setStarting] = useState(false);
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
    setEvents((prev) => [e, ...prev].slice(0, 120));
  }

  useGameStream(id, {
    onEvent: addEvent,
    onState: (g) => setGame(g),
  });

  const sorted = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => (b.score || 0) - (a.score || 0)), [game?.colonies]);
  const myIdx = sorted.findIndex((c) => c.colonyId === myColonyId);
  const mine = myIdx >= 0 ? sorted[myIdx] : sorted[0];

  async function start() {
    setStarting(true);
    try {
      const g = await api.startGame(id, "live").catch(() => api.startGame(id, "replay"));
      setGame(g);
    } finally {
      setStarting(false);
    }
  }

  async function patchStrategy(patch: { style?: Style; favoriteContext?: FavoriteContext; infoNeed?: InfoNeed }) {
    if (!mine) return;
    try {
      const g = await api.updateStrategy(id, mine.colonyId, patch);
      setGame(g);
    } catch { /* */ }
  }

  const p1 = teamName(mf?.participant1 ?? game?.participant1);
  const p2 = teamName(mf?.participant2 ?? game?.participant2);
  const status = game?.status ?? "";
  const locked = status === "finished";
  const feedRows = events.filter((e) => (feedTab === "match" ? isMatchEvent(e) : !isMatchEvent(e)));

  return (
    <div className="flex flex-col gap-3">
      {/* sticky score bar — always visible while scrolling the console */}
      <div className="sticky top-2 z-30 flex flex-col gap-2">
        <div className="glass bracket signal-brand flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 font-bold"><span className="text-2xl">{flag(p1)}</span><span className="truncate">{p1}</span></div>
            <div className="plate px-3 py-1 font-display text-[20px] text-gold">{fmtScore(game?.match?.score)}</div>
            <div className="flex min-w-0 flex-row-reverse items-center gap-2 font-bold"><span className="text-2xl">{flag(p2)}</span><span className="truncate">{p2}</span></div>
          </div>
          <div className="flex items-center justify-between">
            <button className="text-xs font-bold text-ink-soft" onClick={() => router.push("/lobby")}>← Lobby</button>
            <span className={`flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] ${RUNNING.has(status) ? "border-lime/50 text-lime" : status === "finished" ? "border-green/50 text-green" : "border-brd text-ink-faint"}`}>
              {RUNNING.has(status) && <span className="live-dot" />}
              {status === "created" ? "warming up" : status.replace("_", " ") || "…"}
            </span>
            <button className="text-xs font-bold text-amber" onClick={() => router.push(`/results/${id}`)}>Ranks →</button>
          </div>
        </div>
      </div>

      {status === "created" && (
        <button className="btn btn-primary" disabled={starting} onClick={start}>{starting ? "Starting…" : "Start match"}</button>
      )}

      <RankCard mine={mine} rank={(myIdx < 0 ? 0 : myIdx) + 1} />

      {(game?.activeOpportunities ?? []).map((o, i) => (
        <div key={i} className="glass tunnel-map flex flex-col gap-2.5 border-l-4 border-l-gold p-4">
          <span className="flex w-fit items-center gap-1.5 rounded-md border border-magenta/40 px-3 py-1 text-xs font-bold text-magenta"><span className="live-dot" />{(o.kind || "market").toUpperCase()}</span>
          <div className="font-bold">{o.label || o.question || "New market"}</div>
          <div className="flex flex-wrap gap-2">
            {(o.options || []).map((op, j) => (
              <div key={j} className="plate flex-1 p-2.5 text-center text-sm font-bold">{op.label || op.value}</div>
            ))}
          </div>
        </div>
      ))}

      <h2 className="hud-title text-[22px]">Strategy board</h2>
      {mine ? (
        <div className="glass flex flex-col gap-3.5 p-4">
          <SbRow label="Style">
            <Segmented options={[{ value: "cautious", label: "🛡️ cautious" }, { value: "balanced", label: "⚖️ balanced" }, { value: "aggressive", label: "⚔️ aggressive" }]} value={mine.style} onChange={(v) => patchStrategy({ style: v })} />
          </SbRow>
          <SbRow label="Favorite ground">
            <Chips options={["balanced", "penalties", "corners", "momentum", "chaos"] as FavoriteContext[]} value={mine.favoriteContext} onChange={(v) => patchStrategy({ favoriteContext: v })} />
          </SbRow>
          <SbRow label="Info need">
            <Segmented options={[{ value: "low", label: "🕯️ low" }, { value: "medium", label: "🔎 medium" }, { value: "high", label: "📡 high" }]} value={mine.infoNeed} onChange={(v) => patchStrategy({ infoNeed: v })} />
          </SbRow>
          <p className="text-[11px] text-ink-faint">{locked ? "Match finished." : "Changes take effect on the next market."}</p>
        </div>
      ) : (
        <div className="glass p-4 text-center text-sm text-ink-faint">Deploy a colony to tune it.</div>
      )}

      <div className="glass flex flex-col gap-3 p-4">
        <div className="seg">
          {(["match", "colony"] as const).map((t) => (
            <button key={t} type="button" data-active={feedTab === t} onClick={() => setFeedTab(t)}>
              {t === "match" ? "⚽ Match" : "🐜 Colony"}
            </button>
          ))}
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {feedRows.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">Waiting for events…</span>
          ) : (
            feedRows.map((e) => (
              <div
                key={e.index}
                className="plate flex items-start gap-2.5 border-l-4 px-3 py-2.5"
                style={{ borderLeftColor: KIND_EDGE[e.kind] ?? "rgba(146,184,95,0.4)" }}
              >
                <span className="text-lg">{kindIcon(e.kind)}</span>
                <span className="flex-1 text-[13px] leading-snug">{e.message || e.kind}</span>
                <span className="font-mono text-[10px] text-ink-faint">#{e.index}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function RankCard({ mine, rank }: { mine?: Colony; rank: number }) {
  if (!mine) return <div className="glass p-4 text-center text-sm text-ink-faint">Deploy a colony to compete.</div>;
  return (
    <div className="glass tunnel-map flex items-center gap-3.5 p-4">
      <div className="font-display text-3xl text-lime" style={{ textShadow: "0 0 16px rgba(146,184,95,0.32)" }}>#{rank}</div>
      <div className="flex flex-1 flex-col gap-2">
        <div className="flex items-center justify-between">
          <strong>{mine.name}</strong>
          <span className="font-mono text-ink-soft">{mine.score ?? 0} pts</span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Vital icon="🐜" v={mine.antsAlive} l="alive" />
          <Vital icon="🤕" v={mine.antsWounded} l="hurt" />
          <Vital icon="🍞" v={mine.food} l="food" />
          <Vital icon="🥚" v={mine.larvae} l="larvae" />
          <Vital icon="🎯" v={mine.accuracy != null ? Math.round(mine.accuracy * 100) + "%" : "—"} l="acc" />
        </div>
      </div>
    </div>
  );
}
function Vital({ icon, v, l }: { icon: string; v: number | string; l: string }) {
  return (
    <span className="plate flex items-center gap-1 px-2.5 py-1">
      <span>{icon}</span><b className="font-mono">{v}</b><span className="text-ink-faint">{l}</span>
    </span>
  );
}
function SbRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-bold uppercase tracking-wider text-ink-soft">{label}</label>
      {children}
    </div>
  );
}
