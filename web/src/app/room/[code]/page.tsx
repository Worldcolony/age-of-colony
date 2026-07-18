"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import {
  findIdentityColony,
  findIdentityPlayer,
  identityWithWallet,
  isIdentityHost,
  legacyAnonymousIdForHost,
  legacyAnonymousIdForPlayer,
  usePlayerIdentity,
  type PlayerIdentitySnapshot,
} from "@/lib/playerIdentity";
import { flag, fmtKickoffLine, teamName } from "@/lib/format";
import { Segmented } from "@/components/Segmented";
import { worldLink } from "@/three/worldLink";
import { GameShell, GameChip, GameToasts, useGameToasts } from "@/components/GameShell";
import { colonySugar } from "@/lib/sugar";
import type { FavoriteContext, GameState, InfoNeed, Player, Style } from "@/lib/types";

const RUNNING = new Set(["running_replay", "running_live"]);
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "Careful" },
  { value: "balanced", label: "Steady" },
  { value: "aggressive", label: "Bold" },
];
const DEFAULT_FOCUS: FavoriteContext = "balanced";
const DEFAULT_INFO: InfoNeed = "medium";
const TEMPERAMENT_COPY: Record<Style, string> = {
  cautious: "Enters only when ant consensus is especially strong.",
  balanced: "Enters when ant consensus is clear.",
  aggressive: "Enters more often because lighter consensus is enough.",
};

