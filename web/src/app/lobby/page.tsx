"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, API_BASE, ApiError, type CreatePlayerRoomRequest } from "@/lib/api";
import { useStore } from "@/store/game";
import { usePlayerIdentity } from "@/lib/playerIdentity";
import {
  forgetPublicMatch,
  isResumablePublicMatch,
  publicMatchHref,
  rememberedPublicMatchId,
  rememberPublicMatch,
} from "@/lib/publicMatch";
import { flag, teamName, fixtureId, fmtKickoffLine } from "@/lib/format";
import { GameShell, GameChip } from "@/components/GameShell";
import type { Fixture, GameState } from "@/lib/types";

type LobbyView = "choose" | "public" | "friends" | "private-match";

export default function LobbyPage() {
  const router = useRouter();
  const identity = usePlayerIdentity();
  const currentGame = useStore((s) => s.game);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const setGame = useStore((s) => s.setGame);
  const resetGame = useStore((s) => s.resetGame);

  const [featured, setFeatured] = useState<{ f: Fixture; status?: string } | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [view, setView] = useState<LobbyView>("choose");
  const [roomCode, setRoomCode] = useState("");
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [restoredResume, setRestoredResume] = useState<{ wallet: string; game: GameState } | null>(null);
  const rememberedId = identity.authenticated && identity.wallet
    ? rememberedPublicMatchId(identity.wallet)
    : null;
  const currentResume = isResumablePublicMatch(currentGame) && currentGame.gameId === rememberedId
    ? currentGame
    : null;
  const persistedResume = restoredResume?.wallet === identity.wallet
    && restoredResume.game.gameId === rememberedId
    && isResumablePublicMatch(restoredResume.game)
    ? restoredResume.game
    : null;
  const resumeGame = currentResume ?? persistedResume;

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!identity.ready || !identity.authenticated || !identity.wallet || !rememberedId) return;
    if (isResumablePublicMatch(currentGame) && currentGame.gameId === rememberedId) return;
    const wallet = identity.wallet;

    api.getGame(rememberedId).then((game) => {
      if (cancelled) return;
      if (!isResumablePublicMatch(game)) {
        forgetPublicMatch(wallet);
        setRestoredResume(null);
        return;
      }
      setGame(game);
      setRestoredResume({ wallet, game });
    }).catch((error) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 404) forgetPublicMatch(wallet);
      setRestoredResume(null);
    });

    return () => {
      cancelled = true;
    };
  }, [currentGame, identity.authenticated, identity.ready, identity.wallet, rememberedId, setGame]);

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

  function fixturePayload(f: Fixture): CreatePlayerRoomRequest | null {
    const id = fixtureId(f);
    if (!id) return null;
    return {
      fixtureId: id,
      participant1: f.participant1 ?? null,
      participant2: f.participant2 ?? null,
      competition: f.competition ?? null,
      startTime: f.startTime ?? null,
      startTimeIso: f.startTimeIso ?? null,
    };
  }

  function show(next: LobbyView) {
    setErr("");
    setView(next);
    setSheetOpen(true);
  }

  async function joinPublicMatch(f: Fixture) {
    const payload = fixturePayload(f);
    if (!payload) return setErr("This fixture has no id.");
    setJoining(true);
    setErr("");
    try {
      const wallet = await identity.ensureWallet();
      resetGame();
      setMatchFixture(f);
      const game = await api.createGame(payload);
      rememberPublicMatch(game, wallet);
      setGame(game);
      router.push(`/room/${game.gameId}`);
    } catch (e) {
      setErr((e as Error).message);
      setSheetOpen(true); // errors must be visible even if the sheet was down
      setJoining(false);
    }
  }

  async function createPrivateMatch(f: Fixture) {
    const payload = fixturePayload(f);
    if (!payload) return setErr("This fixture has no id.");
    setJoining(true);
    setErr("");
    try {
      await identity.ensureWallet();
      resetGame();
      setMatchFixture(f);
      const game = await api.createPrivateRoom(payload);
      if (!game.roomCode) throw new Error("The private room was created without an invite code. Try again.");
      setGame(game);
      router.push(`/room/${game.roomCode}`);
    } catch (e) {
      setErr((e as Error).message);
      setSheetOpen(true);
      setJoining(false);
    }
  }

  async function joinPrivateRoom() {
    if (roomCode.length !== 6) {
      setErr("Enter the six-digit room code.");
      return;
    }
    setJoining(true);
    setErr("");
    try {
      await identity.ensureWallet();
      const room = await api.getRoomByCode(roomCode);
      if (room.roomScope && room.roomScope !== "private") {
        throw new Error("This code belongs to a public match, not a private room.");
      }
      resetGame();
      setGame(room);
      router.push(`/room/${roomCode}`);
    } catch (e) {
      const error = e as Error;
      setErr(e instanceof ApiError && e.status === 404 ? "Room not found. Check the six-digit code." : error.message);
      setSheetOpen(true);
      setJoining(false);
    }
  }

  function resumePublicMatch() {
    if (!resumeGame) return;
    setGame(resumeGame);
    setMatchFixture({
      fixtureId: resumeGame.fixtureId ?? resumeGame.gameId,
      participant1: resumeGame.participant1,
      participant2: resumeGame.participant2,
      competition: resumeGame.competition ?? undefined,
      startTime: resumeGame.startTime ?? undefined,
      startTimeIso: resumeGame.startTimeIso ?? undefined,
    });
    router.push(publicMatchHref(resumeGame));
  }

  const sheetTitle = view === "choose"
    ? "How do you want to play?"
    : view === "public"
      ? "Join the public match"
      : view === "friends"
        ? "Play with friends"
        : "Choose a private match";

  return (
    <GameShell
      chip={(
        <GameChip
          emblem="🐜"
          title="Age of Colony"
          sub={identity.authenticated ? identity.short : identity.ready ? "connect wallet to play" : "checking wallet…"}
        />
      )}
      resources={[{ icon: "⚽", value: matches.length, title: "Matches open" }]}
      nav={[
        { icon: "🗓️", label: "Matches", active: sheetOpen && view === "public", onClick: () => show("public") },
        { icon: "👑", label: "Queen", onClick: () => router.push("/queen") },
      ]}
      cta={
        <button
          type="button"
          className={`g-cta ${resumeGame?.status === "running_live" ? "rust" : ""}`}
          disabled={joining || !identity.ready}
          onClick={resumeGame ? resumePublicMatch : () => show("choose")}
        >
          {!identity.ready
            ? "Checking wallet..."
            : joining
            ? "Entering..."
            : resumeGame?.status === "running_live"
              ? "🔴 Return to live match"
              : resumeGame
                ? "🎟️ Return to my match"
            : "⚔️ Play"}
        </button>
      }
      sheetTitle={sheetTitle}
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      hint="drag to orbit · pinch to zoom · tap a mound"
    >
      {view !== "choose" && (
        <button type="button" className="btn btn-ghost !min-h-0 w-fit px-3 py-2 text-xs" onClick={() => show(view === "public" || view === "friends" ? "choose" : "friends")}>
          ← Back
        </button>
      )}

      {err && <p role="alert" className="rounded-lg border-2 border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{err}</p>}
      {!identity.authenticated && (
        <p className="well px-3 py-2 text-xs leading-relaxed text-ink-soft">
          <b>Wallet identity required to play.</b> Phantom asks for one identity signature. No transaction and no SOL.
        </p>
      )}

      {view === "choose" ? (
        <div className="flex flex-col gap-3">
          {resumeGame && (
            <section className="well overflow-hidden border-l-4 border-l-rust p-4" aria-labelledby="resume-public-title">
              <div className="flex items-start gap-3">
                <span className="plate grid h-11 w-12 shrink-0 place-items-center text-xl" aria-hidden="true">🎟️</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p id="resume-public-title" className="font-bold text-ink">Your public match</p>
                    <span className={`status-pill ${resumeGame.status === "running_live" ? "!border-rust/50 !text-rust" : ""}`}>
                      {resumeGame.status === "running_live" && <span className="live-dot" />}
                      {resumeGame.status === "running_live" ? "Live" : "Joined"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm font-bold text-ink-soft">
                    {teamName(resumeGame.participant1)} <span className="text-gold">vs</span> {teamName(resumeGame.participant2)}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">Your colony and match are still waiting for you.</p>
                </div>
              </div>
              <button type="button" className="btn btn-primary mt-3 !min-h-11" onClick={resumePublicMatch}>
                {resumeGame.status === "running_live" ? "Return to live cockpit" : "Return to match"} →
              </button>
            </section>
          )}

          {resumeGame && <p className="text-center text-[11px] font-bold uppercase tracking-wide text-ink-faint">or start somewhere else</p>}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="glass flex min-h-32 flex-col items-start gap-2 border-l-4 border-l-gold p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              onClick={() => show("public")}
            >
              <span className="text-2xl" aria-hidden="true">🌍</span>
              <span className="font-bold text-ink">Public match</span>
              <span className="text-xs leading-relaxed text-ink-soft">Join the shared room for a match and play with everyone.</span>
            </button>
            <button
              type="button"
              className="glass flex min-h-32 flex-col items-start gap-2 border-l-4 border-l-green p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green"
              onClick={() => show("friends")}
            >
              <span className="text-2xl" aria-hidden="true">🔐</span>
              <span className="font-bold text-ink">Play with friends</span>
              <span className="text-xs leading-relaxed text-ink-soft">Create an invite room or enter a six-digit code.</span>
            </button>
          </div>
        </div>
      ) : view === "friends" ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className="glass flex items-center gap-3 p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            onClick={() => show("private-match")}
          >
            <span className="plate grid h-11 w-12 shrink-0 place-items-center text-xl" aria-hidden="true">＋</span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-ink">Create a private room</span>
              <span className="block text-xs text-ink-soft">Choose a match, then share the invite code.</span>
            </span>
            <span aria-hidden="true">→</span>
          </button>

          <div className="well flex flex-col gap-3 p-4">
            <label htmlFor="private-room-code" className="font-bold text-ink">Join with a code</label>
            <p className="text-xs text-ink-soft">Enter the six digits shared by the room host.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="private-room-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={roomCode}
                onChange={(event) => {
                  setErr("");
                  setRoomCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && roomCode.length === 6 && !joining) void joinPrivateRoom();
                }}
                className="min-h-11 min-w-0 flex-1 rounded-lg border-2 border-ink/30 bg-parch px-3 text-center font-mono text-lg font-bold tracking-[0.3em] text-ink outline-none focus:border-gold"
                placeholder="000000"
                aria-describedby="private-room-code-help"
              />
              <button type="button" className="btn btn-primary !min-h-11 sm:w-auto" disabled={joining || roomCode.length !== 6} onClick={joinPrivateRoom}>
                {joining ? "Checking..." : "Join room"}
              </button>
            </div>
            <span id="private-room-code-help" className="sr-only">Six numeric digits</span>
          </div>
        </div>
      ) : loading ? (
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
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-ink-soft">
            {view === "public"
              ? "Choose a match. You will join its shared public room."
              : "Choose the match for your invite-only room."}
          </p>
          {matches.slice(0, 10).map((item) => (
            <MatchRow
              key={String(fixtureId(item.f))}
              {...item}
              busy={joining || !identity.ready}
              onJoin={view === "private-match" ? createPrivateMatch : joinPublicMatch}
            />
          ))}
        </div>
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
        <span className={`status-pill mt-1 inline-flex max-w-full ${live ? "!border-rust/50 !text-rust" : ""}`}>
          {live && <span className="live-dot" />}
          <span className="truncate">{live ? "Live" : fmtKickoffLine(f.startTime, f.startTimeIso)}</span>
        </span>
      </span>
      <span className="plate grid h-11 w-12 shrink-0 place-items-center text-xl">{flag(p2)}</span>
    </button>
  );
}
