// Queen Ant — the player's royal profile. Exactly one queen per wallet:
// records are keyed by the wallet pubkey, so a wallet can only ever
// hold a single queen (saving again updates her, never adds another).
"use client";
import { useEffect, useState, useCallback } from "react";
import { useStore } from "@/store/game";

export interface Queen {
  name: string;
  motto: string;
  emblem: string;
  crownedAt: number;
}

export const EMBLEMS = ["👑", "🐜", "⚔️", "🛡️", "🌿", "🔥", "💎", "🍄"] as const;

const keyFor = (pubkey: string) => `aoc_queen_v1:${pubkey}`;

export function loadQueen(pubkey: string | null): Queen | null {
  if (!pubkey || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(keyFor(pubkey));
    if (!raw) return null;
    const q = JSON.parse(raw) as Queen;
    return q?.name ? q : null;
  } catch {
    return null;
  }
}

export function saveQueen(pubkey: string, queen: Queen): void {
  localStorage.setItem(keyFor(pubkey), JSON.stringify(queen));
}

export function removeQueen(pubkey: string): void {
  localStorage.removeItem(keyFor(pubkey));
}

// Loads the wallet's queen and mirrors her name into the store so
// room joins / player lists use the royal name everywhere.
export function useQueen() {
  const wallet = useStore((s) => s.wallet);
  const [queen, setQueen] = useState<Queen | null>(null);

  useEffect(() => {
    const q = loadQueen(wallet.pubkey);
    setQueen(q);
    if (q) useStore.getState().setWallet({ name: q.name });
  }, [wallet.pubkey]);

  const save = useCallback(
    (q: Omit<Queen, "crownedAt">) => {
      if (!wallet.pubkey) return null;
      const existing = loadQueen(wallet.pubkey);
      const full: Queen = { ...q, crownedAt: existing?.crownedAt ?? Date.now() };
      saveQueen(wallet.pubkey, full);
      setQueen(full);
      useStore.getState().setWallet({ name: full.name });
      return full;
    },
    [wallet.pubkey],
  );

  const abdicate = useCallback(() => {
    if (!wallet.pubkey) return;
    removeQueen(wallet.pubkey);
    setQueen(null);
    useStore.getState().setWallet({ name: null });
  }, [wallet.pubkey]);

  return { wallet, queen, save, abdicate };
}

// Null-rendering sync so the queen's name is applied app-wide on load.
export function QueenSync() {
  useQueen();
  return null;
}
