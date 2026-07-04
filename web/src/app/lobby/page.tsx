"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, API_BASE } from "@/lib/api";
import { useStore } from "@/store/game";
import { getAnonId } from "@/lib/anon";
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
  const [showJoin, setShowJoin] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    load();
  }, []);

  const matches = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ f: Fixture; featured?: boolean; status?: string }> = [];
    if (featured) {
      const key = String(fixtureId(featured.f));
      seen.add(key);
      list.push({ f: featured.f, featured: true, status: featured.status });
    }
    for (const f of fixtures) {
      const key = String(fixtureId(f));
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ f });
    }
    return list;
  }, [featured, fixtures]);

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
      setLoadErr(
        reason?.status
          ? `Engine error: ${reason.message}`
          : `Game engine offline at ${API_BASE} - start it with: uvicorn app.main:app --port 8000`,
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
        creatorName: wallet.name || wallet.short || undefined,
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
    <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-4">
      <header className="page-top">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl border border-[color:var(--brd-strong)] bg-[rgba(230,161,58,0.08)] text-lg">
            🐜
          </div>
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-soft">Age of Colony</p>
            <p className="text-xs text-ink-faint">{wallet.connected ? wallet.short : "guest"}</p>
          </div>
        </div>
        <button className="quiet-link text-sm" onClick={() => router.push("/queen")}>
          Queen
        </button>
      </header>

      <section className="mt-6">
        <h1 className="text-3xl font-bold leading-tight text-ink">Choose a match</h1>
        <p className="mt-2 text-base text-ink-soft">Start a room or join your friends.</p>
      </section>

      {err && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{err}</p>}

      {showJoin && (
        <div className="glass flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">Join with code</h2>
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">6 digits</span>
          </div>
          <div className="flex gap-2">
            <input
              className="input text-center font-mono text-xl tracking-[0.45em]"
              inputMode="numeric"
              maxLength={6}
              placeholder="------"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button className="btn btn-primary !w-auto shrink-0 px-5" disabled={code.length !== 6} onClick={joinByCode}>
              Join
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="glass grid h-28 place-items-center p-4 text-ink-faint">Loading matches...</div>
      ) : loadErr ? (
        <div className="glass flex flex-col gap-3 border-l-4 border-l-danger p-4">
          <p className="font-bold">Can&apos;t reach the game engine</p>
          <p className="break-all font-mono text-xs text-ink-soft">{loadErr}</p>
          <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={load}>Retry</button>
        </div>
      ) : matches.length === 0 ? (
        <div className="glass p-4 text-center text-sm text-ink-faint">No upcoming fixtures in the next 14 days. Try an admin replay.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {matches.slice(0, 8).map((item) => (
            <MatchCard key={String(fixtureId(item.f))} {...item} onCreate={createRoom} />
          ))}
        </div>
      )}

      <div className="bottom-action">
        <div className="bottom-action-inner">
          <button className="quiet-link py-2 text-base" onClick={() => setShowJoin((v) => !v)}>
            {showJoin ? "Hide code entry" : "Join with code"}
          </button>
          <button className="quiet-link py-2 text-xs text-ink-faint" onClick={() => router.push("/admin")}>
            Admin replay
          </button>
        </div>
      </div>
    </div>
  );
}

function MatchCard({ f, featured, status, onCreate }: { f: Fixture; featured?: boolean; status?: string; onCreate: (f: Fixture) => void }) {
  const p1 = teamName(f.participant1);
  const p2 = teamName(f.participant2);
  const live = status === "current";
  return (
    <div className={`glass match-card-media flex flex-col gap-4 p-4 ${featured ? "pheromone-line" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 font-bold">
          <span className="plate grid h-12 w-14 shrink-0 place-items-center text-2xl">{flag(p1)}</span>
          <span className="truncate text-2xl">{p1}</span>
        </div>
        <span className="font-mono text-sm font-bold uppercase text-gold">vs</span>
        <div className="flex min-w-0 flex-1 flex-row-reverse items-center gap-3 text-right font-bold">
          <span className="plate grid h-12 w-14 shrink-0 place-items-center text-2xl">{flag(p2)}</span>
          <span className="truncate text-2xl">{p2}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-ink-soft">
        <span className="truncate">{f.competition ?? (featured ? "Featured match" : "Upcoming")}</span>
        <span className={`status-pill ${live ? "!border-rust/50 !text-rust" : ""}`}>
          {live && <span className="live-dot" />}
          {live ? "Live" : f.startTime ? fmtWhen(f.startTime) : "Live starts soon"}
        </span>
      </div>
      {featured ? (
        <button className="btn btn-primary" onClick={() => onCreate(f)}>
          Create room
        </button>
      ) : (
        <button className="btn btn-ghost !min-h-0 py-2.5 text-sm" onClick={() => onCreate(f)}>
          Create room
        </button>
      )}
    </div>
  );
}
