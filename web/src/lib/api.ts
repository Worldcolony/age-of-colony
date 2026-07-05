// Age of Colony — typed API client for the FastAPI engine.
import type {
  CreateColonyBody,
  Fixture,
  GameState,
  StrategyPatch,
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
  const opts: RequestInit = { method, headers: { ...headers } };
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

export interface QueenAuth {
  signature: string; // base64 Ed25519 signature from Phantom signMessage
  ts: number; // unix seconds baked into the signed message
}

// Must exactly match app/queen_auth.py::queen_auth_message
export const queenAuthMessage = (wallet: string, ts: number) => `age-of-colony:queen:${wallet}:${ts}`;

const authHeaders = (auth: QueenAuth): Record<string, string> => ({
  "x-aoc-signature": auth.signature,
  "x-aoc-ts": String(auth.ts),
});

const adminHeaders = (adminToken?: string): Record<string, string> =>
  adminToken ? { "x-aoc-admin-token": adminToken } : {};

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

export const api = {
  health: () => req<Record<string, unknown>>("/health"),

  upcomingFixtures: (p?: { days?: number; limit?: number; competition_id?: number; search?: string }) =>
    req<FixtureList>(`/api/fixtures/upcoming${qs(p)}`),
  recentFixtures: (p?: { days?: number; limit?: number; competition_id?: number; search?: string }, adminToken?: string) =>
    req<FixtureList>(`/api/fixtures/recent${qs(p)}`, "GET", undefined, adminHeaders(adminToken)),
  replayFixtures: (
    p?: { days?: number; limit?: number; scan_limit?: number; competition_id?: number; search?: string },
    adminToken?: string,
  ) => req<ReplayFixtureList>(`/api/admin/replay-fixtures${qs(p)}`, "GET", undefined, adminHeaders(adminToken)),
  liveTarget: (p?: { days?: number }) => req<FixtureList>(`/api/fixtures/live-target${qs(p)}`),

  createGame: (body: {
    fixtureId: number | string;
    participant1?: string | null;
    participant2?: string | null;
    competition?: string | null;
    startTime?: number | null;
    startTimeIso?: string | null;
    seed?: number;
    anonymousId?: string;
    creatorName?: string;
  }) => req<GameState>("/api/games", "POST", body),
  getGame: (id: string) => req<GameState>(`/api/games/${id}`),
  getReplay: (id: string) => req<{ game: GameState; events: import("./types").GameEvent[] }>(`/api/games/${id}/replay`),
  joinPlayer: (id: string, name: string, anonymousId?: string) => req<GameState>(`/api/games/${id}/players`, "POST", { name, anonymousId }),

  // private 6-digit room codes
  getRoomByCode: (code: string) => req<GameState>(`/api/rooms/${encodeURIComponent(code)}`),
  joinRoomByCode: (code: string, name: string, anonymousId?: string) =>
    req<GameState>(`/api/rooms/${encodeURIComponent(code)}/players`, "POST", { name, anonymousId }),

  // queens — one royal profile per wallet (server-enforced by DB primary key).
  // Mutations require an Ed25519 wallet signature (see queenAuthMessage).
  getQueen: (wallet: string) => req<QueenRecord>(`/api/queens/${encodeURIComponent(wallet)}`),
  putQueen: (wallet: string, body: { name: string; motto?: string; emblem?: string }, auth: QueenAuth) =>
    req<QueenRecord>(`/api/queens/${encodeURIComponent(wallet)}`, "PUT", body, authHeaders(auth)),
  deleteQueen: (wallet: string, auth: QueenAuth) =>
    req<{ deleted: boolean }>(`/api/queens/${encodeURIComponent(wallet)}`, "DELETE", undefined, authHeaders(auth)),
  addColony: (id: string, body: CreateColonyBody, adminToken?: string) =>
    req<GameState>(`/api/games/${id}/colonies`, "POST", body, adminHeaders(adminToken)),
  updateStrategy: (id: string, cid: string, body: StrategyPatch) =>
    req<GameState>(`/api/games/${id}/colonies/${encodeURIComponent(cid)}/strategy`, "PATCH", body),
  startGame: (
    id: string,
    mode: "replay" | "live" = "live",
    opts?: { anonymousId?: string; replayDelaySeconds?: number; replayTimeScale?: number; adminToken?: string },
  ) =>
    req<GameState>(`/api/games/${id}/start`, "POST", {
      mode,
      source: mode === "replay" ? "historical" : "updates",
      anonymousId: opts?.anonymousId,
      replayDelaySeconds: opts?.replayDelaySeconds,
      replayTimeScale: opts?.replayTimeScale,
    }, adminHeaders(opts?.adminToken)),
  rerun: (
    id: string,
    adminToken?: string,
    opts?: { replayDelaySeconds?: number; replayTimeScale?: number },
  ) =>
    req<GameState>(
      `/api/games/${id}/rerun`,
      "POST",
      {
        mode: "replay",
        source: "historical",
        replayDelaySeconds: opts?.replayDelaySeconds,
        replayTimeScale: opts?.replayTimeScale,
      },
      adminHeaders(adminToken),
    ),

  demoMatches: (adminToken?: string) => req<FixtureList>("/api/demo/matches", "GET", undefined, adminHeaders(adminToken)),
  demoRun: (body?: Record<string, unknown>, adminToken?: string) => req<GameState>("/api/demo/run", "POST", body ?? {}, adminHeaders(adminToken)),
  runPrevious: (body?: Record<string, unknown>, adminToken?: string) =>
    req<GameState>("/api/games/run-previous", "POST", body ?? {}, adminHeaders(adminToken)),
  adminGames: (limit = 50, adminToken?: string) =>
    req<AdminGameList>(`/api/admin/games${qs({ limit })}`, "GET", undefined, adminHeaders(adminToken)),
};

export const sseUrl = (gameId: string) => `${API_BASE}/api/games/${gameId}/events`;
