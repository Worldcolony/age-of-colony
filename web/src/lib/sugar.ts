import type { Colony, OpportunityOption } from "./types";

export function colonySugar(colony: Colony | null | undefined): number {
  if (!colony) return 0;
  return colony.sugar ?? colony.economy?.sugarBalance ?? colony.economy?.balance ?? colony.food ?? 0;
}

export function colonySugarNet(colony: Colony | null | undefined): number {
  if (!colony) return 0;
  return colony.sugarNet ?? colony.economy?.sugarNet ?? colony.economy?.net ?? colony.foodNet ?? colonySugar(colony) - 20;
}

export function colonyReservedSugar(colony: Colony | null | undefined): number {
  if (!colony) return 0;
  return colony.economy?.sugarReserved ?? colony.economy?.reserved ?? 0;
}

export function colonyAvailableSugar(colony: Colony | null | undefined): number {
  if (!colony) return 0;
  return colony.economy?.sugarAvailable
    ?? colony.economy?.available
    ?? Math.max(0, colonySugar(colony) - colonyReservedSugar(colony));
}

export function optionRewardSugar(option: OpportunityOption): number | null {
  return finiteNumber(option.rewardSugar ?? option.multiplier);
}

export function optionRiskSugar(option: OpportunityOption): number | null {
  return finiteNumber(option.riskSugar ?? 2);
}

export function formatSugar(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
