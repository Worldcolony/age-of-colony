// Age of Colony — engine API types (mirrors app/game/harness.py public_state shapes).

export type Style = "cautious" | "balanced" | "aggressive";
export type FavoriteContext = "penalties" | "corners" | "momentum" | "chaos" | "balanced";
export type InfoNeed = "low" | "medium" | "high";
export type GameStatus = "created" | "running_replay" | "running_live" | "finished" | string;

export interface Fixture {
  fixtureId: number | string;
  participant1?: string | null;
  participant2?: string | null;
  competition?: string;
  competitionId?: number;
  startTime?: number; // epoch ms
  startTimeIso?: string;
}

export interface Colony {
  colonyId: string;
  name: string;
  size: number;
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
  score: number;
  accuracy?: number;
  wins?: number;
  losses?: number;
  food: number;
  larvae: number;
  antsAlive: number;
  antsActive?: number;
  antsEngaged?: number;
  antsBorn?: number;
  antsWounded: number;
  antsDead: number;
  infoPurchases?: number;
  scoreBreakdown?: Record<string, number>;
  archetypes?: Record<string, unknown>;
}

export interface Player {
  playerId: string;
  name: string;
}

export interface OpportunityOption {
  value?: string;
  label?: string;
}

export interface Opportunity {
  label?: string;
  question?: string;
  kind?: string; // safe | precision | chaos | hero
  options?: OpportunityOption[];
  deadlineLabel?: string;
}

export interface MatchScore {
  participant1?: number | null;
  participant2?: number | null;
}

export interface GameState {
  gameId: string;
  roomCode?: string;
  fixtureId?: number | string;
  participant1?: string | null;
  participant2?: string | null;
  competition?: string | null;
  startTime?: number | null;
  startTimeIso?: string | null;
  owner?: { anonymousId?: string | null; name?: string | null } | null;
  status: GameStatus;
  mode?: string | null;
  eventIndex?: number;
  players: Player[];
  match?: { score?: MatchScore | null; possessionLabel?: string | null };
  colonies: Colony[];
  activeOpportunities: Opportunity[];
  agentUsage?: unknown;
  logCount?: number;
}

export interface GameEvent {
  index: number;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt?: number;
}

export interface CreateColonyBody {
  name: string;
  size: number;
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
}

export interface StrategyPatch {
  style?: Style;
  favoriteContext?: FavoriteContext;
  infoNeed?: InfoNeed;
}
