// Age of Colony — engine API types (mirrors app/game/harness.py public_state shapes).

export type Style = "cautious" | "balanced" | "aggressive";
export type AnalysisRole = "reactive" | "statistical" | "situational";
export type FavoriteContext = "penalties" | "corners" | "momentum" | "chaos" | "balanced";
export type InfoNeed = "low" | "medium" | "high";
export type TeamRouting = "neutral" | "participant1" | "participant2";
export type GameStatus = "created" | "waiting_kickoff" | "running_replay" | "running_live" | "finished" | string;
export type AgentCallMode = "per_ant" | "batch";

export interface ColonyStrategy {
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
  teamRouting?: TeamRouting;
}

export interface AntStrategy extends ColonyStrategy {
  analysisRole: AnalysisRole;
  inheritsRole?: boolean;
  roleSource?: "archetype" | "custom" | string;
  inheritsGlobal: boolean;
  source: "colony" | "custom" | "ant" | string;
}

export interface AntPerformance {
  attempts: number;
  wins: number;
  losses: number;
  successRate: number | null;
  recentLosses: number;
}

export interface Ant {
  antId: string;
  archetype: string;
  status: "active" | "wounded" | "dead" | string;
  alive: boolean;
  active: boolean;
  naturalFocus: FavoriteContext | string;
  influence: number;
  strategy: AntStrategy;
  performance: AntPerformance;
}

export interface ColonyAntsResponse {
  colonyId: string;
  strategyRevision: number;
  globalStrategy: ColonyStrategy;
  ants: Ant[];
}

export interface AntStrategyResponse {
  colonyId: string;
  strategyRevision: number;
  ant: Ant;
}

export type AntBetStatus = "open" | "won" | "lost" | "void" | "recalled";

export interface AntBet {
  predictionId: string;
  opportunityId: string;
  status: AntBetStatus;
  marketLabel: string;
  context?: string | null;
  minute?: number | null;
  optionId?: string | null;
  optionLabel: string;
  risk?: string | null;
  multiplier?: number | null;
  rewardSugar?: number | null;
  riskSugar?: number | null;
  foodAtRisk?: number | null;
  sugarAtRisk?: number | null;
  colonyFoodDelta?: number | null;
  colonySugarDelta?: number | null;
  antShareDelta?: number | null;
  voteCount: number;
  infoBought: boolean;
  strategyRevision?: number | null;
  strategy?: AntStrategy | null;
  decisionReason?: string | null;
  createdEventIndex: number;
  createdAt: number;
  resolvedEventIndex?: number | null;
  resolvedAt?: number | null;
  resolutionReason?: string | null;
  resolvedOutcome?: {
    label?: string | null;
    detail?: string | null;
  } | null;
}

export interface AntStrategyChange {
  eventIndex: number;
  changedAt: number;
  strategyRevision?: number | null;
  strategy: AntStrategy;
}

export interface AntDetailResponse {
  colonyId: string;
  strategyRevision: number;
  ant: Ant;
  bets: AntBet[];
  strategyHistory: AntStrategyChange[];
  summary: {
    total: number;
    open: number;
    won: number;
    lost: number;
    void: number;
    recalled: number;
  };
}

export interface ColonyEconomy {
  currency: string;
  balance: number;
  reserved: number;
  available: number;
  net: number;
  sugarBalance?: number;
  sugarReserved?: number;
  sugarAvailable?: number;
  sugarNet?: number;
  upkeepCost?: number | null;
  upkeepEveryEvents?: number | null;
  nextUpkeepInEvents?: number | null;
  lastUpkeepEventIndex?: number | null;
  runwayUpkeeps?: number | null;
  status?: "stable" | "watch" | "critical" | string | null;
}

export interface Fixture {
  fixtureId: number | string;
  participant1?: string | null;
  participant2?: string | null;
  competition?: string;
  competitionId?: number;
  startTime?: number | string; // Unix seconds, epoch ms, or an ISO timestamp
  startTimeIso?: string;
}

