"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";

export function WalletHudButton() {
  const pathname = usePathname();
  const { wallet, connect, disconnect, identityNotice } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleConnect() {
    if (busy || !wallet.ready) return;
    setBusy(true);
    setError("");
    try {
      await connect();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await disconnect();
    } finally {
      setBusy(false);
    }
  }

  const verified = wallet.authenticated && Boolean(wallet.pubkey);
  const connectLabel = !wallet.ready
    ? "Checking wallet…"
    : busy
      ? verified
        ? "Disconnecting…"
        : "Waiting for Phantom…"
      : wallet.connected
        ? "Verify wallet"
        : "Connect wallet";

  if (pathname === "/" || pathname === "/admin" || pathname === "/queen") return null;

  return (
    <div className="wallet-hud" data-connected={verified}>
      {verified ? (
        <div className="wallet-hud-connected" title={identityNotice}>
          <Link href="/queen" className="wallet-hud-profile" aria-label={`Wallet ${wallet.short}, open profile`}>
            <span className="wallet-hud-status" aria-hidden="true" />
            <span className="wallet-hud-address">{wallet.short}</span>
          </Link>
          <button
            type="button"
            className="wallet-hud-disconnect"
            aria-label="Disconnect wallet"
            title="Disconnect wallet"
            disabled={busy}
            onClick={handleDisconnect}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="wallet-hud-connect"
          disabled={busy || !wallet.ready}
          aria-busy={busy}
          aria-label={connectLabel}
          title={identityNotice}
          onClick={handleConnect}
        >
          <span className="wallet-hud-icon" aria-hidden="true">🔗</span>
          <span className="wallet-hud-label">{connectLabel}</span>
        </button>
      )}

      {error && <p className="wallet-hud-error" role="alert">{error}</p>}
    </div>
  );
}