export default function RoomPage() {
  const router = useRouter();
  const { code } = useParams<{ code: string }>();
  const wallet = useStore((s) => s.wallet);
  const mf = useStore((s) => s.matchFixture);
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const identity = usePlayerIdentity();

  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState(wallet.name || wallet.short || "");
  const [nameDirty, setNameDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [sheetOpen, setSheetOpen] = useState(true);
  const { toasts, push } = useGameToasts();
  const [style, setStyle] = useState<Style>("balanced");
  const previousWallet = useRef<string | null>(identity.wallet);

  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const kickoffLine = fmtKickoffLine(game?.startTime ?? mf?.startTime, game?.startTimeIso ?? mf?.startTimeIso);
  const roomKey = String(code || "");
  const isPrivateRoom = game?.roomScope === "private";
  const privateRoomCode = isPrivateRoom
    ? game?.roomCode || (isRoomCode(roomKey) ? roomKey : "")
    : "";
  const invitationPath = privateRoomCode ? `/room/${privateRoomCode}` : "";

  const me = useMemo(() => findIdentityPlayer(players, identity.snapshot), [identity.snapshot, players]);
  const myColony = useMemo(() => findIdentityColony(game, identity.snapshot), [game, identity.snapshot]);
  const hostPlayer = useMemo(() => players.find((player) => player.isHost), [players]);
  const isHost = isIdentityHost(game, identity.snapshot);
  const myReady = Boolean(me?.ready || myColony);
  const missingPlayers = players.filter((p) => !p.ready);
  const hasColony = Boolean(game?.colonies?.length);
  const canStart = Boolean(isPrivateRoom && isHost && hasColony && missingPlayers.length === 0 && game?.status === "created");
  const canEnterCockpit = Boolean(game?.gameId && game.status && RUNNING.has(game.status) && myReady);
  const entriesLocked = Boolean(game?.status && !["created", "waiting_kickoff"].includes(game.status));
  const startHelper = !isPrivateRoom
    ? "This public match starts automatically at kickoff — no player needs to launch it."
    : game?.status === "waiting_kickoff"
      ? "Room locked. The live game will open automatically at kickoff."
      : !hasColony
        ? "Create a colony to enter this private room."
        : isHost
          ? missingPlayers.length
            ? "The host can start once every colony is ready."
            : "Every colony is ready. You can start the private match."
          : "Waiting for the host to start the private match.";

  function syncGame(g: GameState, activeIdentity: PlayerIdentitySnapshot = identity.snapshot) {
    setGame(g);
    setPlayers(g.players || []);
    const player = findIdentityPlayer(g.players, activeIdentity);
    const colony = findIdentityColony(g, activeIdentity);
    if (player) {
      setName((current) => current.trim() || player.name);
      setNameDirty(true);
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

  useEffect(() => {
    setMyColonyId(myColony?.colonyId ?? null);
  }, [myColony?.colonyId, setMyColonyId]);

  useEffect(() => {
    const switchedAccount = Boolean(previousWallet.current && previousWallet.current !== identity.wallet);
    if (switchedAccount) setNameDirty(false);
    if (switchedAccount || !nameDirty) setName(identity.name || identity.short || "");
    previousWallet.current = identity.wallet;
  }, [identity.name, identity.short, identity.wallet, nameDirty]);

  // Every colony in this match lives in the 3D world behind the HUD — new
  // ones are founded with the full rising-mound animation as players join.
  useEffect(() => {
    if (game?.colonies?.length) worldLink.syncColonies(game.colonies, myColony?.colonyId ?? null);
  }, [game?.colonies, myColony?.colonyId]);

  useGameStream(game?.gameId ?? null, {
    onState: (g) => {
      syncGame(g);
      if (g.gameId && g.status && RUNNING.has(g.status) && findIdentityColony(g, identity.snapshot)) {
        router.replace(`/cockpit/${g.gameId}`);
      }
    },
    onEvent: (e) => { if (e.kind === "player_joined") setMsg(e.message); },
  });

  async function joinAndCreateColony() {
    const cleanName = (name.trim() || wallet.name || wallet.short || `Colony ${Date.now().toString().slice(-4)}`).slice(0, 32);
    if (!game?.gameId) return setMsg("Match room is still loading.");
    if (entriesLocked) return setMsg("Entries are closed because live play has started.");
    setJoining(true);
    setMsg("");
    let activeIdentity = identity.snapshot;
    try {
      let g = game;
      let player = findIdentityPlayer(g.players, activeIdentity);
      if (!player) {
        const walletAddress = await identity.ensureWallet();
        activeIdentity = identityWithWallet(identity.snapshot, walletAddress);
        try {
          g = privateRoomCode
            ? await api.joinRoomByCode(privateRoomCode, cleanName, undefined)
            : await api.joinPlayer(game.gameId, cleanName, undefined);
          syncGame(g, activeIdentity);
        } catch (joinErr) {
          // "already in the room" (e.g. from an earlier visit) is not a
          // failure — refresh the room and continue to colony creation.
          if ((joinErr as ApiError).status !== 409) throw joinErr;
          g = await api.getGame(game.gameId);
          syncGame(g, activeIdentity);
        }
        player = findIdentityPlayer(g.players, activeIdentity);
      }
      useStore.getState().setWallet({ name: cleanName });

      if (!findIdentityColony(g, activeIdentity)) {
        g = await api.addColony(g.gameId, {
          name: cleanName,
          size: 5,
          style,
          favoriteContext: DEFAULT_FOCUS,
          infoNeed: DEFAULT_INFO,
          anonymousId: legacyAnonymousIdForPlayer(player, activeIdentity),
        });
      }
      syncGame(g, activeIdentity);
      setMsg(`${cleanName} is ready.`);
      setSheetOpen(false); // drop the sheet so the founding animation plays center stage
      push("\ud83c\udfe0 Colony founded \u2014 your mound is rising on the map", "gain");
      if (g.gameId && g.status && RUNNING.has(g.status)) router.replace(`/cockpit/${g.gameId}`);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("already has a colony") && game?.gameId) {
        const fresh = await api.getGame(game.gameId);
        syncGame(fresh, activeIdentity);
        if (fresh.gameId && fresh.status && RUNNING.has(fresh.status)) router.replace(`/cockpit/${fresh.gameId}`);
      } else {
        setMsg(message);
        setSheetOpen(true); // surface the failure even if the sheet was down
        push(`⚠️ ${message}`, "loss");
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
      const g = await api.startGame(game.gameId, "live", {
        anonymousId: legacyAnonymousIdForHost(game, identity.snapshot),
      });
      syncGame(g);
      if (g.status && RUNNING.has(g.status)) {
        router.push(`/cockpit/${g.gameId}`);
      } else if (g.status === "waiting_kickoff") {
        setMsg("Room locked. The live game will open automatically at kickoff.");
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function copyPrivateRoomValue(kind: "code" | "invitation") {
    if (!privateRoomCode) {
      setCopyFeedback("The room code is not available yet.");
      return;
    }

    const value = kind === "code"
      ? privateRoomCode
      : `${window.location.origin}${invitationPath}`;
    const copied = await copyToClipboard(value);
    setCopyFeedback(copied
      ? kind === "code" ? "Room code copied." : "Invitation link copied."
      : `Copy manually: ${value}`);
  }

  const readyCount = players.filter((p) => p.ready).length;
  const running = Boolean(game?.gameId && game.status && RUNNING.has(game.status));
  const needsWalletToJoin = !me && !identity.authenticated;
  const walletReadyToJoin = !needsWalletToJoin || identity.ready;

  const cta = !myReady && entriesLocked ? (
    <button type="button" className="g-cta" disabled>
      🔒 Entries closed
    </button>
  ) : !myReady ? (
    <button
      type="button"
      className="g-cta"
      disabled={joining || !game?.gameId || !walletReadyToJoin}
      onClick={joinAndCreateColony}
    >
      {!walletReadyToJoin
        ? "Checking wallet..."
        : joining
          ? "Joining..."
          : needsWalletToJoin
            ? "🔗 Connect wallet & join"
            : "⚔️ Join match"}
    </button>
  ) : running ? (
    <button type="button" className="g-cta rust" onClick={() => router.replace(`/cockpit/${game!.gameId}`)}>
      🔴 Enter live cockpit
    </button>
  ) : isPrivateRoom && isHost && game?.status === "created" ? (
    <button type="button" className="g-cta" disabled={!canStart || starting} onClick={start}>
      {starting ? "Starting..." : "🚀 Start now"}
    </button>
  ) : (
    <button type="button" className="g-cta" disabled>
      ⏳ Waiting for kickoff
    </button>
  );

  return (
    <>
    <GameToasts toasts={toasts} />
    <GameShell
      chip={<GameChip emblem={flag(p1)} title={`${p1} vs ${p2}`} sub={game?.status === "created" ? kickoffLine : game?.status?.replace("_", " ") || "match room"} />}
      resources={[
        { icon: "🍬", value: myColony ? colonySugar(myColony) : "—", title: "Your Sugar" },
        { icon: "🏠", value: players.length ? `${readyCount}/${players.length}` : 0, title: "Colonies ready" },
      ]}
      nav={[
        { icon: "🏟️", label: "Matches", onClick: () => router.push("/lobby") },
        { icon: "👑", label: "Queen", onClick: () => router.push("/queen") },
      ]}
      cta={cta}
      sheetTitle={myReady ? "Match camp" : "Found your colony"}
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      hint={myReady ? "your mound is on the map · drag to explore" : "join to raise your mound on the map"}
    >
      <p className="loop-strip">🐜 ants vote → 🤝 consensus enters → 🍬 results change Sugar → 🏆 most Sugar wins</p>
      <section className="well flex flex-col gap-3 p-3" aria-labelledby="room-kind-title">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="room-kind-title" className="font-bold text-ink">
              {isPrivateRoom ? "Private room" : "Public match"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">
              {isPrivateRoom
                ? `Hosted by ${hostPlayer?.name || "the room creator"}. Share the code with the people you want to invite.`
                : "Open to every player. The match launches automatically at kickoff."}
            </p>
          </div>
          <span className="status-pill shrink-0">{isPrivateRoom ? "Private" : "Public"}</span>
        </div>

        {isPrivateRoom && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.5)] p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Room code</p>
              <p className="mt-1 text-xl font-bold tabular-nums tracking-[0.18em] text-ink" aria-label={privateRoomCode ? `Room code ${privateRoomCode}` : "Room code loading"}>
                {privateRoomCode || "Loading…"}
              </p>
              <button
                type="button"
                className="btn btn-ghost mt-3 !min-h-10 px-3 py-2 text-xs"
                disabled={!privateRoomCode}
                onClick={() => void copyPrivateRoomValue("code")}
                aria-label="Copy private room code"
              >
                Copy code
              </button>
            </div>
            <div className="rounded-xl border border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.5)] p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Invitation</p>
              <p className="mt-1 truncate text-sm font-bold text-ink-soft" title={invitationPath}>
                {invitationPath || "Link loading…"}
              </p>
              <button
                type="button"
                className="btn btn-ghost mt-3 !min-h-10 px-3 py-2 text-xs"
                disabled={!privateRoomCode}
                onClick={() => void copyPrivateRoomValue("invitation")}
                aria-label="Copy private room invitation link"
              >
                Copy invitation
              </button>
            </div>
          </div>
        )}

        <p className="sr-only" role="status" aria-live="polite">{copyFeedback}</p>
        {copyFeedback && <p className="text-xs font-bold text-ink-soft" aria-hidden="true">{copyFeedback}</p>}
      </section>
      <p className="text-center text-xs font-bold text-gold-deep">Create your colony before kickoff. Entries lock when live play starts.</p>
      {needsWalletToJoin && (
        <p className="well px-3 py-2 text-xs leading-relaxed text-ink-soft">
          <b>Phantom identifies your colony across devices.</b> One identity signature, no transaction and no SOL.
        </p>
      )}

      {!myReady && (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            Choose a name and temperament. Your 5 fixed ants vote automatically on every market.
          </p>
          <Field label="Colony name">
            <input
              className="input"
              maxLength={32}
              placeholder={wallet.short || "Colony name"}
              value={name}
              onChange={(e) => {
                setNameDirty(true);
                setName(e.target.value);
              }}
            />
          </Field>
          <Field label="Temperament">
            <div className="grid gap-2">
              <Segmented options={STYLES} value={style} onChange={setStyle} />
              <p className="text-xs leading-relaxed text-ink-faint">{TEMPERAMENT_COPY[style]}</p>
            </div>
          </Field>
          <button className="btn btn-primary" disabled={joining || !game?.gameId || entriesLocked || !walletReadyToJoin} onClick={joinAndCreateColony}>
            {entriesLocked
              ? "Entries closed"
              : !walletReadyToJoin
                ? "Checking wallet..."
              : joining
                ? "Joining..."
                : needsWalletToJoin
                  ? "🔗 Connect wallet & found colony"
                  : "⚔️ Found colony & join"}
          </button>
        </div>
      )}

      <div className="well flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Colonies {players.length ? `(${readyCount}/${players.length})` : ""}</h2>
          {isPrivateRoom && isHost && <span className="status-pill">Host</span>}
        </div>
        <div className="flex flex-col divide-y divide-[color:var(--brd-soft)]">
          {players.length === 0 ? (
            <span className="py-4 text-center text-sm text-ink-faint">No colonies yet — be the first mound on the map.</span>
          ) : (
            players.map((p) => (
              <div key={p.playerId || p.name} className="flex items-center gap-3 py-2.5">
                <span className={`grid h-9 w-9 place-items-center rounded-full border-2 ${p.ready ? "border-green/70 text-green" : "border-rust/70 text-rust"}`}>🐜</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="truncate">{p.name}</strong>
                    {isPrivateRoom && p.isHost && <span className="rounded-md border border-gold/50 px-2 py-0.5 text-xs font-bold text-gold">Host</span>}
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
      </div>

      <p className="text-center text-xs text-ink-faint">{startHelper}</p>
      {msg && <p className="well px-3 py-2 text-center text-sm text-ink-soft">{msg}</p>}
    </GameShell>
    </>
  );
}

function isRoomCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the DOM fallback for browsers that block Clipboard API access.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-bold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}