export interface Colony {
  colonyId: string;
  name: string;
  size: number;
  playerId?: string;
  playerAnonymousId?: string;
  playerWallet?: string;
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
  teamRouting?: TeamRouting;
  strategyRevision?: number;
  score: number;
  accuracy?: number;
  wins?: number;
  losses?: number;
  food: number;
  foodNet?: number;
  sugar?: number;
  sugarNet?: number;
  economy?: ColonyEconomy;
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
  antStrategies?: Record<string, Partial<AntStrategy>>;
}

export interface Player {
  playerId: string;
  name: string;
  anonymousId?: string;
  wallet?: string;
  isHost?: boolean;
  ready?: boolean;
  colonyId?: string;
  colonyName?: string;
}

export interface OpportunityOption {
  optionId?: string;
  value?: string;
  label?: string;
  risk?: string;
  multiplier?: number;
  lossMultiplier?: number;
  rewardSugar?: number;
  riskSugar?: number;
}

export interface Opportunity {
  opportunityId?: string;
  context?: string;
  label?: string;
  question?: string;
  kind?: string; // safe | precision | chaos | hero
  teamLabel?: string | null;
  minute?: number | null;
  options?: OpportunityOption[];
  deadlineLabel?: string;
  infoCost?: number;
}

export interface MatchScore {
  participant1?: number | null;
  participant2?: number | null;
}

export interface TxLineValidation {
  status: "pending" | "verified" | "failed";
  verified: boolean;
  fixtureId: number;
  network: string;
  participant1?: string | null;
  participant2?: string | null;
  historyCount?: number;
  reason?: string | null;
  seq?: number | null;
  action?: string | null;
  statusId?: number | null;
  finalizedAt?: string | null;
  score?: MatchScore | null;
  winner?: "participant1" | "participant2" | "draw" | null;
  winnerLabel?: string | null;
  programId?: string | null;
  dailyScoresPda?: string | null;
  rootAccountExists?: boolean;
  rootAccountOwner?: string | null;
  epochDay?: number | null;
  method?: string | null;
  mode?: string | null;
}

export interface GameState {
  gameId: string;
  roomKind?: "admin" | "player";
  roomScope?: "global" | "private";
  roomCode?: string;
  fixtureId?: number | string;
  participant1?: string | null;
  participant2?: string | null;
  competition?: string | null;
  startTime?: number | string | null;
  startTimeIso?: string | null;
  txlineValidation?: TxLineValidation | null;
  owner?: { anonymousId?: string | null; wallet?: string | null; name?: string | null } | null;
  status: GameStatus;
  mode?: string | null;
  replayTimeScale?: number | null;
  replayClockTargetSeconds?: number | null;
  agentCallMode?: AgentCallMode | null;
  eventIndex?: number;
  players: Player[];
  match?: {
    score?: MatchScore | null;
    gameState?: string | number | null;
    statusId?: string | number | null;
    possessionLabel?: string | null;
    minute?: number | null;
    clockSeconds?: number | null;
  };
  colonies: Colony[];
  activeOpportunities: Opportunity[];
  agentUsage?: unknown;
  agentProcessing?: {
    active: boolean;
    colonyId?: string;
    colonyName?: string;
    antCount?: number;
    stage?: "pre_info" | "post_info" | string;
    startedAt?: number;
  } | null;
  logCount?: number;
}

export interface GameEvent {
  index: number;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt?: number;
}

export interface MarketActionResponse extends GameState {
  event: GameEvent;
}

export interface CreateColonyBody {
  name: string;
  size: number;
  style: Style;
  favoriteContext: FavoriteContext;
  infoNeed: InfoNeed;
  teamRouting?: TeamRouting;
  anonymousId?: string;
}

export interface StrategyPatch {
  style?: Style;
  favoriteContext?: FavoriteContext;
  infoNeed?: InfoNeed;
  teamRouting?: TeamRouting;
  anonymousId?: string;
}

export interface AntStrategyPatch extends StrategyPatch {
  analysisRole?: AnalysisRole;
  inheritGlobal?: boolean;
}
