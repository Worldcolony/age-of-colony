"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { Segmented, Chips } from "@/components/Segmented";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, FavoriteContext, InfoNeed, Style } from "@/lib/types";
import { worldBus } from "@/three/worldBus";

const RUNNING = new Set(["running_replay", "running_live"]);
const PULSE: Record<string, number> = { opportunity: 3, vote: 1.4, ant_agent_vote: 1.4, settlement: 2.4, hatch: 1.6, game_started: 3 };

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
    if (PULSE[e.kind]) worldBus.pulse(PULSE[e.kind]);
    setEvents((prev) => [e, ...prev].slice(0, 120));
  }

  useGameStream(id, {
    onEvent: addEvent,
    onState: (g) => setGame(g),
  });

  const walletAccent = useStore((s) => s.wallet.accent);
  useEffect(() => {
    worldBus.setAccent(walletAccent || "#b6ff3c");
  }, [walletAccent]);
  useEffect(() => {
    worldBus.setIntensity(RUNNING.has(game?.status ?? "") ? 0.9 : 0.4);
  }, [game?.status]);

  const colonies = game?.colonies ?? [];
  const sorted = useMemo(() => [...colonies].sort((a, b) => (b.score || 0) - (a.score || 0)), [colonies]);
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
      <div className="flex items-center justify-between">
        <button className="text-sm font-semibold text-ink-soft" onClick={() => router.push("/lobby")}>← Lobby</button>
        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${RUNNING.has(status) ? "border-magenta/40 text-magenta" : status === "finished" ? "border-lime/40 text-lime" : "border-white/10 text-ink-faint"}`}>
          {status.replace("_", " ") || "…"}
        </span>
      </div>

      <div className="glass flex flex-col gap-3 !bg-white/[0.06] p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold"><span className="text-2xl">{flag(p1)}</span>{p1}</div>
          <span className="font-mono text-xs text-amber">LIVE</span>
          <div className="flex flex-row-reverse items-center gap-2 font-bold"><span className="text-2xl">{flag(p2)}</span>{p2}</div>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-display text-xl tracking-wider">{fmtScore(game?.match?.score)}</span>
          <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={() => router.push(`/results/${id}`)}>Rankings →</button>
        </div>
      </div>

      {status === "created" && (
        <button className="btn btn-primary" disabled={starting} onClick={start}>{starting ? "Starting…" : "▶ Start match"}</button>
      )}

      <RankCard mine={mine} rank={(myIdx < 0 ? 0 : myIdx) + 1} />

      {(game?.activeOpportunities ?? []).map((o, i) => (
        <div key={i} className="glass flex flex-col gap-2.5 border border-white/25 p-4" style={{ boxShadow: "0 0 18px rgba(56,232,255,0.4)" }}>
          <span className="flex w-fit items-center gap-1.5 rounded-full border border-magenta/40 px-3 py-1 text-xs font-bold text-magenta"><span className="live-dot" />{(o.kind || "market").toUpperCase()}</span>
          <div className="font-bold">{o.label || o.question || "New market"}</div>
          <div className="flex flex-wrap gap-2">
            {(o.options || []).map((op, j) => (
              <div key={j} className="flex-1 rounded-lg border border-white/10 bg-black/30 p-2.5 text-center text-sm font-bold">{op.label || op.value}</div>
            ))}
          </div>
        </div>
      ))}

      <h2 className="hud-title text-sm">🎛️ Soundboard</h2>
      {mine ? (
        <div className="glass flex flex-col gap-3.5 p-4">
          <SbRow label="Style">
            <Segmented options={[{ value: "cautious", label: "cautious" }, { value: "balanced", label: "balanced" }, { value: "aggressive", label: "aggressive" }]} value={mine.style} onChange={(v) => patchStrategy({ style: v })} />
          </SbRow>
          <SbRow label="Favorite ground">
            <Chips options={["balanced", "penalties", "corners", "momentum", "chaos"] as FavoriteContext[]} value={mine.favoriteContext} onChange={(v) => patchStrategy({ favoriteContext: v })} />
          </SbRow>
          <SbRow label="Info need">
            <Segmented options={[{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }]} value={mine.infoNeed} onChange={(v) => patchStrategy({ infoNeed: v })} />
          </SbRow>
          <p className="text-[11px] text-ink-faint">{locked ? "Match finished." : "Changes take effect on the next market."}</p>
        </div>
      ) : (
        <div className="glass p-4 text-center text-sm text-ink-faint">Deploy a colony to tune it.</div>
      )}

      <div className="glass flex flex-col gap-3 p-4">
        <div className="flex gap-2">
          {(["match", "colony"] as const).map((t) => (
            <button key={t} className="flex-1 rounded-lg border border-white/10 bg-black/25 py-2 text-xs font-bold data-[a=true]:border-cyan/40 data-[a=true]:text-cyan" data-a={feedTab === t} onClick={() => setFeedTab(t)}>
              {t === "match" ? "Match" : "Colony"}
            </button>
          ))}
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {feedRows.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">Waiting for events…</span>
          ) : (
            feedRows.map((e) => (
              <div key={e.index} className="flex items-start gap-2.5 rounded-xl border-l-2 border-white/25 bg-black/25 px-3 py-2.5">
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
    <div className="glass flex items-center gap-3.5 p-4">
      <div className="font-display text-2xl text-lime" style={{ textShadow: "0 0 18px rgba(182,255,60,0.55)" }}>#{rank}</div>
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
    <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2.5 py-1">
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
