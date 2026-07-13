// Age of Colony — typed API client for the FastAPI engine.
import type {
  AntDetailResponse,
  AntStrategyPatch,
  AntStrategyResponse,
  AgentCallMode,
  ColonyAntsResponse,
  CreateColonyBody,
  Fixture,
  GameState,
  MarketActionResponse,
  StrategyPatch,
  TxLineValidation,
} from "./types";

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function req<T>(path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<T> {
  const opts: RequestInit = { method, credentials: "include", headers: { ...headers } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown })?.detail ?? res.statusText;
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status, detail);
  }
  return data as T;
}

function qs(params: Record<string, string | number | undefined | null> = {}): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  }
  const str = s.toString();
  return str ? `?${str}` : "";
}

export interface WalletChallengeResponse {
  wallet: string;
  nonce: string;
  message: string;
  issuedAt?: number | string | null;
  expiresAt?: number | string | null;
}

export interface WalletSessionResponse {
  authenticated: boolean;
  wallet?: string | null;
  issuedAt?: number | string | null;
  expiresAt?: number | string | null;
}

export interface QueenRecord {
  wallet: string;
  name: string;
  motto: string;
  emblem: string;
  crownedAt?: string | number | null;
  updatedAt?: string | null;
}

export interface FixtureList {
  count?: number;
  mode?: string;
  status?: string;
  fixture?: Fixture;
  fixtures?: Fixture[];
}

export interface AdminGameList {
  source?: string;
  configured?: boolean;
  count?: number;
  games?: GameState[];
  hint?: string;
}

export interface ReplayFixture extends Fixture {
  playable?: boolean;
  source?: string | null;
  eventCount?: number;
  sourceCounts?: Record<string, number>;
}

export interface ReplayFixtureList {
  count?: number;
  days?: number;
  limit?: number;
  scanLimit?: number;
  scanned?: number;
  inspected?: number;
  fixtures?: ReplayFixture[];
}

export type TxLineValidationResult = TxLineValidation;

export interface RunPreviousRequest {
  days?: number;
  limit?: number;
  competitionId?: number;
  search?: string;
  seed?: number;
  stream?: boolean;
  agentCallMode?: AgentCallMode;
  replayDelaySeconds?: number;
  replayTimeScale?: number;
  colonies?: CreateColonyBody[];
}

export interface CreatePlayerRoomRequest {
  fixtureId: number | string;
  participant1?: string | null;
  participant2?: string | null;
  competition?: string | null;
  startTime?: number | string | null;
  startTimeIso?: string | null;
  seed?: number;
  anonymousId?: string;
  creatorName?: string;
}

