// Age of Colony — Phantom (Solana) connect hook. Identity + accent only, no tx.
"use client";
import { useCallback, useEffect } from "react";
import { useStore } from "@/store/game";
import { accentHex, shortAddress } from "@/lib/accent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58?: () => string; toString?: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: any }>;
  disconnect: () => Promise<void>;
  on?: (event: string, cb: (arg?: any) => void) => void;
};

function detect(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  if (w.phantom?.solana) return w.phantom.solana as PhantomProvider;
  if (w.solana?.isPhantom) return w.solana as PhantomProvider;
  return null;
}

function pkStr(pk: any): string | null {
  if (!pk) return null;
  if (typeof pk === "string") return pk;
  if (typeof pk.toBase58 === "function") { try { return pk.toBase58(); } catch { /* */ } }
  if (typeof pk.toString === "function") return pk.toString();
  return null;
}

export function useWallet() {
  const wallet = useStore((s) => s.wallet);
  const setWallet = useStore((s) => s.setWallet);

  const apply = useCallback(
    (pubkey: string | null) => {
      setWallet({
        connected: !!pubkey,
        pubkey,
        accent: accentHex(pubkey),
        short: shortAddress(pubkey),
        installed: !!detect(),
      });
    },
    [setWallet],
  );

  useEffect(() => {
    const p = detect();
    setWallet({ installed: !!p });
    if (!p) return;
    p.on?.("connect", (pk) => apply(pkStr(pk || p.publicKey)));
    p.on?.("disconnect", () => apply(null));
    p.on?.("accountChanged", (pk) => apply(pkStr(pk)));
    p.connect({ onlyIfTrusted: true })
      .then((res) => apply(pkStr(res?.publicKey || p.publicKey)))
      .catch(() => {});
  }, [apply, setWallet]);

  const connect = useCallback(async () => {
    const p = detect();
    if (!p) {
      window.open("https://phantom.app/", "_blank", "noopener");
      throw new Error("Phantom wallet not found. Install it to connect.");
    }
    const res = await p.connect();
    apply(pkStr(res?.publicKey || p.publicKey));
  }, [apply]);

  const disconnect = useCallback(async () => {
    try { await detect()?.disconnect(); } catch { /* */ }
    apply(null);
  }, [apply]);

  return { wallet, connect, disconnect };
}
