"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { getAnonId } from "@/lib/anon";
import { flag, fmtKickoffLine, teamName } from "@/lib/format";
import { Segmented, Chips } from "@/components/Segmented";
import type { FavoriteContext, GameState, InfoNeed, Player, Style } from "@/lib/types";

const RUNNING = new Set(["running_replay", "running_live"]);
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "Cautious" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const GROUNDS: FavoriteContext[] = ["penalties", "corners", "momentum", "chaos", "balanced"];
const INFO: { value: InfoNeed; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export default function RoomPage() {
  const router = useRouter();
  const { code } = useParams<{ code: string }>();
  const wallet = useStore((s) => s.wallet);
  const mf = useStore((s) => s.matchFixture);
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const setMyColonyId = useStore((s) => s.setMyColonyId);

  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState(wallet.name || wallet.short || "");
  const [msg, setMsg] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [style, setStyle] = useState<Style>("balanced");
  const [ground, setGround] = useState<FavoriteContext>("momentum");
  const [info, setInfo] = useState<InfoNeed>("medium");

  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const kickoffLine = fmtKickoffLine(game?.startTime ?? mf?.startTime, game?.startTimeIso ?? mf?.startTimeIso);
  const anonId = typeof window !== "undefined" ? getAnonId() : "";
  const roomKey = String(code || "");
  const roomCode = game?.roomCode || (isRoomCode(roomKey) ? roomKey : "");

  const me = useMemo(() => players.find((p) => p.anonymousId === anonId), [players, anonId]);
  const myColony = useMemo(() => game?.colonies?.find((c) => c.playerAnonymousId === anonId), [game?.colonies, anonId]);
  const isJoined = joined || Boolean(me);
  const isHost = Boolean(me?.isHost || (game?.owner?.anonymousId && game.owner.anonymousId === anonId));
  const myReady = Boolean(me?.ready || myColony);
  const missingPlayers = players.filter((p) => !p.ready);
  const hasColony = Boolean(game?.colonies?.length);
  const canStart = Boolean(isHost && hasColony && missingPlayers.length === 0 && game?.status === "created");
  const canEnterCockpit = Boolean(game?.gameId && game.status && RUNNING.has(game.status) && myReady);
  const startHelper = game?.status === "waiting_kickoff"
    ? "Match will start automatically at kickoff."
    : !hasColony
      ? "Create a colony to enter this match room."
      : "Ready. The live game starts automatically.";

  function syncGame(g: GameState) {
    setGame(g);
    setPlayers(g.players || []);
    const player = g.players?.find((p) => p.anonymousId === anonId);
    const colony = g.colonies?.find((c) => c.playerAnonymousId === anonId);
    if (player) {
      setJoined(true);
      setName((current) => current.trim() || player.name);
    }
    if (colony) setMyColonyId(colony.colonyId);
  }

  useEffect(() => {
    const load = isRoomCode(roomKey) ? api.getRoomByCode(roomKey) : api.getGame(roomKey);
    load
      .then((g) => {
        syncGame(g);
      })
      .catch((e) => setMsg((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey]);

  useEffect(() => {
    if (canEnterCockpit && game?.gameId) router.replace(`/cockpit/${game.gameId}`);
  }, [canEnterCockpit, game?.gameId, router]);

  useGameStream(game?.gameId ?? null, {
    onState: (g) => {
      syncGame(g);
      if (g.gameId && g.status && RUNNING.has(g.status) && hasLocalColony(g, anonId)) {
        router.replace(`/cockpit/${g.gameId}`);
      }
    },
    onEvent: (e) => { if (e.kind === "player_joined") setMsg(e.message); },
  });

  async function joinAndCreateColony() {
    const cleanName = (name.trim() || wallet.name || wallet.short || `Colony ${Date.now().toString().slice(-4)}`).slice(0, 32);
    if (!game?.gameId) return setMsg("Match room is still loading.");
    setJoining(true);
    setMsg("");
    try {
      let g = game;
      if (!isJoined || me?.name !== cleanName) {
        g = roomCode
          ? await api.joinRoomByCode(roomCode, cleanName, anonId)
          : await api.joinPlayer(game.gameId, cleanName, anonId);
        syncGame(g);
      }
      useStore.getState().setWallet({ name: cleanName });
      setJoined(true);

      if (!g.colonies?.some((c) => c.playerAnonymousId === anonId)) {
        g = await api.addColony(g.gameId, {
          name: cleanName,
          size: 20,
          style,
          favoriteContext: ground,
          infoNeed: info,
          anonymousId: anonId,
        });
      }
      syncGame(g);
      setMsg(`${cleanName} is ready.`);
      if (g.gameId && g.status && RUNNING.has(g.status)) router.replace(`/cockpit/${g.gameId}`);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("already has a colony") && game?.gameId) {
        const fresh = await api.getGame(game.gameId);
        syncGame(fresh);
        if (fresh.gameId && fresh.status && RUNNING.has(fresh.status)) router.replace(`/cockpit/${fresh.gameId}`);
      } else {
        setMsg(message);
      }
    } finally {
      setJoining(false);
    }
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
        <h1 className="hud-title text-[13px]">Match</h1>
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

      {!myReady && (
        <section className="glass pheromone-line flex flex-col gap-4 p-4">
          <div>
            <h2 className="font-bold">Enter the match</h2>
            <p className="mt-1 text-sm text-ink-faint">One name for you and your colony, with tactics set before launch.</p>
          </div>
          <Field label="Colony name">
            <input
              className="input"
              maxLength={32}
              placeholder={wallet.short || "Colony name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Strategy">
            <Segmented options={STYLES} value={style} onChange={setStyle} />
          </Field>
          <Field label="Focus">
            <Chips options={GROUNDS} value={ground} onChange={setGround} />
          </Field>
          <Field label="Risk level">
            <Segmented options={INFO} value={info} onChange={setInfo} />
          </Field>
          <button className="btn btn-primary" disabled={joining || !game?.gameId} onClick={joinAndCreateColony}>
            {joining ? "Joining..." : "Join match"}
          </button>
        </section>
      )}

      <section className="glass flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Colonies {players.length ? `(${players.filter((p) => p.ready).length}/${players.length})` : ""}</h2>
          {isHost && <span className="status-pill">Host</span>}
        </div>

        <div className="flex flex-col divide-y divide-[color:var(--brd-soft)]">
          {players.length === 0 ? (
            <span className="py-5 text-center text-sm text-ink-faint">No colonies yet.</span>
          ) : (
            players.map((p) => (
              <div key={p.playerId || p.name} className="flex items-center gap-3 py-3">
                <span className={`grid h-10 w-10 place-items-center rounded-full border ${p.ready ? "border-green/70 text-green" : "border-rust/70 text-rust"}`}>🐜</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="truncate">{p.name}</strong>
                    {p.isHost && <span className="rounded-md border border-gold/50 px-2 py-0.5 text-xs font-bold text-gold">Host</span>}
                  </div>
                  {p.colonyName && p.colonyName !== p.name && <p className="truncate text-xs text-ink-faint">{p.colonyName}</p>}
                </div>
                <span className={`text-sm font-bold ${p.ready ? "text-green" : "text-rust"}`}>
                  {p.ready ? "ready" : "needs colony"}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {msg && <p className="well px-3 py-2 text-center text-sm text-ink-soft">{msg}</p>}

      <div className="bottom-action">
        <div className="bottom-action-inner">
          {!myReady ? (
            <button className="btn btn-primary" disabled={joining || !game?.gameId} onClick={joinAndCreateColony}>
              {joining ? "Joining..." : "Join match"}
            </button>
          ) : game?.gameId && game.status && RUNNING.has(game.status) ? (
            <>
              <button className="btn btn-primary" onClick={() => router.replace(`/cockpit/${game.gameId}`)}>
                Enter live cockpit
              </button>
              <p className="text-center text-sm text-ink-faint">Match is running.</p>
            </>
          ) : isHost ? (
            <>
              <button className="btn btn-primary" disabled={!canStart || starting} onClick={start}>
                {starting ? "Starting..." : game?.status === "created" ? "Start now" : "Waiting for kickoff"}
              </button>
              <p className="text-center text-sm text-ink-faint">{startHelper}</p>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" disabled>Waiting for kickoff</button>
              <p className="text-center text-sm text-ink-faint">{startHelper}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function hasLocalColony(game: GameState, anonId: string): boolean {
  return Boolean(
    game.players?.some((p) => p.anonymousId === anonId && p.ready)
    || game.colonies?.some((c) => c.playerAnonymousId === anonId),
  );
}

function isRoomCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-bold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}
