"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, API_BASE } from "@/lib/api";
import { useStore } from "@/store/game";
import { getAnonId } from "@/lib/anon";
import { flag, teamName, fixtureId, fmtKickoffLine } from "@/lib/format";
import { GameShell, GameChip } from "@/components/GameShell";
import type { Fixture } from "@/lib/types";

export default function LobbyPage() {
  const router = useRouter();
  const wallet = useStore((s) => s.wallet);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const resetGame = useStore((s) => s.resetGame);

  const [featured, setFeatured] = useState<{ f: Fixture; status?: string } | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  const headline = matches[0];

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

  async function joinMatch(f: Fixture) {
    const id = fixtureId(f);
    if (!id) return setErr("Fixture has no id.");
    setJoining(true);
    setErr("");
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
      });
      router.push(`/room/${game.gameId}`);
    } catch (e) {
      setErr((e as Error).message);
      setSheetOpen(true); // errors must be visible even if the sheet was down
      setJoining(false);
    }
  }

  const headLive = headline?.status === "current";

  return (
    <GameShell
      chip={<GameChip emblem="🐜" title="Age of Colony" sub={wallet.connected ? wallet.short : "guest commander"} />}
      resources={[{ icon: "⚽", value: matches.length, title: "Matches open" }]}
      nav={[
        { icon: "🗓️", label: "Matches", active: sheetOpen, onClick: () => setSheetOpen((v) => !v) },
        { icon: "👑", label: "Queen", onClick: () => router.push("/queen") },
        { icon: "🛠️", label: "Admin", onClick: () => router.push("/admin") },
      ]}
      cta={
        <button
          type="button"
          className={`g-cta ${headLive ? "rust" : ""}`}
          disabled={joining}
          onClick={() => {
            if (headline && !loading) joinMatch(headline.f);
            else setSheetOpen(true); // loading/offline: the sheet explains itself
          }}
        >
          {joining
            ? "Entering..."
            : headline
              ? `${headLive ? "🔴 Live" : "⚔️"}  ${teamName(headline.f.participant1)} vs ${teamName(headline.f.participant2)}`
              : loading
                ? "Scouting matches..."
                : "⚔️ Play"}
        </button>
      }
      sheetTitle="Choose a match"
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      hint="drag to orbit · pinch to zoom · tap a mound"
    >
      {err && <p className="rounded-lg border-2 border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{err}</p>}

      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading matches">
          {[0, 1, 2].map((i) => (
            <div key={i} className="g-skel-row">
              <div className="g-skel-chip" style={{ animationDelay: `${i * 0.12}s` }} />
              <div className="g-skel-lines">
                <div className="g-skel-line" style={{ animationDelay: `${i * 0.12}s` }} />
                <div className="g-skel-line short" style={{ animationDelay: `${i * 0.12}s` }} />
              </div>
            </div>
          ))}
        </div>
      ) : loadErr ? (
        <div className="well flex flex-col gap-3 border-l-4 border-l-danger p-4">
          <p className="font-bold">Can&apos;t reach the game engine</p>
          <p className="break-all font-mono text-xs text-ink-soft">{loadErr}</p>
          <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={load}>Retry</button>
        </div>
      ) : matches.length === 0 ? (
        <div className="well p-4 text-center text-sm text-ink-faint">No upcoming fixtures in the next 14 days.</div>
      ) : (
        matches.slice(0, 10).map((item) => (
          <MatchRow key={String(fixtureId(item.f))} {...item} busy={joining} onJoin={joinMatch} />
        ))
      )}
    </GameShell>
  );
}

function MatchRow({ f, status, busy, onJoin }: { f: Fixture; featured?: boolean; status?: string; busy: boolean; onJoin: (f: Fixture) => void }) {
  const p1 = teamName(f.participant1);
  const p2 = teamName(f.participant2);
  const live = status === "current";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onJoin(f)}
      className="glass match-card-media flex items-center gap-3 p-3 text-left"
    >
      <span className="plate grid h-11 w-12 shrink-0 place-items-center text-xl">{flag(p1)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-bold">{p1} <span className="text-gold">vs</span> {p2}</span>
        <span className="block truncate text-xs text-ink-faint">{f.competition ?? "Upcoming"}</span>
      </span>
      <span className={`status-pill shrink-0 ${live ? "!border-rust/50 !text-rust" : ""}`}>
        {live && <span className="live-dot" />}
        {live ? "Live" : fmtKickoffLine(f.startTime, f.startTimeIso)}
      </span>
      <span className="plate grid h-11 w-12 shrink-0 place-items-center text-xl">{flag(p2)}</span>
    </button>
  );
}
