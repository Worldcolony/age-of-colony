"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { flag, teamName, fixtureId } from "@/lib/format";
import type { Fixture } from "@/lib/types";

export default function AdminPage() {
  const router = useRouter();
  const resetGame = useStore((s) => s.resetGame);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    loadRecent();
  }, []);

  async function loadRecent() {
    try {
      const d = await api.recentFixtures({ days: 14, limit: 40 });
      setFixtures(d.fixtures ?? []);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function demo() {
    setMsg("Starting demo…");
    try {
      const g = await api.demoRun({});
      resetGame();
      router.push(`/cockpit/${g.gameId}`);
    } catch (e) { setMsg((e as Error).message); }
  }
  async function runPrev() {
    setMsg("Finding latest completed fixture…");
    try {
      const g = await api.runPrevious({ days: 14, limit: 50 });
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
      router.push(`/room/${g.gameId}`);
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
        </div>
        {health && !or && <p className="text-xs text-ink-faint">Set OPENROUTER_API_KEY to start games / demo.</p>}
      </div>

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-[11px]">Quick actions</h2>
        <button className="btn btn-primary" onClick={demo}>▶ Run demo match</button>
        <button className="btn btn-ghost" onClick={runPrev}>Run latest completed fixture</button>
      </div>

      {msg && <p className="text-sm text-ink-soft">{msg}</p>}
      <div className="flex items-center justify-between">
        <h2 className="hud-title text-[11px]">Recent fixtures</h2>
        <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={loadRecent}>↻</button>
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
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => replay(f)}>Replay this match</button>
          </div>
        );
      })}
    </div>
  );
}
