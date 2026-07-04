"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { Segmented, Chips } from "@/components/Segmented";
import type { FavoriteContext, InfoNeed, Style } from "@/lib/types";

const SIZES = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
];
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "🛡️ cautious" },
  { value: "balanced", label: "⚖️ balanced" },
  { value: "aggressive", label: "⚔️ aggressive" },
];
const GROUNDS: FavoriteContext[] = ["balanced", "penalties", "corners", "momentum", "chaos"];
const INFO: { value: InfoNeed; label: string }[] = [
  { value: "low", label: "🕯️ low" },
  { value: "medium", label: "🔎 medium" },
  { value: "high", label: "📡 high" },
];

export default function SetupPage() {
  const router = useRouter();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const setMyColonyId = useStore((s) => s.setMyColonyId);

  const [name, setName] = useState("");
  const [size, setSize] = useState("20");
  const [style, setStyle] = useState<Style>("balanced");
  const [ground, setGround] = useState<FavoriteContext>("balanced");
  const [info, setInfo] = useState<InfoNeed>("medium");
  const [msg, setMsg] = useState("");

  if (!game?.gameId) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="hud-title text-[24px]">My Colony</h1>
        <div className="glass p-4 text-center text-sm text-ink-faint">Pick a match and create a room first.</div>
        <button className="btn btn-primary" onClick={() => router.push("/lobby")}>Go to lobby</button>
      </div>
    );
  }

  const shown = Math.min(Number(size), 24);
  async function deploy() {
    const payload = {
      name: name.trim() || `Colony ${Date.now().toString().slice(-4)}`,
      size: Number(size),
      style,
      favoriteContext: ground,
      infoNeed: info,
    };
    try {
      const g = await api.addColony(game!.gameId, payload);
      setGame(g);
      const mine = g.colonies.find((c) => c.name === payload.name);
      if (mine) setMyColonyId(mine.colonyId);
      router.push(`/cockpit/${game!.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button className="text-sm font-semibold text-ink-soft" onClick={() => router.back()}>← Back</button>
      <div>
        <p className="eyebrow">Pre-match</p>
        <h1 className="hud-title text-[28px]">Tune your colony</h1>
      </div>

      <div className="glass tunnel-map grid min-h-32 place-items-center gap-2 p-4">
        <div className="flex flex-wrap justify-center gap-1 text-lg">
          {Array.from({ length: shown }).map((_, i) => (
            <span key={i}>{style === "aggressive" && i % 5 === 0 ? "🔴" : style === "cautious" && i % 5 === 0 ? "🔵" : "🐜"}</span>
          ))}
          {Number(size) > shown && <span className="text-ink-faint">+{Number(size) - shown}</span>}
        </div>
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
          {style} · {ground} · intel {info}
        </p>
      </div>

      <Field label="Colony name">
        <input className="input" maxLength={40} placeholder="Red Nest" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Size"><Segmented options={SIZES} value={size} onChange={setSize} /></Field>
      <Field label="Behavior style"><Segmented options={STYLES} value={style} onChange={setStyle} /></Field>
      <Field label="Favorite ground"><Chips options={GROUNDS} value={ground} onChange={setGround} /></Field>
      <Field label="Info need"><Segmented options={INFO} value={info} onChange={setInfo} /></Field>

      {msg && <p className="text-sm text-danger">{msg}</p>}
      <div className="sticky bottom-[92px] z-20 mt-1">
        <button className="btn btn-primary" onClick={deploy}>Deploy colony</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}
