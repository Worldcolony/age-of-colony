"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { getAnonId } from "@/lib/anon";
import { flag, teamName } from "@/lib/format";
import type { Player } from "@/lib/types";

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

  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const anonId = typeof window !== "undefined" ? getAnonId() : "";

  useEffect(() => {
    api
      .getRoomByCode(code)
      .then((g) => {
        setGame(g);
        setPlayers(g.players || []);
        if (g.players?.some((p) => (p as Player & { anonymousId?: string }).anonymousId === anonId)) setJoined(true);
      })
      .catch((e) => setMsg((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // live presence via the game's SSE stream (keyed by gameId, not room code)
  useGameStream(game?.gameId ?? null, {
    onState: (g) => setPlayers(g.players || []),
    onEvent: (e) => { if (e.kind === "player_joined") setMsg(e.message); },
  });

  async function join() {
    if (!name.trim()) return setMsg("Enter a name.");
    try {
      const g = await api.joinRoomByCode(code, name.trim(), anonId);
      setGame(g);
      setPlayers(g.players || []);
      useStore.getState().setWallet({ name: name.trim() });
      setJoined(true);
      setMsg(`${name} joined.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setMsg("Code copied.");
    } catch {
      setMsg(code);
    }
  }

  async function share() {
    const text = `Join my Age of Colony room — code ${code} (${p1} vs ${p2})`;
    try {
      if (navigator.share) await navigator.share({ title: "Age of Colony", text });
      else { await navigator.clipboard.writeText(text); setMsg("Invite copied."); }
    } catch { /* cancelled */ }
  }

  return (
    <div className="flex flex-col gap-3">
      <button className="text-sm font-semibold text-ink-soft" onClick={() => router.push("/lobby")}>← Lobby</button>

      <div className="glass p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold"><span className="text-2xl">{flag(p1)}</span>{p1}</div>
          <span className="font-mono text-xs text-ink-faint">VS</span>
          <div className="flex flex-row-reverse items-center gap-2 font-bold"><span className="text-2xl">{flag(p2)}</span>{p2}</div>
        </div>
      </div>

      <div className="glass bracket flex flex-col items-center gap-2 p-4">
        <p className="eyebrow">Room code</p>
        <strong className="font-mono text-3xl tracking-[0.35em] text-ink">{code}</strong>
        <div className="mt-1 flex w-full gap-2">
          <button className="btn btn-ghost" onClick={copyCode}>Copy</button>
          <button className="btn btn-ghost" onClick={share}>Share invite</button>
        </div>
        <p className="text-center text-xs text-ink-faint">Friends join with this 6-digit code from the lobby.</p>
      </div>

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-[11px]">Players</h2>
        <div className="flex gap-2">
          <input className="input" maxLength={32} placeholder={wallet.short || "Your name"} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={join}>{joined ? "Update" : "Join"}</button>
        </div>
        <div className="flex flex-col gap-2">
          {players.length === 0 ? (
            <span className="text-center text-sm text-ink-faint">No players yet — you go first.</span>
          ) : (
            players.map((p) => (
              <div key={p.playerId || p.name} className="flex items-center justify-between rounded-md border-2 border-brd bg-slot px-4 py-2.5">
                <strong>{p.name}</strong>
                <span className="rounded-full border-2 border-green/50 px-3 py-0.5 text-xs font-bold text-green">ready</span>
              </div>
            ))
          )}
        </div>
      </div>

      {msg && <p className="text-center text-sm text-ink-soft">{msg}</p>}
      <button className="btn btn-primary" disabled={!game?.gameId} onClick={() => router.push("/setup")}>
        Set up my colony →
      </button>
    </div>
  );
}
