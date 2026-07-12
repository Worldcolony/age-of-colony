"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, type ReplayFixture, type TxLineValidationResult } from "@/lib/api";
import { useStore } from "@/store/game";
import { fixtureId, flag, fmtKickoffLine, fmtScore, teamName } from "@/lib/format";
import type { CreateColonyBody, FavoriteContext, GameState, InfoNeed, Style } from "@/lib/types";

const REPLAY_SPEED = { replayDelaySeconds: 0.8, replayTimeScale: 120, agentCallMode: "batch" as const };
const ADMIN_LAUNCH_REQUEST_STORAGE_KEY = "age-of-colony:admin-launch-request";
let volatileLaunchRequest: { setupKey: string; requestKey: string } | null = null;
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "Cautious" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const GROUNDS: { value: FavoriteContext; label: string }[] = [
  { value: "penalties", label: "Penalties" },
  { value: "corners", label: "Corners" },
  { value: "momentum", label: "Momentum" },
  { value: "chaos", label: "Chaos" },
  { value: "balanced", label: "Balanced" },
];
const INFO_NEEDS: { value: InfoNeed; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const SIZES = [10, 20, 50] as const;
const DEFAULT_ADMIN_COLONIES = [
  { name: "Red Nest", size: 10, style: "cautious", favoriteContext: "penalties", infoNeed: "high" },
  { name: "Amber Swarm", size: 20, style: "balanced", favoriteContext: "momentum", infoNeed: "medium" },
  { name: "Black Rush", size: 50, style: "aggressive", favoriteContext: "chaos", infoNeed: "low" },
] satisfies AdminColonyDraft[];

type AdminColonyDraft = Omit<CreateColonyBody, "anonymousId">;
type FixtureLoadState = {
  status: "idle" | "loading" | "loaded" | "error";
  message?: string;
  scanned?: number;
  inspected?: number;
};
type FixtureValidationState = {
  status: "idle" | "loading" | "pending" | "verified" | "failed";
  result?: TxLineValidationResult;
  error?: string;
};

function freshDefaultColonies(): AdminColonyDraft[] {
  return DEFAULT_ADMIN_COLONIES.map((colony) => ({ ...colony }));
}

function adminRoomSetupKey(fixture: ReplayFixture, colonies: AdminColonyDraft[]): string {
  return JSON.stringify({
    fixtureId: fixtureId(fixture),
    participant1: fixture.participant1 ?? null,
    participant2: fixture.participant2 ?? null,
    competition: fixture.competition ?? null,
    startTime: fixture.startTime ?? null,
    startTimeIso: fixture.startTimeIso ?? null,
    colonies,
  });
}

function newLaunchRequestKey(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function launchRequestKeyFor(setupKey: string): string {
  if (volatileLaunchRequest?.setupKey === setupKey) return volatileLaunchRequest.requestKey;
  try {
    const stored = JSON.parse(sessionStorage.getItem(ADMIN_LAUNCH_REQUEST_STORAGE_KEY) || "null") as {
      setupKey?: unknown;
      requestKey?: unknown;
    } | null;
    if (stored?.setupKey === setupKey && typeof stored.requestKey === "string" && stored.requestKey) {
      volatileLaunchRequest = { setupKey, requestKey: stored.requestKey };
      return stored.requestKey;
    }
  } catch {
    // Ignore unreadable session storage and create a fresh one-shot key.
  }

  const requestKey = newLaunchRequestKey();
  volatileLaunchRequest = { setupKey, requestKey };
  try {
    sessionStorage.setItem(ADMIN_LAUNCH_REQUEST_STORAGE_KEY, JSON.stringify({ setupKey, requestKey }));
  } catch {
    // Continue with a one-shot key when session storage is unavailable.
  }
  return requestKey;
}

function clearLaunchRequestKey(requestKey: string): void {
  if (volatileLaunchRequest?.requestKey === requestKey) volatileLaunchRequest = null;
  try {
    const stored = JSON.parse(sessionStorage.getItem(ADMIN_LAUNCH_REQUEST_STORAGE_KEY) || "null") as {
      requestKey?: unknown;
    } | null;
    if (stored?.requestKey === requestKey) sessionStorage.removeItem(ADMIN_LAUNCH_REQUEST_STORAGE_KEY);
  } catch {
    // Nothing to clear when session storage is unavailable.
  }
}

function normalizeAdminGames(value: unknown): GameState[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeAdminGame)
    .filter((game): game is GameState => game !== null);
}

function normalizeAdminGame(value: unknown): GameState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const nested = row.public_state;
  const state = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : row;
  const gameId = state.gameId ?? row.game_id ?? row.gameId;
  if (gameId == null || String(gameId).trim() === "") return null;

  const eventIndex = Number(state.eventIndex ?? row.event_index ?? 0);
  const match = state.match && typeof state.match === "object" && !Array.isArray(state.match)
    ? state.match as GameState["match"]
    : { score: null };
  return {
    ...(state as Partial<GameState>),
    gameId: String(gameId),
    fixtureId: (state.fixtureId ?? row.fixture_id) as GameState["fixtureId"],
    participant1: (state.participant1 ?? row.participant1 ?? null) as GameState["participant1"],
    participant2: (state.participant2 ?? row.participant2 ?? null) as GameState["participant2"],
    status: String(state.status ?? row.status ?? "created"),
    mode: (state.mode ?? row.mode ?? null) as GameState["mode"],
    eventIndex: Number.isFinite(eventIndex) ? eventIndex : 0,
    players: Array.isArray(state.players) ? state.players as GameState["players"] : [],
    colonies: Array.isArray(state.colonies) ? state.colonies as GameState["colonies"] : [],
    activeOpportunities: Array.isArray(state.activeOpportunities)
      ? state.activeOpportunities as GameState["activeOpportunities"]
      : [],
    match,
  };
}

