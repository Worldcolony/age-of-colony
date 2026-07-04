// Age of Colony — client game store (zustand).
"use client";
import { create } from "zustand";
import type { Fixture, GameEvent, GameState } from "@/lib/types";

interface PlayerState {
  name: string | null;
}

interface Store {
  player: PlayerState;
  setPlayer: (p: Partial<PlayerState>) => void;

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
  player: { name: null },
  setPlayer: (p) => set((s) => ({ player: { ...s.player, ...p } })),

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
