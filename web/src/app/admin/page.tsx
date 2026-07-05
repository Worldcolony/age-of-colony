"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { flag, teamName, fixtureId } from "@/lib/format";
import type { Fixture } from "@/lib/types";

const ADMIN_TOKEN_STORAGE_KEY = "aoc_admin_token";
const REPLAY_SPEED = { replayDelaySeconds: 0.8, replayTimeScale: 120 };
const ADMIN_COLONIES = [
  { name: "Red Nest", size: 10, style: "cautious", favoriteContext: "penalties", infoNeed: "high" },
  { name: "Amber Swarm", size: 20, style: "balanced", favoriteContext: "momentum", infoNeed: "medium" },
  { name: "Black Rush", size: 50, style: "aggressive", favoriteContext: "chaos", infoNeed: "low" },
] as const;

export default function AdminPage() {
  const router = useRouter();
  const resetGame = useStore((s) => s.resetGame);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [adminToken, setAdminToken] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "" : "",
  );
  const [msg, setMsg] = useState("");

  const protectedAdmin = Boolean(health?.adminToolsProtected);
  const requestToken = adminToken.trim();
  const canUseAdmin = !protectedAdmin || Boolean(requestToken);

  async function loadRecent(token = requestToken, shouldProtect = protectedAdmin) {
    if (shouldProtect && !token) {
      setFixtures([]);
      setMsg("Enter the admin token to load replay tools.");
      return;
    }
    try {
      const d = await api.recentFixtures({ days: 14, limit: 40 }, token || undefined);
      setFixtures(d.fixtures ?? []);
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  useEffect(() => {
    let cancelled = false;

    api.health()
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        const shouldProtect = Boolean(h.adminToolsProtected);
        if (!shouldProtect || requestToken) loadRecent(requestToken, shouldProtect);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveToken() {
    const token = adminToken.trim();
    if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    loadRecent(token);
  }

  async function demo() {
    setMsg("Starting demo…");
    try {
      const g = await api.demoRun({}, requestToken || undefined);
      resetGame();
      router.push(`/cockpit/${g.gameId}`);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function runPrev() {
    setMsg("Finding latest completed fixture...");
    try {
      const g = await api.runPrevious({
        days: 14,
        limit: 50,
        stream: true,
        ...REPLAY_SPEED,
      }, requestToken || undefined);
      resetGame();
      router.push(`/cockpit/${g.gameId}`);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function replay(f: Fixture) {
    const id = fixtureId(f);
    if (!id) return;
    resetGame();
    setMatchFixture(f);
    try {
      const g = await api.createGame({ fixtureId: id, participant1: f.participant1 ?? null, participant2: f.participant2 ?? null });
      for (const colony of ADMIN_COLONIES) {
        await api.addColony(g.gameId, colony, requestToken || undefined);
      }
      const replayGame = await api.startGame(g.gameId, "replay", {
        ...REPLAY_SPEED,
        adminToken: requestToken || undefined,
      });
      router.push(`/cockpit/${replayGame.gameId}`);
    } catch (e) { setMsg((e as Error).message); }
  }

  const tx = health?.txlineConfigured;
  const or = health?.openrouterConfigured;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="hud-title text-[13px]">Admin</h1>
      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-[11px]">Backend</h2>
        <div className="flex gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${tx ? "border-lime/40 text-lime" : "border-danger/40 text-danger"}`}>TXLine {tx ? "✓" : "✗"}</span>
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${or ? "border-lime/40 text-lime" : "border-danger/40 text-danger"}`}>OpenRouter {or ? "✓" : "✗"}</span>
          {protectedAdmin && <span className="rounded-full border border-gold/40 px-3 py-1 text-xs font-bold text-gold">Admin locked</span>}
        </div>
        {health && !or && <p className="text-xs text-ink-faint">Set OPENROUTER_API_KEY to start games / demo.</p>}
      </div>

      {protectedAdmin && (
        <div className="glass flex flex-col gap-3 p-4">
          <h2 className="hud-title text-[11px]">Admin access</h2>
          <div className="flex gap-2">
            <input
              className="input font-mono"
              placeholder="AOC_ADMIN_TOKEN"
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
            />
            <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={saveToken}>Unlock</button>
          </div>
        </div>
      )}

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-[11px]">Quick actions</h2>
        <button className="btn btn-primary" disabled={!canUseAdmin} onClick={demo}>▶ Run demo match</button>
        <button className="btn btn-ghost" disabled={!canUseAdmin} onClick={runPrev}>Watch latest completed fixture</button>
      </div>

      {msg && <p className="text-sm text-ink-soft">{msg}</p>}
      <div className="flex items-center justify-between">
        <h2 className="hud-title text-[11px]">Recent fixtures</h2>
        <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" disabled={!canUseAdmin} onClick={() => loadRecent()}>↻</button>
      </div>
      {fixtures.slice(0, 25).map((f) => {
        const p1 = teamName(f.participant1), p2 = teamName(f.participant2);
        return (
          <div key={String(fixtureId(f))} className="glass flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold"><span className="text-2xl">{flag(p1)}</span>{p1}</div>
              <span className="font-mono text-xs text-ink-faint">VS</span>
              <div className="flex flex-row-reverse items-center gap-2 font-bold"><span className="text-2xl">{flag(p2)}</span>{p2}</div>
            </div>
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={!canUseAdmin} onClick={() => replay(f)}>Replay with admin colonies</button>
          </div>
        );
      })}
    </div>
  );
}
