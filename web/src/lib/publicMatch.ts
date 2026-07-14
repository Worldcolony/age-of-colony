"use client";

import type { GameState } from "@/lib/types";

const PUBLIC_MATCH_STORAGE_PREFIX = "aoc_public_match";
const RESUMABLE_PUBLIC_STATUSES = new Set(["created", "waiting_kickoff", "running_live"]);

function storageKey(wallet: string): string {
  return `${PUBLIC_MATCH_STORAGE_PREFIX}:${wallet}`;
}

export function isResumablePublicMatch(game: GameState | null | undefined): game is GameState {
  return Boolean(
    game?.gameId
    && game.roomKind === "player"
    && game.roomScope === "global"
    && RESUMABLE_PUBLIC_STATUSES.has(game.status),
  );
}

export function rememberPublicMatch(game: GameState, wallet: string): void {
  if (typeof window === "undefined" || !wallet || !isResumablePublicMatch(game)) return;
  localStorage.setItem(storageKey(wallet), game.gameId);
}

export function rememberedPublicMatchId(wallet: string): string | null {
  if (typeof window === "undefined" || !wallet) return null;
  return localStorage.getItem(storageKey(wallet));
}

export function forgetPublicMatch(wallet: string): void {
  if (typeof window === "undefined" || !wallet) return;
  localStorage.removeItem(storageKey(wallet));
}

export function publicMatchHref(game: GameState): string {
  return game.status === "running_live"
    ? `/cockpit/${game.gameId}`
    : `/room/${game.gameId}`;
}
