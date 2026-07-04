// Age of Colony — tiny bus so the HUD can drive the 3D world (pulses on game events).
// Kept outside React so useFrame reads it without re-renders.

export type Tier = "high" | "mid" | "low";

const state = {
  pulse: 0, // decays each frame; bumped on events
  accent: "#b6ff3c", // colony accent color (pheromone/hero)
  intensity: 0.5, // 0..1 overall colony "activity" (drives ant count feel / speed)
  tier: "high" as Tier,
};

export const worldBus = {
  get: () => state,
  /** Flash the colony — call on votes/opportunities/settlements. n = strength. */
  pulse(n = 1) {
    state.pulse = Math.min(6, state.pulse + n);
  },
  setAccent(hex: string) {
    state.accent = hex || "#b6ff3c";
  },
  setIntensity(v: number) {
    state.intensity = Math.max(0, Math.min(1, v));
  },
  setTier(t: Tier) {
    state.tier = t;
  },
  /** call once per frame from the scene */
  decay(dt: number) {
    state.pulse = Math.max(0, state.pulse - dt * 2.2);
  },
};

export function detectTier(): Tier {
  if (typeof navigator === "undefined") return "high";
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory || 4;
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  if (coarse || cores <= 4 || mem <= 3) return "low";
  if (cores <= 8) return "mid";
  return "high";
}
