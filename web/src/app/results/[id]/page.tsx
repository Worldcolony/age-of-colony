"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { colonySugar } from "@/lib/sugar";
import { legacyAnonymousIdForHost, usePlayerIdentity } from "@/lib/playerIdentity";
import type { GameState } from "@/lib/types";

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={<div className="grid min-h-[70dvh] place-items-center text-sm font-bold text-ink-faint">Loading rankings...</div>}>
      <ResultsRun key={id} id={id} />
    </Suspense>
  );
}

function ResultsRun({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const identity = usePlayerIdentity();
  const myColonyId = useStore((s) => s.myColonyId);
  const storedGame = useStore((s) => s.game);
  const setStoredGame = useStore((s) => s.setGame);
  const [game, setLocal] = useState<GameState | null>(
    storedGame?.gameId === id ? storedGame : null,
  );
  const receiveGame = useCallback((next: GameState) => {
    setLocal(next);
    setStoredGame(next);
  }, [setStoredGame]);

  useEffect(() => {
    let cancelled = false;
    api.getGame(id).then((next) => {
      if (!cancelled) receiveGame(next);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, receiveGame]);

  const running = game ? ["running_replay", "running_live"].includes(game.status) : false;
  useGameStream(id, { onState: receiveGame }, running);

  const cols = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => colonySugar(b) - colonySugar(a)), [game]);
  const finished = game?.status === "finished";
  const adminContext = game
    ? game.roomKind === "admin"
    : searchParams.get("from") === "admin";
  const cockpitHref = adminContext ? `/cockpit/${id}?from=admin` : `/cockpit/${id}`;

  async function rerun() {
    try {
      const g = await api.rerun(id, {
        anonymousId: adminContext ? undefined : legacyAnonymousIdForHost(game, identity.snapshot),
      });
      receiveGame(g);
      router.push(adminContext ? `/cockpit/${g.gameId}?from=admin` : `/cockpit/${g.gameId}`);
    } catch { /* */ }
  }
  async function share() {
    const idx = cols.findIndex((c) => c.colonyId === myColonyId);
    const mine = idx >= 0 ? cols[idx] : cols[0];
    const text = mine
      ? `🍬 My colony "${mine.name}" finished #${(idx < 0 ? 0 : idx) + 1}/${cols.length} with ${colonySugar(mine)} Sugar in Age of Colony!`
      : "🐜 Age of Colony — ants vote, consensus enters, most Sugar wins!";
    try {
      if (navigator.share) await navigator.share({ title: "Age of Colony", text, url: location.href });
      else await navigator.clipboard.writeText(`${text} ${location.href}`);
    } catch { /* */ }
  }

  const podium = [1, 0, 2];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <button
          className="text-sm font-semibold text-ink-soft"
          onClick={() => adminContext ? router.push(cockpitHref) : router.back()}
        >
          ← Back
        </button>
        {finished && (
          <div className="flex gap-2">
            <button className="btn btn-magenta !min-h-0 !w-auto px-3 py-1 text-sm" onClick={share}>Share</button>
            <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={rerun}>↻ Rerun</button>
          </div>
        )}
      </div>
      <div>
        <h1 className="hud-title text-[13px]">{finished ? "Final Sugar standings" : "Live Sugar rankings"}</h1>
        <p className="mt-1 text-sm text-ink-faint">Colonies are ranked by Sugar. Most Sugar wins.</p>
      </div>

      <div className="glass p-4">
        <div className="mb-3 flex items-end justify-center gap-2.5">
          {podium.map((pos) => {
            const c = cols[pos];
            const heights = ["h-14", "h-[76px]", "h-10"];
            const tints = ["pod-silver", "pod-gold", "pod-bronze"]; // visual order: 2nd, 1st, 3rd
            const tint = pos === 0 ? tints[1] : pos === 1 ? tints[0] : tints[2];
            return (
              <div key={pos} className="flex max-w-[110px] flex-1 flex-col items-center gap-1.5 text-center">
                {c ? (
                  <>
                    <div className={`plate grid h-11 w-11 place-items-center text-xl ${pos === 0 ? "!border-gold" : ""}`}>{pos === 0 ? "👑" : "🐜"}</div>
                    <div className="max-w-full truncate text-xs font-bold">{c.name}</div>
                    <div className="font-mono text-sm font-bold text-gold-deep">🍬 {colonySugar(c)}</div>
                    <div className={`w-full rounded-t-md border-2 ${heights[pos]} ${tint} shadow-[2px_2px_0_rgba(74,58,30,0.3)]`}>
                      <span className="hud-title block pt-1 text-[10px] text-[#5a4a20]">{pos + 1}</span>
                    </div>
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
                <span className="hidden text-xs text-ink-faint sm:inline">{temperamentLabel(c.style)} temperament</span>
                <span className="font-mono font-bold text-green">🍬 {colonySugar(c)} Sugar</span>
              </div>
            ))
          )}
        </div>
      </div>

      <button className="btn btn-primary" onClick={() => router.push(adminContext ? "/admin" : "/lobby")}>
        {adminContext ? "Back to admin" : "Play next match"}
      </button>
    </div>
  );
}

function temperamentLabel(style: string): string {
  if (style === "cautious") return "Careful";
  if (style === "aggressive") return "Bold";
  return "Steady";
}
