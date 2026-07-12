// Age of Colony — bridge from the HUD to the living 3D WorldColony backdrop.
// The world runs isolated in an iframe (/world.html); this posts game state
// into it so rooms and colonies exist as real 3D mounds, not just panels.
import type { Colony } from "@/lib/types";
import { colonySugar } from "@/lib/sugar";

export interface WorldColonyPayload {
  id: string;
  name: string;
  accent?: string;
  ants?: number;
  size?: number;
  food?: number;
  sugar?: number;
  accuracy?: number;
  score?: number;
}

function worldWindow(): Window | null {
  if (typeof document === "undefined") return null;
  const frame = document.querySelector<HTMLIFrameElement>("iframe[data-world]");
  return frame?.contentWindow ?? null;
}

function post(message: Record<string, unknown>) {
  worldWindow()?.postMessage(message, window.location.origin);
}

// Warm faction accents matching the parchment palette, assigned by roster order.
const ACCENTS = ["#b07e1c", "#4e7e2a", "#c25a3a", "#3fa89f", "#8e79c4", "#876012"];

export function colonyPayload(colony: Colony, index: number): WorldColonyPayload {
  return {
    id: colony.colonyId,
    name: colony.name,
    accent: ACCENTS[index % ACCENTS.length],
    ants: colony.antsAlive,
    size: colony.size,
    food: colonySugar(colony),
    sugar: colonySugar(colony),
    accuracy: colony.accuracy,
    score: colony.score,
  };
}

export const worldLink = {
  /** Found/refresh the game's colonies as 3D mounds. Idempotent per colonyId. */
  syncColonies(colonies: Colony[], myColonyId?: string | null) {
    if (!colonies.length) return;
    post({
      type: "aoc:sync",
      colonies: colonies.map(colonyPayload),
      myId: myColonyId ?? null,
    });
  },
  /** Flash the game colonies' ground rings (votes, settlements, hatches). */
  pulse(n = 1) {
    post({ type: "aoc:pulse", n });
  },
  /** Floating combat text over a mound: "+12 Sugar", "market open". */
  fx(colonyId: string | null, kind: "gain" | "loss" | "market" | "info" | "rally" | "death" | "recall" | "switch" | "victory", text: string) {
    post({ type: "aoc:fx", id: colonyId ?? undefined, kind, text });
  },
  /** Fly the world camera to one game colony and select it. */
  focusColony(colonyId: string) {
    post({ type: "aoc:focus", id: colonyId });
  },
  /** Pull the camera back to the world overview orbit. */
  overview() {
    post({ type: "aoc:overview" });
  },
  /** Let touches/clicks through to the world (fullscreen World view). */
  setInteractive(on: boolean) {
    post({ type: "aoc:interactive", on });
  },
};
