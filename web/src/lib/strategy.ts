import type { FavoriteContext, InfoNeed, Style } from "./types";

export interface StrategyOption<T extends string> {
  value: T;
  label: string;
  shortLabel: string;
  description: string;
}

export const STYLE_OPTIONS = [
  {
    value: "cautious",
    label: "Cautious",
    shortLabel: "Protect food",
    description: "Back fewer ant votes and preserve food when support is weak.",
  },
  {
    value: "balanced",
    label: "Balanced",
    shortLabel: "Stay flexible",
    description: "Balance food protection with steady participation across markets.",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    shortLabel: "Press the edge",
    description: "Back more supported votes and accept a larger food swing.",
  },
] as const satisfies readonly StrategyOption<Style>[];

export const FOCUS_OPTIONS = [
  {
    value: "balanced",
    label: "Balanced",
    shortLabel: "Any market",
    description: "Keep every market context in consideration.",
  },
  {
    value: "momentum",
    label: "Momentum",
    shortLabel: "Pressure",
    description: "Prioritize pressure, attacks, shots, and fast match swings.",
  },
  {
    value: "corners",
    label: "Corners",
    shortLabel: "Set pieces",
    description: "Favor corner and attacking set-piece windows.",
  },
  {
    value: "penalties",
    label: "Penalties",
    shortLabel: "Decisive calls",
    description: "Favor penalty and high-impact decision windows.",
  },
  {
    value: "chaos",
    label: "Chaos",
    shortLabel: "Volatility",
    description: "Favor fouls, cards, VAR, and volatile match moments.",
  },
] as const satisfies readonly StrategyOption<FavoriteContext>[];

export const INFO_NEED_OPTIONS = [
  {
    value: "low",
    label: "Low",
    shortLabel: "Act quickly",
    description: "Prefer acting from the match signal already available.",
  },
  {
    value: "medium",
    label: "Medium",
    shortLabel: "Check context",
    description: "Balance quick action with contextual evidence.",
  },
  {
    value: "high",
    label: "High",
    shortLabel: "Seek evidence",
    description: "Prefer stronger context before backing a market when available.",
  },
] as const satisfies readonly StrategyOption<InfoNeed>[];

export const STRATEGY_EDITABLE_STATUSES = new Set([
  "created",
  "waiting_kickoff",
  "running_replay",
  "running_live",
]);

export function isStrategyEditableStatus(status: string | null | undefined): boolean {
  return STRATEGY_EDITABLE_STATUSES.has(status || "");
}

export function optionLabel<T extends string>(
  options: readonly StrategyOption<T>[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value.replace(/_/g, " ");
}

export function strategySummary(strategy: {
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
}): string {
  return `${optionLabel(STYLE_OPTIONS, strategy.style)} · ${optionLabel(FOCUS_OPTIONS, strategy.favoriteContext)}`;
}
