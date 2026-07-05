"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { getAnonId } from "@/lib/anon";
import { useStore } from "@/store/game";
import { Segmented, Chips } from "@/components/Segmented";
import type { FavoriteContext, InfoNeed, Style } from "@/lib/types";

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

export default function SetupPage() {
  const router = useRouter();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const setMyColonyId = useStore((s) => s.setMyColonyId);

  const [name, setName] = useState("");
  const [style, setStyle] = useState<Style>("balanced");
  const [ground, setGround] = useState<FavoriteContext>("momentum");
  const [info, setInfo] = useState<InfoNeed>("medium");
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
        const mine = loaded.colonies.find((colony) => colony.playerAnonymousId === getAnonId());
        if (mine) setMyColonyId(mine.colonyId);
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

  if (!game?.gameId) {
    return (
      <div className="flex min-h-[calc(100dvh-36px)] flex-col gap-3">
        <header className="page-top">
          <button className="icon-btn" aria-label="Back" onClick={() => router.push("/lobby")}>←</button>
          <h1 className="hud-title text-[13px]">Your colony</h1>
          <span />
        </header>
        <div className="glass p-4 text-center text-sm text-ink-faint">
          {hydrating ? "Loading room..." : msg || "Pick a match and create a room first."}
        </div>
        <div className="bottom-action">
          <div className="bottom-action-inner">
            <button className="btn btn-primary" onClick={() => router.push("/lobby")}>Go to lobby</button>
          </div>
        </div>
      </div>
    );
  }

  async function deploy() {
    setBusy(true);
    setMsg("");
    const payload = {
      name: name.trim() || `Colony ${Date.now().toString().slice(-4)}`,
      size: 20,
      style,
      favoriteContext: ground,
      infoNeed: info,
      anonymousId: getAnonId(),
    };
    try {
      const g = await api.addColony(game!.gameId, payload);
      setGame(g);
      const mine = g.colonies.find((c) => c.name === payload.name || c.playerAnonymousId === payload.anonymousId);
      if (mine) setMyColonyId(mine.colonyId);
      router.push(`/room/${g.roomCode || game!.roomCode || game!.gameId}`);
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
        <span className="status-pill">Room {game.roomCode}</span>
      </header>

      <section className="mt-6 text-center">
        <p className="text-lg text-ink-soft">Create your colony before kickoff.</p>
        <p className="mt-2 text-sm text-ink-faint">Every colony starts fair with 20 ants and 20 food.</p>
      </section>

      <section className="glass flex flex-col gap-4 p-4">
        <Field label="Name">
          <input className="input" maxLength={40} placeholder="Maya" value={name} onChange={(e) => setName(e.target.value)} />
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
      </section>

      {msg && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{msg}</p>}

      <div className="bottom-action">
        <div className="bottom-action-inner">
          <button className="btn btn-primary" disabled={busy} onClick={deploy}>
            {busy ? "Creating..." : "Create my colony"}
          </button>
          <button className="quiet-link py-2" onClick={() => router.push(`/room/${game.roomCode || game.gameId}`)}>Back to room</button>
        </div>
      </div>
    </div>
  );
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
