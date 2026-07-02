// Stable per-browser id so the engine recognizes a returning player/owner.
"use client";
export function getAnonId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "aoc_anon_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `anon_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
    localStorage.setItem(KEY, id);
  }
  return id;
}
