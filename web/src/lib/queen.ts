// Queen Ant — the player's royal profile. Exactly one queen per wallet:
// the server table's PRIMARY KEY is the wallet pubkey, so upserts amend
// her and can never create a second. localStorage is a cache + offline
// fallback (used when the engine or its queen store is unreachable).
"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, queenAuthMessage, type QueenAuth } from "@/lib/api";
import { signWalletMessage } from "@/hooks/useWallet";
import { useStore } from "@/store/game";

export interface Queen {
  name: string;
  motto: string;
  emblem: string;
  crownedAt: number | string;
}

export type QueenSource = "server" | "local" | null;

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

export function saveQueenLocal(pubkey: string, queen: Queen): void {
  localStorage.setItem(keyFor(pubkey), JSON.stringify(queen));
}

export function removeQueenLocal(pubkey: string): void {
  localStorage.removeItem(keyFor(pubkey));
}

function applyName(name: string | null) {
  useStore.getState().setWallet({ name });
}

// Sign the ownership challenge (message format must match app/queen_auth.py).
async function signQueenChallenge(pubkey: string): Promise<QueenAuth> {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await signWalletMessage(queenAuthMessage(pubkey, ts));
  return { signature, ts };
}

// Loads the wallet's queen (server-first, local fallback) and mirrors her
// name into the store so room joins / player lists use the royal name.
export function useQueen() {
  const wallet = useStore((s) => s.wallet);
  const [queen, setQueen] = useState<Queen | null>(null);
  const [source, setSource] = useState<QueenSource>(null);

  useEffect(() => {
    let cancelled = false;
    const pk = wallet.pubkey;
    if (!pk) {
      setQueen(null);
      setSource(null);
      return;
    }
    const local = loadQueen(pk);
    // show the cached queen immediately, then reconcile with the server
    if (local) {
      setQueen(local);
      setSource("local");
      applyName(local.name);
    }
    (async () => {
      try {
        const remote = await api.getQueen(pk);
        if (cancelled) return;
        const q: Queen = {
          name: remote.name,
          motto: remote.motto ?? "",
          emblem: remote.emblem || "👑",
          crownedAt: remote.crownedAt ?? Date.now(),
        };
        saveQueenLocal(pk, q);
        setQueen(q);
        setSource("server");
        applyName(q.name);
      } catch (e) {
        if (cancelled) return;
        const err = e as ApiError;
        if (err?.status === 404 && !local) {
          setQueen(null);
          setSource(null);
        }
        // 404 with a local queen: she lives on this device only — the next
        // explicit save (which prompts for a wallet signature) syncs her up.
        // 503 (store unconfigured) or network error: keep the local fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.pubkey]);

  const save = useCallback(
    async (q: Omit<Queen, "crownedAt">) => {
      const pk = wallet.pubkey;
      if (!pk) return null;
      const existing = loadQueen(pk);
      // optimistic local write so the UI never blocks on the network
      const full: Queen = { ...q, crownedAt: existing?.crownedAt ?? Date.now() };
      saveQueenLocal(pk, full);
      setQueen(full);
      setSource("local");
      applyName(full.name);
      try {
        const auth = await signQueenChallenge(pk); // Phantom popup: prove the throne is yours
        const remote = await api.putQueen(pk, { name: q.name, motto: q.motto, emblem: q.emblem }, auth);
        const merged: Queen = { ...full, crownedAt: remote.crownedAt ?? full.crownedAt };
        saveQueenLocal(pk, merged);
        setQueen(merged);
        setSource("server");
        return merged;
      } catch {
        return full; // signature declined / engine offline — local cache holds her
      }
    },
    [wallet.pubkey],
  );

  const abdicate = useCallback(async () => {
    const pk = wallet.pubkey;
    if (!pk) return;
    removeQueenLocal(pk);
    setQueen(null);
    setSource(null);
    applyName(null);
    try {
      const auth = await signQueenChallenge(pk);
      await api.deleteQueen(pk, auth);
    } catch {
      /* signature declined or offline — server copy stays; local is cleared */
    }
  }, [wallet.pubkey]);

  return { wallet, queen, source, save, abdicate };
}

// Null-rendering sync so the queen's name is applied app-wide on load.
export function QueenSync() {
  useQueen();
  return null;
}
