"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { flag, teamName } from "@/lib/format";
import type { Player } from "@/lib/types";

export default function RoomPage() {
  const router = useRouter();
  const { code } = useParams<{ code: string }>();
  const wallet = useStore((s) => s.wallet);
  const mf = useStore((s) => s.matchFixture);
  const setGame = useStore((s) => s.setGame);

  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState(wallet.short || "");
  const [msg, setMsg] = useState("");

  const p1 = teamName(mf?.participant1);
  const p2 = teamName(mf?.participant2);

  useEffect(() => {
    api.getGame(code).then((g) => { setGame(g); setPlayers(g.players || []); }).catch((e) => setMsg((e as Error).message));
  }, [code, setGame]);

  useGameStream(code, {
    onState: (g) => setPlayers(g.players || []),
    onEvent: (e) => { if (e.kind === "player_joined") setMsg(e.message); },
  });

  async function join() {
    if (!name.trim()) return setMsg("Enter a name.");
    try {
      const g = await api.joinPlayer(code, name.trim());
      setGame(g);
      setPlayers(g.players || []);
      useStore.getState().setWallet({ name: name.trim() });
      setMsg(`${name} joined.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(code); setMsg("Code copied."); } catch { /* */ }
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

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-sm">Room code</h2>
        <div className="flex items-center justify-between">
          <strong className="font-mono text-xl tracking-[0.15em]">{code}</strong>
          <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-1 text-sm" onClick={copy}>Copy · Share</button>
        </div>
        <p className="text-xs text-ink-faint">Share this code so friends can join the same room.</p>
      </div>

      <div className="glass flex flex-col gap-3 p-4">
        <h2 className="hud-title text-sm">Join as player</h2>
        <div className="flex gap-2">
          <input className="input" maxLength={32} placeholder={wallet.short || "Your name"} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={join}>Join</button>
        </div>
        <div className="flex flex-col gap-2">
          {players.length === 0 ? (
            <span className="text-center text-sm text-ink-faint">No players yet.</span>
          ) : (
            players.map((p) => (
              <div key={p.playerId || p.name} className="glass flex items-center justify-between px-4 py-2.5">
                <strong>{p.name}</strong>
                <span className="rounded-full border border-lime/40 px-3 py-1 text-xs font-bold text-lime">ready</span>
              </div>
            ))
          )}
        </div>
      </div>

      {msg && <p className="text-center text-sm text-ink-soft">{msg}</p>}
      <button className="btn btn-primary" onClick={() => router.push("/setup")}>Set up my colony →</button>
    </div>
  );
}
