import type { AnalysisRole, FavoriteContext, InfoNeed, Style } from "./types";

export interface StrategyOption<T extends string> {
  value: T;
  label: string;
  shortLabel: string;
  description: string;
}

export interface StyleDoctrine extends StrategyOption<Style> {
  gateVotes: number;
  cadenceLabel: string;
}

export const STYLE_OPTIONS = [
  {
    value: "cautious",
    label: "Cautious",
    shortLabel: "Wait for strength",
    description: "Enter only when ant consensus is especially strong.",
    gateVotes: 14,
    cadenceLabel: "Fewer, stronger entries",
  },
  {
    value: "balanced",
    label: "Balanced",
    shortLabel: "Stay flexible",
    description: "Enter when ant consensus is clear.",
    gateVotes: 12,
    cadenceLabel: "Measured entries",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    shortLabel: "Press the edge",
    description: "Enter more often because lighter consensus is enough.",
    gateVotes: 11,
    cadenceLabel: "More frequent entries",
  },
] as const satisfies readonly StyleDoctrine[];

export const ANALYSIS_ROLE_OPTIONS = [
  {
    value: "reactive",
    label: "Scout",
    shortLabel: "Last 5 minutes",
    description: "Tracks recent pressure, shots, corners, and fast changes in the match.",
  },
  {
    value: "statistical",
    label: "Analyst",
    shortLabel: "Full match",
    description: "Compares cumulative trends and resists short-lived bursts of momentum.",
  },
  {
    value: "situational",
    label: "Tactician",
    shortLabel: "Score and minute",
    description: "Reads the score, time remaining, and each team's urgency.",
  },
] as const satisfies readonly StrategyOption<AnalysisRole>[];

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
  analysisRole?: AnalysisRole | null;
}): string {
  const doctrine = optionLabel(STYLE_OPTIONS, strategy.style);
  return strategy.analysisRole
    ? `${optionLabel(ANALYSIS_ROLE_OPTIONS, strategy.analysisRole)} · ${doctrine}`
    : doctrine;
}