export const api = {
  health: () => req<Record<string, unknown>>("/health"),

  // A wallet signature only proves player identity. Verification creates an
  // HttpOnly session cookie; no private key, transaction, or SOL is involved.
  walletChallenge: (wallet: string) =>
    req<WalletChallengeResponse>("/api/auth/wallet/challenge", "POST", { wallet }),
  walletVerify: (body: { wallet: string; nonce: string; signature: string }) =>
    req<WalletSessionResponse>("/api/auth/wallet/verify", "POST", body),
  walletSession: () => req<WalletSessionResponse>("/api/auth/wallet/session"),
  walletLogout: () => req<WalletSessionResponse>("/api/auth/wallet/session", "DELETE"),

  upcomingFixtures: (p?: { days?: number; limit?: number; competition_id?: number; search?: string }) =>
    req<FixtureList>(`/api/fixtures/upcoming${qs(p)}`),
  recentFixtures: (p?: { days?: number; limit?: number; competition_id?: number; search?: string }) =>
    req<FixtureList>(`/api/fixtures/recent${qs(p)}`),
  replayFixtures: (p?: { days?: number; limit?: number; scan_limit?: number; competition_id?: number; search?: string }) =>
    req<ReplayFixtureList>(`/api/admin/replay-fixtures${qs(p)}`),
  validateFixture: (fixtureId: number, p?: { participant1?: string | null; participant2?: string | null }) =>
    req<TxLineValidationResult>(`/api/admin/fixtures/${fixtureId}/txline-validation${qs(p)}`, "POST"),
  liveTarget: (p?: { days?: number }) => req<FixtureList>(`/api/fixtures/live-target${qs(p)}`),

  createGame: (body: CreatePlayerRoomRequest) => req<GameState>("/api/games", "POST", body),
  createPrivateRoom: (body: CreatePlayerRoomRequest) => req<GameState>("/api/rooms", "POST", body),
  getGame: (id: string) => req<GameState>(`/api/games/${id}`),
  getReplay: (id: string) => req<{ game: GameState; events: import("./types").GameEvent[] }>(`/api/games/${id}/replay`),
  joinPlayer: (id: string, name: string, anonymousId?: string) => req<GameState>(`/api/games/${id}/players`, "POST", { name, anonymousId }),

  // private 6-digit room codes
  getRoomByCode: (code: string) => req<GameState>(`/api/rooms/${encodeURIComponent(code)}`),
  joinRoomByCode: (code: string, name: string, anonymousId?: string) =>
    req<GameState>(`/api/rooms/${encodeURIComponent(code)}/players`, "POST", { name, anonymousId }),

  // queens — one royal profile per wallet (server-enforced by DB primary key).
  // Mutations reuse the verified HttpOnly wallet session.
  getQueen: (wallet: string) => req<QueenRecord>(`/api/queens/${encodeURIComponent(wallet)}`),
  putQueen: (wallet: string, body: { name: string; motto?: string; emblem?: string }) =>
    req<QueenRecord>(`/api/queens/${encodeURIComponent(wallet)}`, "PUT", body),
  deleteQueen: (wallet: string) =>
    req<{ deleted: boolean }>(`/api/queens/${encodeURIComponent(wallet)}`, "DELETE"),
  addColony: (id: string, body: CreateColonyBody) =>
    req<GameState>(`/api/games/${id}/colonies`, "POST", body),
  updateStrategy: (id: string, cid: string, body: StrategyPatch) =>
    req<GameState>(`/api/games/${id}/colonies/${encodeURIComponent(cid)}/strategy`, "PATCH", body),
  rally: (id: string, body: { colonyId: string; opportunityId: string; anonymousId: string }) =>
    req<MarketActionResponse>(`/api/games/${id}/rally`, "POST", body),
  recall: (id: string, body: { colonyId: string; opportunityId: string; anonymousId: string }) =>
    req<MarketActionResponse>(`/api/games/${id}/recall`, "POST", body),
  switchCall: (id: string, body: { colonyId: string; opportunityId: string; optionId: string; anonymousId: string }) =>
    req<MarketActionResponse>(`/api/games/${id}/switch-call`, "POST", body),
  getColonyAnts: (id: string, cid: string, anonymousId?: string) =>
    req<ColonyAntsResponse>(
      `/api/games/${id}/colonies/${encodeURIComponent(cid)}/ants${qs({ anonymousId })}`,
    ),
  getAntDetail: (id: string, cid: string, antId: string, anonymousId?: string) =>
    req<AntDetailResponse>(
      `/api/games/${id}/colonies/${encodeURIComponent(cid)}/ants/${encodeURIComponent(antId)}${qs({ anonymousId })}`,
    ),
  updateAntStrategy: (id: string, cid: string, antId: string, body: AntStrategyPatch) =>
    req<AntStrategyResponse>(
      `/api/games/${id}/colonies/${encodeURIComponent(cid)}/ants/${encodeURIComponent(antId)}/strategy`,
      "PATCH",
      body,
    ),
  startGame: (
    id: string,
    mode: "replay" | "live" = "live",
    opts?: { anonymousId?: string; agentCallMode?: AgentCallMode; replayDelaySeconds?: number; replayTimeScale?: number },
  ) =>
    req<GameState>(`/api/games/${id}/start`, "POST", {
      mode,
      source: mode === "replay" ? "historical" : "updates",
      anonymousId: opts?.anonymousId,
      agentCallMode: opts?.agentCallMode,
      replayDelaySeconds: opts?.replayDelaySeconds,
      replayTimeScale: opts?.replayTimeScale,
    }),
  rerun: (
    id: string,
    opts?: {
      anonymousId?: string;
      agentCallMode?: AgentCallMode;
      replayDelaySeconds?: number;
      replayTimeScale?: number;
    },
  ) =>
    req<GameState>(
      `/api/games/${id}/rerun`,
      "POST",
      {
        mode: "replay",
        source: "historical",
        anonymousId: opts?.anonymousId,
        agentCallMode: opts?.agentCallMode,
        replayDelaySeconds: opts?.replayDelaySeconds,
        replayTimeScale: opts?.replayTimeScale,
      },
    ),

  demoMatches: () => req<FixtureList>("/api/demo/matches"),
  demoRun: (body?: Record<string, unknown>) => req<GameState>("/api/demo/run", "POST", body ?? {}),
  runPrevious: (body?: RunPreviousRequest) =>
    req<GameState>("/api/games/run-previous", "POST", body ?? {}),
  adminCreateRoom: (body: {
    fixtureId: number | string;
    participant1?: string | null;
    participant2?: string | null;
    competition?: string | null;
    startTime?: number | string | null;
    startTimeIso?: string | null;
    seed?: number;
    requestKey?: string;
    colonies: CreateColonyBody[];
  }) => req<GameState>("/api/admin/rooms", "POST", body),
  adminGames: (limit = 50) =>
    req<AdminGameList>(`/api/admin/games${qs({ limit })}`),
};

export const sseUrl = (gameId: string) => `${API_BASE}/api/games/${gameId}/events`;
