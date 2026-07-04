"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { getAnonId } from "@/lib/anon";
import { flag, fmtKickoffLine, teamName } from "@/lib/format";
import type { Player } from "@/lib/types";

const RUNNING = new Set(["running_replay", "running_live", "waiting_kickoff"]);

export default function RoomPage() {
  const router = useRouter();
  const { code } = useParams<{ code: string }>();
  const wallet = useStore((s) => s.wallet);
  const mf = useStore((s) => s.matchFixture);
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);

  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState(wallet.name || wallet.short || "");
  const [msg, setMsg] = useState("");
  const [joined, setJoined] = useState(false);
  const [starting, setStarting] = useState(false);

  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const kickoffLine = fmtKickoffLine(game?.startTime ?? mf?.startTime, game?.startTimeIso ?? mf?.startTimeIso);
  const anonId = typeof window !== "undefined" ? getAnonId() : "";
  const roomCode = game?.roomCode || code;

  useEffect(() => {
    api
      .getRoomByCode(code)
      .then((g) => {
        setGame(g);
        setPlayers(g.players || []);
        if (g.players?.some((p) => p.anonymousId === anonId)) setJoined(true);
      })
      .catch((e) => setMsg((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (game?.gameId && game.status && RUNNING.has(game.status)) {
      router.replace(`/cockpit/${game.gameId}`);
    }
  }, [game?.gameId, game?.status, router]);

  useGameStream(game?.gameId ?? null, {
    onState: (g) => {
      setGame(g);
      setPlayers(g.players || []);
      if (g.gameId && g.status && RUNNING.has(g.status)) router.replace(`/cockpit/${g.gameId}`);
    },
    onEvent: (e) => { if (e.kind === "player_joined") setMsg(e.message); },
  });

  const me = useMemo(() => players.find((p) => p.anonymousId === anonId), [players, anonId]);
  const isJoined = joined || Boolean(me);
  const isHost = Boolean(me?.isHost || (game?.owner?.anonymousId && game.owner.anonymousId === anonId));
  const myReady = Boolean(me?.ready);
  const missingPlayers = players.filter((p) => !p.ready);
  const hasColony = Boolean(game?.colonies?.length);
  const canStart = Boolean(isHost && hasColony && missingPlayers.length === 0 && game?.status === "created");
  const startHelper = !isHost
    ? "Waiting for the host to start."
    : !hasColony
      ? "Create at least one colony before start."
      : missingPlayers.length
        ? `Waiting for ${missingPlayers[0].name}'s colony`
        : "Everyone is ready.";

  async function join() {
    if (!name.trim()) return setMsg("Enter a name.");
    try {
      const g = await api.joinRoomByCode(roomCode, name.trim(), anonId);
      setGame(g);
      setPlayers(g.players || []);
      useStore.getState().setWallet({ name: name.trim() });
      setJoined(true);
      setMsg(`${name.trim()} joined.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(roomCode);
      setMsg("Code copied.");
    } catch {
      setMsg(roomCode);
    }
  }

  async function share() {
    const text = `Join my Age of Colony room - code ${roomCode} (${p1} vs ${p2})`;
    const url = typeof location !== "undefined" ? location.href : undefined;
    try {
      if (navigator.share) await navigator.share({ title: "Age of Colony", text, url });
      else { await navigator.clipboard.writeText(url ? `${text} ${url}` : text); setMsg("Invite copied."); }
    } catch { /* cancelled */ }
  }

  async function start() {
    if (!game?.gameId || !canStart) return;
    setStarting(true);
    setMsg("");
    try {
      const g = await api.startGame(game.gameId, "live", { anonymousId: anonId });
      setGame(g);
      router.push(`/cockpit/${g.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-4">
      <header className="page-top">
        <button className="icon-btn" aria-label="Back to lobby" onClick={() => router.push("/lobby")}>←</button>
        <h1 className="text-xl font-bold">Room</h1>
        <span className="status-pill">{game?.status === "created" ? "Pre-match" : game?.status?.replace("_", " ") || "Room"}</span>
      </header>

      <section className="glass match-card-media flex items-center justify-between gap-3 p-4">
        <span className="plate grid h-11 w-14 place-items-center text-2xl">{flag(p1)}</span>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-2xl font-bold">{p1} <span className="text-base text-gold">vs</span> {p2}</p>
          <p className="truncate text-sm font-bold text-gold">{kickoffLine}</p>
        </div>
        <span className="plate grid h-11 w-14 place-items-center text-2xl">{flag(p2)}</span>
      </section>

      <section className="glass pheromone-line flex flex-col items-center gap-4 p-5 text-center">
        <div>
          <p className="text-sm font-bold text-ink-soft">Room code</p>
          <strong className="font-mono text-5xl tracking-[0.08em] text-gold">{roomCode}</strong>
          <p className="mt-1 text-sm text-ink-faint">Share this code with your friends.</p>
        </div>
        <div className="grid w-full grid-cols-2 gap-3">
          <button className="btn btn-ghost" onClick={copyCode}>Copy</button>
          <button className="btn btn-ghost !border-cyan/50 !text-cyan" onClick={share}>Share</button>
        </div>
      </section>

      <section className="glass flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Players {players.length ? `(${players.filter((p) => p.ready).length}/${players.length})` : ""}</h2>
          {isHost && <span className="status-pill">Host</span>}
        </div>

        {!isJoined && (
          <div className="flex gap-2">
            <input className="input" maxLength={32} placeholder={wallet.short || "Your name"} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={join}>Join</button>
          </div>
        )}

        <div className="flex flex-col divide-y divide-[color:var(--brd-soft)]">
          {players.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">No players yet.</span>
          ) : (
            players.map((p) => (
              <div key={p.playerId || p.name} className="flex items-center gap-3 py-3">
                <span className={`grid h-10 w-10 place-items-center rounded-full border ${p.ready ? "border-green/70 text-green" : "border-rust/70 text-rust"}`}>🐜</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="truncate">{p.name}</strong>
                    {p.isHost && <span className="rounded-md border border-gold/50 px-2 py-0.5 text-xs font-bold text-gold">Host</span>}
                  </div>
                  {p.colonyName && <p className="truncate text-xs text-ink-faint">{p.colonyName}</p>}
                </div>
                <span className={`text-sm font-bold ${p.ready ? "text-green" : "text-rust"}`}>
                  {p.ready ? "ready" : "needs colony"}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {msg && <p className="rounded-lg border border-[color:var(--brd-soft)] bg-black/20 px-3 py-2 text-center text-sm text-ink-soft">{msg}</p>}

      <div className="bottom-action">
        <div className="bottom-action-inner">
          {game?.gameId && game.status && RUNNING.has(game.status) ? (
            <>
              <button className="btn btn-primary" onClick={() => router.replace(`/cockpit/${game.gameId}`)}>
                Enter live cockpit
              </button>
              <p className="text-center text-sm text-ink-faint">Match is running.</p>
            </>
          ) : !isJoined ? (
            <button className="btn btn-primary" onClick={join}>Join room</button>
          ) : !myReady ? (
            <button className="btn btn-primary" disabled={!game?.gameId} onClick={() => router.push("/setup")}>
              Create my colony
            </button>
          ) : isHost ? (
            <>
              <button className="btn btn-primary" disabled={!canStart || starting} onClick={start}>
                {starting ? "Starting..." : "Start match"}
              </button>
              <p className="text-center text-sm text-ink-faint">{startHelper}</p>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" disabled>Waiting for host</button>
              <p className="text-center text-sm text-ink-faint">{startHelper}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
