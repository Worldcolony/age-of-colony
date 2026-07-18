"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import {
  findIdentityColony,
  findIdentityPlayer,
  identityWithWallet,
  legacyAnonymousIdForPlayer,
  usePlayerIdentity,
} from "@/lib/playerIdentity";
import { useStore } from "@/store/game";
import { Segmented } from "@/components/Segmented";
import type { FavoriteContext, GameState, InfoNeed, Style } from "@/lib/types";

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

export default function SetupPage() {
  const router = useRouter();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const identity = usePlayerIdentity();

  const [name, setName] = useState("");
  const [style, setStyle] = useState<Style>("balanced");
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (game?.gameId) return;
    let cancelled = false;

    Promise.resolve().then(async () => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      const roomCode = normalizeRoomCode(params.get("room") || params.get("code"));
      const gameId = (params.get("game") || "").trim();
      if (!roomCode && !gameId) return;

      setHydrating(true);
      setMsg("");
      try {
        const loaded = roomCode ? await api.getRoomByCode(roomCode) : await api.getGame(gameId);
        if (cancelled) return;
        setGame(loaded);
      } catch (e) {
        if (!cancelled) setMsg((e as Error).message);
      } finally {
        if (!cancelled) setHydrating(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [game?.gameId, setGame, setMyColonyId]);

  useEffect(() => {
    const mine = findIdentityColony(game, identity.snapshot);
    setMyColonyId(mine?.colonyId ?? null);
  }, [game, identity.snapshot, setMyColonyId]);

  if (!game?.gameId) {
    return (
      <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-3">
        <header className="page-top">
          <button className="icon-btn" aria-label="Back" onClick={() => router.push("/lobby")}>←</button>
          <h1 className="hud-title text-[13px]">Your colony</h1>
          <span />
        </header>
        <div className="glass p-4 text-center text-sm text-ink-faint">
          {hydrating ? "Loading room..." : msg || "Pick a match from the lobby first."}
        </div>
        <div className="bottom-action">
          <div className="bottom-action-inner">
            <button className="btn btn-primary" onClick={() => router.push("/lobby")}>Go to lobby</button>
          </div>
        </div>
      </div>
    );
  }

  const entriesLocked = !["created", "waiting_kickoff"].includes(game.status);
  const currentPlayer = findIdentityPlayer(game.players, identity.snapshot);
  const currentColony = findIdentityColony(game, identity.snapshot);
  const walletReadyForCreate = Boolean(currentPlayer) || identity.ready;

  async function deploy() {
    if (entriesLocked) {
      setMsg("Entries are closed because live play has started.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      if (currentColony) {
        setMyColonyId(currentColony.colonyId);
        router.push(roomHref(game!));
        return;
      }

      let activeIdentity = identity.snapshot;
      let player = currentPlayer;
      if (!player) {
        const wallet = await identity.ensureWallet();
        activeIdentity = identityWithWallet(identity.snapshot, wallet);
      }
      const anonymousId = legacyAnonymousIdForPlayer(player, activeIdentity);
      const colonyName = name.trim() || identity.name || identity.short || `Colony ${Date.now().toString().slice(-4)}`;
      const payload = {
        name: colonyName,
        size: 5,
        style,
        favoriteContext: DEFAULT_FOCUS,
        infoNeed: DEFAULT_INFO,
        anonymousId,
      };

      let joined = game!;
      if (!player) {
        try {
          joined = await api.joinPlayer(game!.gameId, payload.name, undefined);
        } catch (error) {
          if ((error as ApiError).status !== 409) throw error;
          joined = await api.getGame(game!.gameId);
        }
      }
      player = findIdentityPlayer(joined.players, activeIdentity);
      const existing = findIdentityColony(joined, activeIdentity);
      if (existing) {
        setGame(joined);
        setMyColonyId(existing.colonyId);
        router.push(roomHref(joined));
        return;
      }

      const g = await api.addColony(game!.gameId, {
        ...payload,
        anonymousId: legacyAnonymousIdForPlayer(player, activeIdentity),
      });
      setGame(g);
      const mine = findIdentityColony(g, activeIdentity);
      if (mine) setMyColonyId(mine.colonyId);
      router.push(roomHref(g));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-4">
      <header className="page-top">
        <button className="icon-btn" aria-label="Back to room" onClick={() => router.back()}>←</button>
        <h1 className="hud-title text-[13px]">Your colony</h1>
        <span className="status-pill">Match</span>
      </header>

      <section className="mt-6 text-center">
        <p className="text-lg font-bold text-ink-soft">Build a colony for this match.</p>
        <p className="mt-2 text-sm text-ink-faint">Every colony starts with 5 fixed ant voters and 20 Sugar.</p>
        <p className="mt-1 text-xs font-bold text-gold-deep">Entries lock when live play starts.</p>
      </section>

      <section className="glass p-4">
        <p className="eyebrow">The whole game</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Colonies compete. Ants vote on each market, and your colony enters only when consensus meets its temperament. Results change Sugar. Most Sugar wins.
        </p>
      </section>

      {!identity.authenticated && !currentPlayer && (
        <section className="well p-3 text-xs leading-relaxed text-ink-soft">
          <b>Connect Phantom to continue.</b> You sign your identity once; there is no transaction and no SOL.
        </section>
      )}

      <section className="glass flex flex-col gap-4 p-4">
        <Field label="Name">
          <input className="input" maxLength={40} placeholder="Maya" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Temperament">
          <div className="grid gap-2">
            <Segmented options={STYLES} value={style} onChange={setStyle} />
            <p className="text-xs leading-relaxed text-ink-faint">{TEMPERAMENT_COPY[style]}</p>
          </div>
        </Field>
      </section>

      {msg && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{msg}</p>}

      <div className="bottom-action">
        <div className="bottom-action-inner">
          <button className="btn btn-primary" disabled={busy || entriesLocked || !walletReadyForCreate} onClick={deploy}>
            {entriesLocked
              ? "Entries closed"
              : !walletReadyForCreate
                ? "Checking wallet..."
              : busy
                ? "Creating..."
                : !identity.authenticated && !currentPlayer
                  ? "Connect wallet & create colony"
                  : "Create my colony"}
          </button>
          <button className="quiet-link py-2" onClick={() => router.push(roomHref(game))}>Back to room</button>
        </div>
      </div>
    </div>
  );
}

function roomHref(game: GameState): string {
  return game.roomScope === "private" && game.roomCode
    ? `/room/${game.roomCode}`
    : `/room/${game.gameId}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-bold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function normalizeRoomCode(value: string | null): string {
  const code = (value || "").replace(/\D/g, "").slice(0, 6);
  return code.length === 6 ? code : "";
}
