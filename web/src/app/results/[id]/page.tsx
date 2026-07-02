"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import type { GameState } from "@/lib/types";

export default function ResultsPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const myColonyId = useStore((s) => s.myColonyId);
  const [game, setLocal] = useState<GameState | null>(null);

  useEffect(() => {
    api.getGame(id).then(setLocal).catch(() => {});
  }, [id]);

  const running = game ? ["running_replay", "running_live"].includes(game.status) : false;
  useGameStream(id, { onState: setLocal }, running);

  const cols = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => (b.score || 0) - (a.score || 0)), [game]);
  const finished = game?.status === "finished";

  async function rerun() {
    try {
      const g = await api.rerun(id);
      setLocal(g);
      router.push(`/cockpit/${g.gameId}`);
    } catch { /* */ }
  }
  async function share() {
    const idx = cols.findIndex((c) => c.colonyId === myColonyId);
    const mine = idx >= 0 ? cols[idx] : cols[0];
    const text = mine
      ? `🐜 My colony "${mine.name}" finished #${(idx < 0 ? 0 : idx) + 1}/${cols.length} with ${mine.score ?? 0} pts in Age of Colony!`
      : "🐜 Age of Colony — command your colony, predict the match, rule the lobby!";
    try {
      if (navigator.share) await navigator.share({ title: "Age of Colony", text, url: location.href });
      else await navigator.clipboard.writeText(`${text} ${location.href}`);
    } catch { /* */ }
  }

  const podium = [1, 0, 2];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <button className="text-sm font-semibold text-ink-soft" onClick={() => router.back()}>← Back</button>
        {finished && (
          <div className="flex gap-2">
            <button className="btn btn-magenta !min-h-0 !w-auto px-3 py-1 text-sm" onClick={share}>Share</button>
            <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={rerun}>↻ Rerun</button>
          </div>
        )}
      </div>
      <h1 className="hud-title text-[13px]">{finished ? "Final standings" : "Live rankings"}</h1>

      <div className="glass p-4">
        <div className="mb-3 flex items-end justify-center gap-2.5">
          {podium.map((pos) => {
            const c = cols[pos];
            const heights = ["h-14", "h-[76px]", "h-10"];
            return (
              <div key={pos} className="flex max-w-[110px] flex-1 flex-col items-center gap-1.5 text-center">
                {c ? (
                  <>
                    <div className={`grid h-11 w-11 place-items-center rounded-full border-2 ${pos === 0 ? "border-lime" : "border-brd"} text-xl`}>{pos === 0 ? "👑" : "🐜"}</div>
                    <div className="text-xs font-bold">{c.name}</div>
                    <div className="font-mono text-sm text-cyan">{c.score ?? 0}</div>
                    <div className={`w-full rounded-t-lg border border-brd bg-parch-strong ${heights[pos]} ${pos === 0 ? "shadow-[3px_3px_0_rgba(74,58,30,0.25)]" : ""}`} />
                  </>
                ) : (
                  <div />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2">
          {cols.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">No colonies yet.</span>
          ) : (
            cols.map((c, i) => (
              <div key={c.colonyId} className={`glass flex items-center gap-3 px-3.5 py-3 ${c.colonyId === myColonyId ? "!border-lime shadow-[3px_3px_0_rgba(74,58,30,0.25)]" : ""}`}>
                <span className="w-7 font-display text-[13px] text-ink-soft">#{i + 1}</span>
                <span className="flex-1 font-bold">{c.name}</span>
                <span className="font-mono text-xs text-ink-faint">{c.antsAlive ?? 0}🐜</span>
                <span className="font-mono text-xs text-ink-faint">{c.accuracy != null ? Math.round(c.accuracy * 100) + "%" : "—"}</span>
                <span className="font-mono font-bold text-cyan">{c.score ?? 0}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <button className="btn btn-primary" onClick={() => router.push("/lobby")}>Play next match</button>
    </div>
  );
}
