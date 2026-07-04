"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AntMarch } from "@/components/AntMarch";

export default function SplashPage() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function onEnter() {
    router.push("/lobby");
  }

  async function onDemo() {
    setBusy(true);
    setStatus("Spinning up a demo match…");
    try {
      const game = await api.demoRun({});
      router.push(game?.gameId ? `/cockpit/${game.gameId}` : "/lobby");
    } catch (e) {
      setStatus((e as Error).message.includes("OPENROUTER") ? "Demo needs OPENROUTER_API_KEY on the engine." : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-150px)] flex-1 flex-col justify-center gap-4">
      <div className="glass bracket signal-brand overflow-hidden">
        <AntMarch className="border-b border-[color:var(--brd-soft)] bg-[rgba(5,12,11,0.68)] py-1.5" />
        <div className="grid gap-5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow mb-2">Live colony engine</p>
              <h1 className="hud-title text-[42px] leading-[0.92]">
                Age
                <br />
                of Colony
              </h1>
            </div>
            <div className="nest-emblem h-20 w-20 shrink-0 text-4xl">
              <span>🐜</span>
            </div>
          </div>

          <div className="tunnel-map plate grid gap-3 p-4">
            <div className="flex items-center justify-between font-bold">
              <span>Argentina</span>
              <span className="font-display text-xl text-gold">2 - 1</span>
              <span>France</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs text-ink-faint">
              <span className="plate px-2 py-1">20 alive</span>
              <span className="plate px-2 py-1 text-lime">market open</span>
              <span className="plate px-2 py-1">+14 food</span>
            </div>
          </div>

          <p className="max-w-[320px] text-sm leading-relaxed text-ink-soft">
            Command your colony, read the match pressure, and let every ant vote before the market closes.
          </p>

          <div className="flex flex-col gap-3">
            <button className="btn btn-primary" disabled={busy} onClick={onEnter}>
              Enter lobby
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onDemo}>
              ▶ Watch demo
            </button>
            {status && <p className="min-h-4 text-xs text-ink-faint">{status}</p>}
          </div>
          <p className="blink font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            Signal locked · room engine ready
          </p>
        </div>
      </div>
      <p className="text-center font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        TXLine · live match rooms
      </p>
    </div>
  );
}
