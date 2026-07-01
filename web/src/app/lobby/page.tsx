"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { flag, teamName, fixtureId, fmtWhen } from "@/lib/format";
import type { Fixture } from "@/lib/types";

export default function LobbyPage() {
  const router = useRouter();
  const wallet = useStore((s) => s.wallet);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const resetGame = useStore((s) => s.resetGame);

  const [featured, setFeatured] = useState<{ f: Fixture; status?: string } | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const [lt, up] = await Promise.allSettled([api.liveTarget({ days: 14 }), api.upcomingFixtures({ days: 14, limit: 40 })]);
    if (lt.status === "fulfilled" && lt.value.fixture) setFeatured({ f: lt.value.fixture, status: lt.value.status });
    setFixtures(up.status === "fulfilled" ? up.value.fixtures ?? [] : []);
    setLoading(false);
  }

  async function createRoom(f: Fixture) {
    const id = fixtureId(f);
    if (!id) return setErr("Fixture has no id.");
    resetGame();
    setMatchFixture(f);
    try {
      const game = await api.createGame({ fixtureId: id, participant1: f.participant1 ?? null, participant2: f.participant2 ?? null });
      router.push(`/room/${game.gameId}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function joinByCode() {
    if (!code.trim()) return;
    try {
      const game = await api.getGame(code.trim());
      setMatchFixture({ fixtureId: game.fixtureId!, participant1: game.participant1, participant2: game.participant2 });
      router.push(`/room/${game.gameId || code.trim()}`);
    } catch (e) {
      setErr("Room not found: " + (e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">TXLine · World Cup</p>
          <h1 className="hud-title text-lg">Lobby</h1>
        </div>
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-soft">
          {wallet.connected ? wallet.short : "guest"}
        </span>
      </div>

      {featured && <MatchCard f={featured.f} featured status={featured.status} onCreate={createRoom} />}

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-sm">Join a room</h2>
        <div className="flex gap-2">
          <input
            className="input text-center font-mono uppercase tracking-[0.3em]"
            maxLength={12}
            placeholder="CODE"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={joinByCode}>
            Join
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="hud-title text-sm">Upcoming matches</h2>
        <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={load}>
          ↻
        </button>
      </div>

      {err && <p className="text-sm text-danger">{err}</p>}
      {loading ? (
        <div className="glass grid h-24 place-items-center p-4 text-ink-faint">Loading…</div>
      ) : fixtures.length === 0 ? (
        <div className="glass p-4 text-center text-sm text-ink-faint">No upcoming fixtures. Try Admin.</div>
      ) : (
        fixtures.slice(0, 20).map((f) => <MatchCard key={String(fixtureId(f))} f={f} onCreate={createRoom} />)
      )}

      <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => router.push("/admin")}>
        Admin · replay a past match
      </button>
    </div>
  );
}

function MatchCard({ f, featured, status, onCreate }: { f: Fixture; featured?: boolean; status?: string; onCreate: (f: Fixture) => void }) {
  const p1 = teamName(f.participant1);
  const p2 = teamName(f.participant2);
  const live = status === "current";
  return (
    <div className={`glass flex flex-col gap-3 p-4 ${featured ? "!bg-white/[0.06]" : ""}`}>
      {featured && (
        <div className="flex items-center justify-between">
          <p className="eyebrow">Featured</p>
          {live ? (
            <span className="flex items-center gap-1.5 rounded-full border border-magenta/40 px-3 py-1 text-xs font-bold text-magenta">
              <span className="live-dot" /> LIVE
            </span>
          ) : (
            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-faint">{status === "next" ? "Next" : "Upcoming"}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-bold">
          <span className="text-2xl">{flag(p1)}</span>
          <span className="truncate">{p1}</span>
        </div>
        <span className="font-mono text-xs text-ink-faint">VS</span>
        <div className="flex min-w-0 flex-row-reverse items-center gap-2 text-right font-bold">
          <span className="text-2xl">{flag(p2)}</span>
          <span className="truncate">{p2}</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span>{f.competition ?? ""}</span>
        {f.startTime && <span className="font-mono font-bold text-amber">{fmtWhen(f.startTime)}</span>}
      </div>
      <button className={`btn ${featured ? "btn-primary" : "btn-ghost"}`} onClick={() => onCreate(f)}>
        {featured ? "Create room & play" : "Create room"}
      </button>
    </div>
  );
}