export default function AdminPage() {
  const router = useRouter();
  const resetGame = useStore((s) => s.resetGame);
  const setGame = useStore((s) => s.setGame);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
  const [games, setGames] = useState<GameState[]>([]);
  const [pendingRoom, setPendingRoom] = useState<GameState | null>(null);
  const [pendingSetupKey, setPendingSetupKey] = useState("");
  const [selectedFixtureKey, setSelectedFixtureKey] = useState("");
  const [fixtureSearch, setFixtureSearch] = useState("");
  const [fixtureLoadState, setFixtureLoadState] = useState<FixtureLoadState>({ status: "idle" });
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [manualFixtureId, setManualFixtureId] = useState("");
  const [manualParticipant1, setManualParticipant1] = useState("Home");
  const [manualParticipant2, setManualParticipant2] = useState("Away");
  const [colonies, setColonies] = useState<AdminColonyDraft[]>(freshDefaultColonies);
  const [fixtureValidations, setFixtureValidations] = useState<Record<string, FixtureValidationState>>({});
  const [msg, setMsg] = useState("");
  const [working, setWorking] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const tx = Boolean(health?.txlineConfigured);
  const or = Boolean(health?.openrouterConfigured);
  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => String(fixtureId(fixture)) === selectedFixtureKey) ?? fixtures[0] ?? null,
    [fixtures, selectedFixtureKey],
  );
  const selectedFixtureId = selectedFixture ? String(fixtureId(selectedFixture)) : "";
  const selectedValidation = fixtureValidations[selectedFixtureId] ?? { status: "idle" as const };
  const validColonies = useMemo(
    () => colonies
      .map((colony) => ({ ...colony, name: colony.name.trim() }))
      .filter((colony) => colony.name),
    [colonies],
  );
  const totalAnts = validColonies.reduce((sum, colony) => sum + colony.size, 0);
  const launchSetupKey = useMemo(
    () => selectedFixture ? adminRoomSetupKey(selectedFixture, validColonies) : "",
    [selectedFixture, validColonies],
  );
  const reusableRoom = pendingRoom && pendingSetupKey === launchSetupKey ? pendingRoom : null;
  const launchReady = Boolean(selectedFixture && validColonies.length);
  const setupLocked = Boolean(working) || refreshing || loadingFixtures;
  const runningGames = games.filter((game) => ["running_replay", "running_live"].includes(game.status));
  const finishedGames = games.filter((game) => game.status === "finished");
  const selectedFixtureGames = games.filter((game) => String(game.fixtureId ?? "") === selectedFixtureId);
  const workflowStep = !selectedFixture ? 1 : validColonies.length ? 3 : 2;
  const fixtureStatusLabel = selectedFixture
    ? "Selected"
    : loadingFixtures
      ? "Loading"
      : fixtureLoadState.status === "loaded"
        ? "No match found"
        : fixtureLoadState.status === "error"
          ? "Error"
          : "No match loaded";

  async function loadFixtures() {
    setLoadingFixtures(true);
    setFixtureLoadState({ status: "loading", message: "Scanning recent TXLine matches for replay data..." });
    try {
      const data = await api.replayFixtures({
        days: 90,
        limit: 24,
        scan_limit: 120,
        search: fixtureSearch.trim() || undefined,
      });
      const list = data.fixtures ?? [];
      setFixtures(list);
      setSelectedFixtureKey((current) =>
        list.some((fixture) => String(fixtureId(fixture)) === current)
          ? current
          : list[0]
            ? String(fixtureId(list[0]))
            : "",
      );
      setFixtureLoadState({
        status: "loaded",
        scanned: data.scanned,
        inspected: data.inspected,
        message: list.length
          ? `Loaded ${list.length} replayable match${list.length === 1 ? "" : "es"}.`
          : `Scanned ${data.scanned ?? 0} recent fixture${data.scanned === 1 ? "" : "s"}; none had replay data.`,
      });
    } catch (e) {
      setFixtures([]);
      setSelectedFixtureKey("");
      setFixtureLoadState({ status: "error", message: (e as Error).message });
      throw e;
    } finally {
      setLoadingFixtures(false);
    }
  }

  async function handleLoadFixtures() {
    setMsg("");
    try {
      await loadFixtures();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  function fixtureEmptyTitle() {
    if (loadingFixtures) return "Scanning replayable matches...";
    if (fixtureLoadState.status === "error") return "Could not load matches";
    if (fixtureLoadState.status === "loaded") return "No replayable matches found";
    return "No replayable matches loaded";
  }

  function fixtureEmptyText() {
    if (loadingFixtures) return "TXLine is being scanned for recent matches that include score events. This can take a few seconds.";
    if (fixtureLoadState.status === "error") return fixtureLoadState.message || "The match list request failed.";
    if (fixtureLoadState.status === "loaded") return fixtureLoadState.message || "No replayable match was found in the current search window.";
    return "Load matches to scan recent TXLine fixtures that have replay data. If TXLine returns empty, the fallback actions stay below.";
  }

  function fixtureStatsText() {
    if (fixtureLoadState.status !== "loaded") return "";
    const scanned = fixtureLoadState.scanned ?? 0;
    const inspected = fixtureLoadState.inspected ?? 0;
    return `${scanned} fixture${scanned === 1 ? "" : "s"} scanned, ${inspected} checked for score data.`;
  }

  async function loadGames() {
    const data = await api.adminGames(50);
    setGames(normalizeAdminGames(data.games));
  }

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      await Promise.all([loadFixtures(), loadGames()]);
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    api.health()
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        refreshDashboard();
      })
      .catch((e) => {
        if (!cancelled) setMsg((e as Error).message);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!runningGames.length) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void api.adminGames(50)
        .then((data) => setGames(normalizeAdminGames(data.games)))
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(interval);
  }, [runningGames.length]);

  function updateColony(index: number, patch: Partial<AdminColonyDraft>) {
    setColonies((current) => current.map((colony, i) => (i === index ? { ...colony, ...patch } : colony)));
  }

  function addColony() {
    setColonies((current) => [
      ...current,
      {
        name: `Scout Nest ${current.length + 1}`,
        size: 20,
        style: "balanced",
        favoriteContext: "momentum",
        infoNeed: "medium",
      },
    ]);
  }

  function removeColony(index: number) {
    setColonies((current) => current.filter((_, i) => i !== index));
  }

  async function verifySelectedFixture() {
    if (!selectedFixture || working) return;
    const rawId = fixtureId(selectedFixture);
    const numericId = Number(rawId);
    const key = String(rawId);
    if (!Number.isSafeInteger(numericId)) {
      setFixtureValidations((current) => ({
        ...current,
        [key]: { status: "failed", error: "This fixture does not have a numeric TXLine id." },
      }));
      return;
    }

    setWorking("verify-only");
    setMsg("Verifying the final score with TXLine...");
    setFixtureValidations((current) => ({ ...current, [key]: { status: "loading" } }));
    try {
      const result = await api.validateFixture(numericId, {
        participant1: selectedFixture.participant1 ?? null,
        participant2: selectedFixture.participant2 ?? null,
      });
      setFixtureValidations((current) => ({
        ...current,
        [key]: { status: result.status, result },
      }));
      setMsg(result.verified ? "TXLine proof verified. The room is ready to be created." : result.reason || "The final proof is not available yet.");
    } catch (error) {
      setFixtureValidations((current) => ({
        ...current,
        [key]: { status: "failed", error: (error as Error).message },
      }));
      setMsg((error as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function verifyAndLaunchReplay() {
    if (!selectedFixture) return setMsg("Select a replayable match first.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    const rawId = fixtureId(selectedFixture);
    const numericId = Number(rawId);
    if (!Number.isSafeInteger(numericId)) return setMsg("This fixture does not have a numeric TXLine id.");

    let validation = selectedValidation.result;
    if (!validation?.verified) {
      setWorking("verify");
      setMsg("Verifying the final score with TXLine...");
      setFixtureValidations((current) => ({ ...current, [String(rawId)]: { status: "loading" } }));
      try {
        validation = await api.validateFixture(numericId, {
          participant1: selectedFixture.participant1 ?? null,
          participant2: selectedFixture.participant2 ?? null,
        });
        setFixtureValidations((current) => ({
          ...current,
          [String(rawId)]: { status: validation?.status ?? "failed", result: validation },
        }));
      } catch (error) {
        setFixtureValidations((current) => ({
          ...current,
          [String(rawId)]: { status: "failed", error: (error as Error).message },
        }));
        setMsg((error as Error).message);
        setWorking("");
        return;
      }
    }
    if (!validation?.verified) {
      setMsg(validation?.reason || "The final TXLine proof is not available yet. Retry verification before launching.");
      setWorking("");
      return;
    }

    const requestKey = launchRequestKeyFor(launchSetupKey);
    let room = reusableRoom;
    if (!room) {
      setWorking("create");
      setMsg("Proof confirmed. Creating the room and colonies...");
      try {
        room = await createRoomWithColonies(selectedFixture, validColonies, requestKey);
        setPendingRoom(room);
        setPendingSetupKey(launchSetupKey);
        setGames((current) => [room as GameState, ...current.filter((game) => game.gameId !== room?.gameId)].slice(0, 50));
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          clearLaunchRequestKey(requestKey);
          setMsg("The room setup changed during the previous attempt. Review it, then launch again.");
        } else {
          setMsg((error as Error).message);
        }
        setWorking("");
        return;
      }
    }

    setWorking("launch");
    setMsg("Room ready. Starting the simulation...");
    try {
      const started = await api.startGame(room.gameId, "replay", REPLAY_SPEED);
      resetGame();
      setGame(started);
      setMatchFixture(selectedFixture);
      setPendingRoom(null);
      setPendingSetupKey("");
      clearLaunchRequestKey(requestKey);
      router.push(`/cockpit/${started.gameId}`);
    } catch (error) {
      try {
        const currentRoom = await api.getGame(room.gameId);
        if (["running_replay", "running_live", "finished"].includes(currentRoom.status)) {
          resetGame();
          setGame(currentRoom);
          setMatchFixture(selectedFixture);
          setPendingRoom(null);
          setPendingSetupKey("");
          clearLaunchRequestKey(requestKey);
          router.push(currentRoom.status === "finished" ? `/results/${currentRoom.gameId}` : `/cockpit/${currentRoom.gameId}`);
          return;
        }
      } catch {
        // Keep the known room and let the operator retry without creating another one.
      }
      setMsg(`Room ${room.gameId} is ready, but the simulation did not start. ${(error as Error).message} Retry launch to reuse the same room.`);
    } finally {
      setWorking("");
    }
  }

  async function findLatestAndStart() {
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    setWorking("latest");
    setMsg("Searching for the latest completed fixture with score data...");
    try {
      const game = await api.runPrevious({
        days: 90,
        limit: 160,
        stream: true,
        colonies: validColonies,
        ...REPLAY_SPEED,
      });
      resetGame();
      setGame(game);
      router.push(`/cockpit/${game.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function launchManualFixture() {
    const cleanId = manualFixtureId.trim();
    if (!cleanId) return setMsg("Enter a TXLine fixture id.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    const fixture: ReplayFixture = {
      fixtureId: Number.isFinite(Number(cleanId)) ? Number(cleanId) : cleanId,
      participant1: manualParticipant1.trim() || "Home",
      participant2: manualParticipant2.trim() || "Away",
      competition: "Manual admin fixture",
    };
    const requestKey = launchRequestKeyFor(adminRoomSetupKey(fixture, validColonies));
    setWorking("manual");
    setMsg("Creating manual replay room...");
    try {
      const room = await createRoomWithColonies(fixture, validColonies, requestKey);
      const started = await api.startGame(room.gameId, "replay", {
        ...REPLAY_SPEED,
      });
      resetGame();
      setGame(started);
      setMatchFixture(fixture);
      clearLaunchRequestKey(requestKey);
      router.push(`/cockpit/${started.gameId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) clearLaunchRequestKey(requestKey);
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function rerunGame(game: GameState) {
    setWorking(`rerun-${game.gameId}`);
    setMsg(`Rerunning ${matchTitle(game)}...`);
    try {
      const replay = await api.rerun(game.gameId, REPLAY_SPEED);
      resetGame();
      setGame(replay);
      router.push(`/cockpit/${replay.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  function openRun(game: GameState) {
    router.push(`/cockpit/${game.gameId}`);
  }

  async function runDemo() {
    setWorking("demo");
    setMsg("Starting demo sandbox...");
    try {
      const game = await api.demoRun({});
      resetGame();
      setGame(game);
      router.push(`/cockpit/${game.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function createRoomWithColonies(
    fixture: ReplayFixture,
    colonyDrafts: AdminColonyDraft[],
    requestKey: string,
  ): Promise<GameState> {
    const id = fixtureId(fixture);
    if (!id) throw new Error("Fixture has no id.");
    return api.adminCreateRoom({
      fixtureId: id,
      participant1: fixture.participant1 ?? null,
      participant2: fixture.participant2 ?? null,
      competition: fixture.competition ?? null,
      startTime: fixture.startTime ?? null,
      startTimeIso: fixture.startTimeIso ?? null,
      requestKey,
      colonies: colonyDrafts,
    });
  }

  return (
    <div className="flex w-full flex-col gap-4 pb-6 lg:relative lg:left-1/2 lg:w-[min(1500px,calc(100vw-32px))] lg:-translate-x-1/2">
      <AdminHeader
        refreshing={refreshing}
        locked={Boolean(working)}
        onBack={() => router.push("/lobby")}
        onRefresh={() => refreshDashboard()}
      />

      <AdminStatusStrip
        txline={health ? (tx ? "online" : "missing") : "checking"}
        openRouter={health ? (or ? "online" : "missing") : "checking"}
        matches={fixtures.length}
        rooms={games.length}
        running={runningGames.length}
      />

      {msg && <Message text={msg} />}

      <WorkflowRail currentStep={workflowStep} />

      <section className="grid gap-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(380px,0.75fr)]">
          <div className="grid min-w-0 gap-4">
            <StepCard
              number="1"
              title="Choose a completed match"
              status={fixtureStatusLabel}
            >
              <p className="mb-4 text-sm leading-relaxed text-ink-faint">
                Pick the TXLine match whose event history the colonies will replay.
              </p>
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  className="input"
                  aria-label="Search completed matches"
                  placeholder="Search team, competition, fixture id"
                  value={fixtureSearch}
                  disabled={setupLocked}
                  onChange={(e) => setFixtureSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLoadFixtures();
                  }}
                />
                <button
                  className="btn btn-ghost !min-h-0 !w-auto px-4 py-2 text-sm"
                  disabled={setupLocked}
                  onClick={handleLoadFixtures}
                >
                  {loadingFixtures ? "Loading..." : "Search matches"}
                </button>
              </div>

              <div className="mt-4 grid max-h-[340px] gap-2 overflow-y-auto pr-1">
                {fixtures.map((fixture) => {
                  const key = String(fixtureId(fixture));
                  const selected = key === selectedFixtureId;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      disabled={setupLocked}
                      className={`rounded-md border-2 p-3 text-left transition ${
                        selected
                          ? "border-[color:var(--color-green)] bg-lime/10 shadow-[2px_2px_0_rgba(90,70,30,0.3)]"
                          : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.7)] hover:border-gold/60"
                      }`}
                      onClick={() => setSelectedFixtureKey(key)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <FixtureTeams fixture={fixture} />
                        <span className="status-pill">{fixture.eventCount ?? 0} events</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-ink-faint md:grid-cols-[1fr_auto_auto]">
                        <span className="truncate">{fixture.competition ?? "Completed fixture"}</span>
                        <span>{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</span>
                        <span className="font-mono uppercase text-gold">{fixture.source ?? "replay"}</span>
                      </div>
                    </button>
                  );
                })}

                {!fixtures.length && (
                  <EmptyPanel
                    title={fixtureEmptyTitle()}
                    text={fixtureEmptyText()}
                  >
                    {fixtureStatsText() && <p className="mt-3 font-mono text-[11px] uppercase tracking-wide text-ink-faint">{fixtureStatsText()}</p>}
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <button className="btn btn-primary !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={findLatestAndStart}>
                        Find latest and launch
                      </button>
                      <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={runDemo}>
                        Run demo sandbox
                      </button>
                    </div>
                  </EmptyPanel>
                )}
              </div>
            </StepCard>

            <StepCard
              number="2"
              title="Configure the colonies"
              status={validColonies.length ? `${validColonies.length} ready` : "One required"}
            >
              <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                <p className="max-w-2xl text-sm leading-relaxed text-ink-faint">
                  Each colony gets its own population and strategy. These settings are attached when the room is created.
                </p>
                <span className="font-mono text-xs font-bold uppercase tracking-wide text-gold-deep">
                  {totalAnts} ants total
                </span>
              </div>

              <div className="grid gap-3">
                {colonies.map((colony, index) => (
                  <div key={index} className="well p-3">
                    <div className="mb-3 flex items-center justify-between gap-3 border-b border-[color:var(--brd-soft)] pb-2">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold-deep">
                        Colony {String(index + 1).padStart(2, "0")}
                      </span>
                      <button
                        className="quiet-link !min-h-11 px-2 text-xs"
                        disabled={setupLocked || colonies.length <= 1}
                        onClick={() => removeColony(index)}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(170px,1.2fr)_80px_130px_130px_110px]">
                      <Field label="Name">
                        <input
                          className="input !px-3 !py-2 text-sm"
                          value={colony.name}
                          maxLength={40}
                          disabled={setupLocked}
                          onChange={(e) => updateColony(index, { name: e.target.value })}
                        />
                      </Field>
                      <Field label="Ants">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.size}
                          disabled={setupLocked}
                          onChange={(e) => updateColony(index, { size: Number(e.target.value) })}
                        >
                          {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                        </select>
                      </Field>
                      <Field label="Style">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.style}
                          disabled={setupLocked}
                          onChange={(e) => updateColony(index, { style: e.target.value as Style })}
                        >
                          {STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Focus">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.favoriteContext}
                          disabled={setupLocked}
                          onChange={(e) => updateColony(index, { favoriteContext: e.target.value as FavoriteContext })}
                        >
                          {GROUNDS.map((ground) => <option key={ground.value} value={ground.value}>{ground.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Info need">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.infoNeed}
                          disabled={setupLocked}
                          onChange={(e) => updateColony(index, { infoNeed: e.target.value as InfoNeed })}
                        >
                          {INFO_NEEDS.map((need) => <option key={need.value} value={need.value}>{need.label}</option>)}
                        </select>
                      </Field>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={addColony}>+ Add a colony</button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={() => setColonies(freshDefaultColonies())}>Restore 3 defaults</button>
              </div>
            </StepCard>
          </div>

          <aside className="grid min-w-0 content-start gap-4 xl:sticky xl:top-4 xl:self-start">
            <StepCard
              number="3"
              title="Create & launch"
              status={working ? "Working" : reusableRoom ? "Room ready" : launchReady ? "Ready" : "Waiting"}
            >
              <p className="mb-4 text-sm leading-relaxed text-ink-faint">
                One action verifies TXLine, creates the room with these colonies, and opens the live cockpit.
              </p>

              {selectedFixture
                ? <SelectedFixture fixture={selectedFixture} />
                : <EmptyPanel title="Choose a match first" text="Step 1 must be complete before a room can be created." />}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <LaunchMetric label="Colonies" value={validColonies.length || "—"} detail={`${totalAnts} ants`} />
                <LaunchMetric label="Replay" value="×120" detail="0.8 s minimum beat" />
              </div>

              {selectedFixtureGames.length > 0 && (
                <p className="mt-3 rounded-md border-2 border-gold/35 bg-gold/10 px-3 py-2 text-xs leading-relaxed text-ink-soft">
                  {selectedFixtureGames.length} previous run{selectedFixtureGames.length === 1 ? "" : "s"} already use this match. A new room will remain separate.
                </p>
              )}

              {selectedFixture && (
                <TxLineProofPanel
                  state={selectedValidation}
                  disabled={Boolean(working)}
                  onVerify={verifySelectedFixture}
                />
              )}

              <div className="mt-4 grid gap-2 border-y border-[color:var(--brd-soft)] py-4">
                <LaunchPlanLine done={selectedValidation.status === "verified"} label="Verify the final TXLine proof" />
                <LaunchPlanLine done={Boolean(reusableRoom)} label={`Create 1 room with ${validColonies.length || 0} colonies`} />
                <LaunchPlanLine done={false} label="Start the replay and open the cockpit" />
              </div>

              <button
                className="btn btn-primary mt-4"
                disabled={setupLocked || !launchReady || selectedValidation.status === "loading"}
                onClick={verifyAndLaunchReplay}
              >
                {working === "verify" || working === "verify-only"
                  ? "Checking TXLine..."
                  : working === "create"
                    ? "Creating room & colonies..."
                    : working === "launch"
                      ? "Starting simulation..."
                      : reusableRoom
                        ? "Retry launch"
                        : "Create room & launch simulation"}
              </button>
              <p className="mt-3 text-center text-[11px] leading-relaxed text-ink-faint">
                Proof verification is read-only. No blockchain transaction or payment is sent.
              </p>
            </StepCard>

            <details className="well p-4">
              <summary className="cursor-pointer text-sm font-bold text-ink-soft">Advanced options</summary>
              <p className="mt-3 text-xs leading-relaxed text-ink-faint">
                Diagnostic shortcuts below can bypass the normal proof-first flow.
              </p>
              <div className="mt-4 grid gap-3">
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={findLatestAndStart}>
                  Auto-pick latest match
                </button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked} onClick={runDemo}>
                  Run demo sandbox
                </button>
                <div className="grid gap-3 border-t border-[color:var(--brd-soft)] pt-3">
                  <Field label="TXLine fixture id">
                    <input
                      className="input font-mono"
                      inputMode="numeric"
                      placeholder="18218149"
                      value={manualFixtureId}
                      disabled={setupLocked}
                      onChange={(e) => setManualFixtureId(e.target.value)}
                    />
                  </Field>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Participant 1">
                      <input className="input" placeholder="Home" value={manualParticipant1} disabled={setupLocked} onChange={(e) => setManualParticipant1(e.target.value)} />
                    </Field>
                    <Field label="Participant 2">
                      <input className="input" placeholder="Away" value={manualParticipant2} disabled={setupLocked} onChange={(e) => setManualParticipant2(e.target.value)} />
                    </Field>
                  </div>
                  <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={setupLocked || !manualFixtureId.trim()} onClick={launchManualFixture}>
                    Launch manual fixture
                  </button>
                </div>
              </div>
            </details>
          </aside>
        </div>
      </section>

      <details className="glass p-5">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <PanelTitle eyebrow="Previous runs" title="Simulation history" />
          <div className="flex gap-2">
            <span className="status-pill">{runningGames.length} running</span>
            <span className="status-pill">{finishedGames.length} finished</span>
          </div>
        </summary>

        <div className="mt-5 grid gap-4 border-t border-[color:var(--brd-soft)] pt-5">

          <div className="grid gap-3 md:hidden">
            {games.slice(0, 14).map((game) => (
              <article key={game.gameId} className="well grid gap-3 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-bold text-ink">{matchTitle(game)}</h3>
                  <p className="truncate font-mono text-[10px] text-ink-faint">{game.gameId}</p>
                </div>
                <span className={`status-pill shrink-0 ${game.status === "finished" ? "!border-lime/40 !text-lime" : ""}`}>
                  {game.status.replace(/_/g, " ")}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <MiniRunStat label="Score" value={fmtScore(game.match?.score)} />
                <MiniRunStat label="Colonies" value={game.colonies.length} />
                <MiniRunStat label="Events" value={game.eventIndex ?? 0} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn btn-ghost !min-h-11 px-3 py-2 text-sm" onClick={() => openRun(game)}>
                  {game.status === "finished" && game.players.length === 0 ? "Inspect ants" : "Open cockpit"}
                </button>
                <button className="btn btn-primary !min-h-11 px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => rerunGame(game)}>
                  {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                </button>
              </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] border-separate border-spacing-y-2 text-left">
            <thead className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-3 py-1">Run</th>
                <th className="px-3 py-1">Status</th>
                <th className="px-3 py-1">Score</th>
                <th className="px-3 py-1">Colonies</th>
                <th className="px-3 py-1">Events</th>
                <th className="px-3 py-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {games.slice(0, 14).map((game) => (
                <tr key={game.gameId} className="bg-[rgba(249,243,226,0.72)] shadow-[2px_2px_0_rgba(74,58,30,0.12)]">
                  <td className="rounded-l-md px-3 py-3">
                    <strong>{matchTitle(game)}</strong>
                    <p className="font-mono text-[11px] text-ink-faint">{game.gameId}</p>
                  </td>
                  <td className="px-3 py-3"><span className={`status-pill ${game.status === "finished" ? "!border-lime/40 !text-lime" : ""}`}>{game.status.replace("_", " ")}</span></td>
                  <td className="px-3 py-3 font-mono text-sm">{fmtScore(game.match?.score)}</td>
                  <td className="px-3 py-3 text-sm">{game.colonies.length}</td>
                  <td className="px-3 py-3 text-sm">{game.eventIndex ?? 0}</td>
                  <td className="rounded-r-md px-3 py-3">
                    <div className="flex justify-end gap-2">
                      <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" onClick={() => openRun(game)}>
                        {game.status === "finished" && game.players.length === 0 ? "Inspect ants" : "Open cockpit"}
                      </button>
                      <button className="btn btn-primary !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => rerunGame(game)}>
                        {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
          {!games.length && <EmptyPanel title="No simulations yet" text="Create a room and launch it to populate this history." />}
        </div>
      </details>
    </div>
  );
}

function AdminHeader({
  refreshing,
  locked,
  onBack,
  onRefresh,
}: {
  refreshing: boolean;
  locked: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-2xl">
        <p className="eyebrow">Age of Colony admin</p>
        <h1 className="hud-title text-[18px] leading-relaxed md:text-[22px]">Launch a replay simulation</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-faint">
          Choose one completed match, prepare the colonies, then create and launch the room.
        </p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-ghost !min-h-11 !w-auto px-4 py-2 text-sm" disabled={locked} onClick={onBack}>Back to lobby</button>
        <button className="btn btn-ghost !min-h-11 !w-auto px-4 py-2 text-sm" disabled={locked || refreshing} onClick={onRefresh}>
          {refreshing ? "Refreshing..." : "Refresh data"}
        </button>
      </div>
    </header>
  );
}

function AdminStatusStrip({
  txline,
  openRouter,
  matches,
  rooms,
  running,
}: {
  txline: "online" | "missing" | "checking";
  openRouter: "online" | "missing" | "checking";
  matches: number;
  rooms: number;
  running: number;
}) {
  return (
    <section className="glass grid grid-cols-2 gap-2 p-3 xl:grid-cols-5" aria-label="Admin services and activity">
      <StatusDatum label="TXLine" value={statusWord(txline)} tone={txline === "online" ? "good" : txline === "missing" ? "bad" : "neutral"} />
      <StatusDatum label="OpenRouter" value={statusWord(openRouter)} tone={openRouter === "online" ? "good" : openRouter === "missing" ? "bad" : "neutral"} />
      <StatusDatum label="Matches" value={matches} />
      <StatusDatum label="Rooms" value={rooms} />
      <StatusDatum label="Running" value={running} tone={running ? "warn" : "neutral"} />
    </section>
  );
}

function statusWord(status: "online" | "missing" | "checking") {
  if (status === "online") return "Online";
  if (status === "missing") return "Missing";
  return "Checking";
}

function StatusDatum({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const dotClass = tone === "good" ? "bg-lime" : tone === "bad" ? "bg-danger" : tone === "warn" ? "bg-gold" : "bg-ink-faint";
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.58)] px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="flex items-center gap-2 text-sm font-bold text-ink">
        <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
        {value}
      </span>
    </div>
  );
}

function WorkflowRail({ currentStep }: { currentStep: number }) {
  const steps = [
    { number: 1, label: "Match" },
    { number: 2, label: "Colonies" },
    { number: 3, label: "Launch" },
  ];
  return (
    <nav className="glass relative overflow-hidden p-3 sm:p-4" aria-label="Simulation setup progress">
      <div className="absolute left-[16%] right-[16%] top-[31px] hidden border-t-2 border-dashed border-[color:var(--brd-soft)] sm:block" aria-hidden="true" />
      <ol className="relative grid grid-cols-3 gap-2">
        {steps.map((step) => {
          const complete = currentStep > step.number;
          const active = currentStep === step.number;
          return (
            <li
              key={step.number}
              className="grid justify-items-center gap-2 text-center"
              aria-current={active ? "step" : undefined}
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-md border-2 font-mono text-xs font-bold shadow-[2px_2px_0_rgba(74,58,30,0.18)] ${
                  complete
                    ? "border-lime bg-lime text-white"
                    : active
                      ? "border-gold bg-gold text-white"
                      : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.92)] text-ink-faint"
                }`}
              >
                {complete ? "✓" : step.number}
              </span>
              <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${active ? "text-gold-deep" : "text-ink-faint"}`}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepCard({ number, title, status, children }: { number: string; title: string; status: string; children: ReactNode }) {
  return (
    <section className="glass min-w-0 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="plate flex h-9 w-9 items-center justify-center font-mono text-sm font-bold text-gold-deep">
            {number}
          </span>
          <h2 className="text-xl font-bold leading-tight">{title}</h2>
        </div>
        <span className="status-pill">{status}</span>
      </div>
      {children}
    </section>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="text-xl font-bold leading-tight">{title}</h2>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function LaunchMetric({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <div className="plate min-w-0 p-3">
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">{label}</p>
      <strong className="mt-1 block text-lg text-ink">{value}</strong>
      <p className="mt-1 truncate text-[10px] text-ink-faint">{detail}</p>
    </div>
  );
}

function LaunchPlanLine({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-soft">
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-bold ${done ? "border-lime bg-lime text-white" : "border-[color:var(--brd-soft)] text-ink-faint"}`}>
        {done ? "✓" : "·"}
      </span>
      <span>{label}</span>
    </div>
  );
}

function MiniRunStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="plate min-w-0 px-2 py-2">
      <p className="truncate font-mono text-[9px] uppercase text-ink-faint">{label}</p>
      <p className="truncate font-mono text-sm font-bold text-ink">{value}</p>
    </div>
  );
}

function SelectedFixture({ fixture }: { fixture: ReplayFixture }) {
  return (
    <div className="rounded-md border border-lime/30 bg-lime/10 p-4">
      <FixtureTeams fixture={fixture} />
      <div className="mt-3 grid gap-2 text-sm text-ink-soft">
        <span className="truncate">{fixture.competition ?? "Completed fixture"}</span>
        <span>{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</span>
        <span className="font-mono text-xs uppercase text-gold">{fixture.eventCount ?? 0} events · {fixture.source ?? "replay"}</span>
      </div>
    </div>
  );
}

function TxLineProofPanel({
  state,
  disabled,
  onVerify,
}: {
  state: FixtureValidationState;
  disabled: boolean;
  onVerify: () => void;
}) {
  const result = state.result;
  const verified = state.status === "verified" && result?.verified;
  const pending = state.status === "pending";
  const failed = state.status === "failed";
  const score = result?.score;
  const scoreLabel = score && score.participant1 != null && score.participant2 != null
    ? `${score.participant1} – ${score.participant2}`
    : "—";

  return (
    <section
      className={`mt-3 rounded-md border-2 p-3 ${
        verified
          ? "border-lime/50 bg-lime/10"
          : failed
            ? "border-danger/40 bg-danger/5"
            : pending
              ? "border-gold/50 bg-gold/5"
              : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.58)]"
      }`}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-faint">TXLine proof</p>
          <p className="mt-1 text-sm font-bold text-ink">
            {verified ? `${scoreLabel} · ${result?.winnerLabel ?? "Final result"}` : state.status === "loading" ? "Checking Solana…" : pending ? "Proof pending" : failed ? "Verification failed" : "Checked automatically on launch"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`status-pill ${verified ? "!border-lime/50 !text-lime" : failed ? "!border-danger/50 !text-danger" : ""}`}>
            {verified ? "✓ Verified" : state.status === "loading" ? "Checking" : pending ? "Pending" : failed ? "Failed" : "Not checked"}
          </span>
          <button
            className="quiet-link !min-h-11 px-2 text-xs"
            disabled={disabled || state.status === "loading"}
            onClick={onVerify}
          >
            {verified ? "Check again" : "Check now"}
          </button>
        </div>
      </div>

      {verified && result ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          seq {result.seq} · {result.method} · {result.network} · read-only
        </p>
      ) : (
        <p className={`mt-2 text-xs leading-relaxed ${failed ? "text-danger" : "text-ink-faint"}`}>
          {state.error
            || result?.reason
            || "Uses validateStatV2 against TXLine’s daily score root."}
        </p>
      )}
    </section>
  );
}

function FixtureTeams({ fixture }: { fixture: ReplayFixture }) {
  const p1 = teamName(fixture.participant1);
  const p2 = teamName(fixture.participant2);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 font-bold">
        <span className="text-xl">{flag(p1)}</span>
        <span className="truncate">{p1}</span>
      </div>
      <span className="font-mono text-[10px] font-bold text-gold">VS</span>
      <div className="flex min-w-0 flex-row-reverse items-center gap-2 text-right font-bold">
        <span className="text-xl">{flag(p2)}</span>
        <span className="truncate">{p2}</span>
      </div>
    </div>
  );
}

function EmptyPanel({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border-2 border-dashed border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.5)] p-6 text-center">
      <h3 className="font-bold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-ink-faint">{text}</p>
      {children}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <p className="well min-w-0 break-words px-3 py-2 text-sm text-ink-soft" role="status" aria-live="polite">{text}</p>
  );
}

function matchTitle(game: GameState): string {
  return `${teamName(game.participant1, "Participant 1")} vs ${teamName(game.participant2, "Participant 2")}`;
}
