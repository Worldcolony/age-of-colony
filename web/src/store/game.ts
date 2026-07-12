// Age of Colony — client game store (zustand).
"use client";
import { create } from "zustand";
import type { Fixture, GameEvent, GameState } from "@/lib/types";

export interface WalletState {
  installed: boolean;
  ready: boolean;
  connected: boolean;
  authenticated: boolean;
  pubkey: string | null;
  accent: string;
  short: string;
  name: string | null;
}

interface Store {
  wallet: WalletState;
  setWallet: (w: Partial<WalletState>) => void;

  game: GameState | null;
  events: GameEvent[];
  myColonyId: string | null;
  matchFixture: Fixture | null;

  setGame: (g: GameState | null) => void;
  pushEvent: (e: GameEvent) => void;
  setMyColonyId: (id: string | null) => void;
  setMatchFixture: (f: Fixture | null) => void;
  resetGame: () => void;
}

export const useStore = create<Store>((set) => ({
  wallet: {
    installed: false,
    ready: false,
    connected: false,
    authenticated: false,
    pubkey: null,
    accent: "#38E8FF",
    short: "",
    name: null,
  },
  setWallet: (w) => set((s) => ({ wallet: { ...s.wallet, ...w } })),

  game: null,
  events: [],
  myColonyId: null,
  matchFixture: null,

  setGame: (g) => set({ game: g }),
  pushEvent: (e) => set((s) => ({ events: [...s.events, e] })),
  setMyColonyId: (id) => set({ myColonyId: id }),
  setMatchFixture: (f) => set({ matchFixture: f }),
  resetGame: () => set({ game: null, events: [], myColonyId: null }),
}));
