"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/hooks/useWallet";
import { api } from "@/lib/api";

export default function SplashPage() {
  const router = useRouter();
  const { wallet, connect } = useWallet();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function onConnect() {
    if (wallet.connected) return router.push("/lobby");
    setBusy(true);
    try {
      await connect();
      router.push("/lobby");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
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
    <div className="flex min-h-[86dvh] flex-1 flex-col items-center justify-center">
      <div className="glass bracket w-full max-w-[340px] p-6 text-center">
        <p className="eyebrow mb-3">Live Colony Engine</p>
        <h1 className="hud-title glow-lime text-[15px] leading-[1.7]">
          Age of
          <br />
          Colony
        </h1>
        <p className="mx-auto mt-4 max-w-[280px] text-sm leading-relaxed text-ink-soft">
          Command your colony. Predict the match. Rule the lobby.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button className="btn btn-primary" disabled={busy} onClick={onConnect}>
            {wallet.connected ? `Enter · ${wallet.short}` : "Connect Phantom Wallet"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={onDemo}>
            Watch demo
          </button>
          {status && <p className="min-h-4 text-xs text-ink-faint">{status}</p>}
        </div>
      </div>
      <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        ▸ Solana · TxODDS World Cup
      </p>
    </div>
  );
}
