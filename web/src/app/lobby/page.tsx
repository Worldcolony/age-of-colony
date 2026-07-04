"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, API_BASE } from "@/lib/api";
import { useStore } from "@/store/game";
import { getAnonId } from "@/lib/anon";
import { flag, teamName, fixtureId, fmtWhen } from "@/lib/format";
import { AntMarch } from "@/components/AntMarch";
import type { Fixture } from "@/lib/types";

export default function LobbyPage() {
  const router = useRouter();
  const playerName = useStore((s) => s.player.name);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const resetGame = useStore((s) => s.resetGame);

  const [featured, setFeatured] = useState<{ f: Fixture; status?: string } | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [err, setErr] = useState(""); // action errors (create/join)
  const [loadErr, setLoadErr] = useState(""); // engine-unreachable / fixtures fetch errors

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadErr("");
    const [lt, up] = await Promise.allSettled([api.liveTarget({ days: 14 }), api.upcomingFixtures({ days: 14, limit: 40 })]);
    if (lt.status === "fulfilled" && lt.value.fixture) setFeatured({ f: lt.value.fixture, status: lt.value.status });
    else setFeatured(null);
    if (up.status === "fulfilled") {
      setFixtures(up.value.fixtures ?? []);
    } else {
      setFixtures([]);
      const reason = up.reason as Error & { status?: number };
      // fetch TypeError = engine unreachable; anything else = engine said no (e.g. TXLine creds)
      setLoadErr(
        reason?.status
          ? `Engine error: ${reason.message}`
          : `Game engine offline at ${API_BASE} — start it with: uvicorn app.main:app --port 8000`,
      );
    }
    setLoading(false);
  }

  async function createRoom(f: Fixture) {
    const id = fixtureId(f);
    if (!id) return setErr("Fixture has no id.");
    resetGame();
    setMatchFixture(f);
    try {
      const game = await api.createGame({
        fixtureId: id,
        participant1: f.participant1 ?? null,
        participant2: f.participant2 ?? null,
        competition: f.competition ?? null,
        startTime: f.startTime ?? null,
        startTimeIso: f.startTimeIso ?? null,
        anonymousId: getAnonId(),
        creatorName: playerName || undefined,
      });
      router.push(`/room/${game.roomCode || game.gameId}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function joinByCode() {
    const raw = code.replace(/\D/g, "").slice(0, 6);
    if (raw.length !== 6) return setErr("Enter the 6-digit room code.");
    try {
      const game = await api.getRoomByCode(raw);
      setMatchFixture({ fixtureId: game.fixtureId!, participant1: game.participant1, participant2: game.participant2 });
      router.push(`/room/${game.roomCode || raw}`);
    } catch (e) {
      setErr("Room not found: " + (e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="glass signal-brand flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="nest-emblem h-11 w-11 text-xl">
            <span className="text-xl">🐜</span>
          </div>
          <div>
            <h1 className="hud-title text-[18px]">Age of Colony</h1>
            <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">TXLine · match rooms</p>
          </div>
        </div>
        <span className="plate px-3 py-1.5 font-mono text-[11px] font-bold text-ink-soft">
          {playerName || "operator"}
        </span>
      </div>

      {featured && <MatchCard f={featured.f} featured status={featured.status} onCreate={createRoom} />}

      <div className="glass tunnel-map overflow-hidden">
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="hud-title text-[18px]">Join with code</h2>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">6 digits</span>
          </div>
          <div className="flex gap-2">
            <input
              className="input plate text-center font-mono text-xl tracking-[0.32em]"
              inputMode="numeric"
              maxLength={6}
              placeholder="······"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button className="btn btn-primary !w-auto shrink-0 px-5" disabled={code.length !== 6} onClick={joinByCode}>
              Join
            </button>
          </div>
        </div>
        <AntMarch className="border-t border-[color:var(--brd-soft)] bg-[rgba(5,12,11,0.62)] py-1" />
      </div>

      <div className="mt-1 flex items-center justify-between">
        <h2 className="hud-title text-[18px]">Upcoming matches</h2>
        <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={load}>
          ↻
        </button>
      </div>

      {err && <p className="text-sm font-bold text-danger">{err}</p>}
      {loading ? (
        <div className="glass grid h-24 place-items-center p-4 text-ink-faint">Loading…</div>
      ) : loadErr ? (
        <div className="glass flex flex-col gap-3 border-l-4 border-l-danger p-4">
          <p className="font-bold">🔌 Can&apos;t reach the game engine</p>
          <p className="break-all font-mono text-xs text-ink-soft">{loadErr}</p>
          <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={load}>↻ Retry</button>
        </div>
      ) : fixtures.length === 0 ? (
        <div className="glass p-4 text-center text-sm text-ink-faint">No upcoming fixtures in the next 14 days. Try Admin → replay a past match.</div>
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
    <div className={`glass flex flex-col gap-3 p-4 ${featured ? "bracket signal-brand" : ""}`}>
      {featured && (
        <div className="flex items-center justify-between">
          <p className="eyebrow">Featured match</p>
          {live ? (
            <span className="flex items-center gap-1.5 rounded-md border border-lime/40 px-3 py-0.5 font-mono text-[10px] font-bold text-lime">
              <span className="live-dot" /> LIVE
            </span>
          ) : (
            <span className="rounded-md border border-brd px-3 py-0.5 font-mono text-[10px] font-bold uppercase text-ink-faint">{status === "next" ? "Next up" : "Upcoming"}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 font-bold">
          <span className="plate grid h-11 w-11 shrink-0 place-items-center text-2xl">{flag(p1)}</span>
          <span className="truncate text-[15px]">{p1}</span>
        </div>
        <span className="hud-title shrink-0 text-[9px] text-ink-faint">vs</span>
        <div className="flex min-w-0 flex-1 flex-row-reverse items-center gap-2.5 text-right font-bold">
          <span className="plate grid h-11 w-11 shrink-0 place-items-center text-2xl">{flag(p2)}</span>
          <span className="truncate text-[15px]">{p2}</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span className="truncate">{f.competition ?? ""}</span>
        {f.startTime ? (
          <span className="plate shrink-0 px-2.5 py-0.5 font-mono text-[11px] font-bold text-amber">⏱ {fmtWhen(f.startTime)}</span>
        ) : null}
      </div>
      <button className={`btn ${featured ? "btn-primary" : "btn-ghost"}`} onClick={() => onCreate(f)}>
        {featured ? "🏟️ Create room & play" : "Create room"}
      </button>
    </div>
  );
}
