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
const DEFAULT_ADMIN_COLONIES = [
  { name: "Red Nest", size: 20, style: "cautious", favoriteContext: "penalties", infoNeed: "high" },
  { name: "Amber Swarm", size: 20, style: "balanced", favoriteContext: "momentum", infoNeed: "medium" },
  { name: "Black Rush", size: 20, style: "aggressive", favoriteContext: "chaos", infoNeed: "low" },
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
type AdminView = "launch" | "simulations";
type WizardStep = 1 | 2 | 3 | 4;

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

function adminColonyRosterKey(colonies: AdminColonyDraft[]): string {
  return JSON.stringify(colonies.map((colony) => ({
    name: colony.name.trim(),
    size: colony.size,
    style: colony.style,
    favoriteContext: colony.favoriteContext,
    infoNeed: colony.infoNeed,
  })));
}

function gameColonyRosterKey(game: GameState): string {
  return adminColonyRosterKey(game.colonies.map((colony) => ({
    name: colony.name,
    size: colony.size,
    style: colony.style,
    favoriteContext: colony.favoriteContext,
    infoNeed: colony.infoNeed,
  })));
}

function isPreparedAdminRoom(game: GameState): boolean {
  return game.status === "created"
    && game.colonies.length > 0
    && game.players.length === 0
    && !game.owner?.anonymousId
    && game.mode !== "live";
}

function fixtureFromGame(game: GameState): ReplayFixture {
  return {
    fixtureId: game.fixtureId ?? game.gameId,
    participant1: game.participant1 ?? null,
    participant2: game.participant2 ?? null,
    competition: game.competition ?? undefined,
    startTime: game.startTime ?? undefined,
    startTimeIso: game.startTimeIso ?? undefined,
    playable: true,
    source: "historical",
  };
}

function colonyDraftsFromGame(game: GameState): AdminColonyDraft[] {
  return game.colonies.map((colony) => ({
    name: colony.name,
    size: colony.size,
    style: colony.style,
    favoriteContext: colony.favoriteContext,
    infoNeed: colony.infoNeed,
  }));
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

function clearLaunchRequestForSetup(setupKey: string): void {
  if (volatileLaunchRequest?.setupKey === setupKey) {
    clearLaunchRequestKey(volatileLaunchRequest.requestKey);
    return;
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(ADMIN_LAUNCH_REQUEST_STORAGE_KEY) || "null") as {
      setupKey?: unknown;
      requestKey?: unknown;
    } | null;
    if (stored?.setupKey === setupKey && typeof stored.requestKey === "string") {
      clearLaunchRequestKey(stored.requestKey);
    }
  } catch {
    // An unreadable key cannot be reused, so there is nothing else to clear.
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
  const [adminView, setAdminView] = useState<AdminView>("launch");
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
  const [games, setGames] = useState<GameState[]>([]);
  const [pendingRoom, setPendingRoom] = useState<GameState | null>(null);
  const [pendingSetupKey, setPendingSetupKey] = useState("");
  const [dismissedPreparedRoomIds, setDismissedPreparedRoomIds] = useState<string[]>([]);
  const [recoverySuspended, setRecoverySuspended] = useState(false);
  const [selectedFixtureKey, setSelectedFixtureKey] = useState("");
  const [fixtureSearch, setFixtureSearch] = useState("");
  const [fixtureLoadState, setFixtureLoadState] = useState<FixtureLoadState>({ status: "idle" });
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [manualFixtureId, setManualFixtureId] = useState("");
  const [manualParticipant1, setManualParticipant1] = useState("Home");
  const [manualParticipant2, setManualParticipant2] = useState("Away");
  const [colonies, setColonies] = useState<AdminColonyDraft[]>(freshDefaultColonies);
  const [coloniesConfirmed, setColoniesConfirmed] = useState(false);
  const [fixtureValidations, setFixtureValidations] = useState<Record<string, FixtureValidationState>>({});
  const [msg, setMsg] = useState("");
  const [working, setWorking] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const tx = Boolean(health?.txlineConfigured);
  const or = Boolean(health?.openrouterConfigured);
  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => String(fixtureId(fixture)) === selectedFixtureKey) ?? null,
    [fixtures, selectedFixtureKey],
  );
  const selectedFixtureId = selectedFixture ? String(fixtureId(selectedFixture)) : "";
  const validColonies = useMemo(
    () => colonies
      .map((colony) => ({ ...colony, name: colony.name.trim() }))
      .filter((colony) => colony.name),
    [colonies],
  );
  const totalAnts = validColonies.reduce((sum, colony) => sum + colony.size, 0);
  const allColoniesValid = colonies.length > 0 && colonies.every((colony) => colony.name.trim().length > 0);
  const launchSetupKey = useMemo(
    () => selectedFixture ? adminRoomSetupKey(selectedFixture, validColonies) : "",
    [selectedFixture, validColonies],
  );
  const pendingReusableRoom = pendingRoom && pendingSetupKey === launchSetupKey ? pendingRoom : null;
  const recoveredReusableRoom = !recoverySuspended && selectedFixture && coloniesConfirmed
    ? games.find((game) => (
        isPreparedAdminRoom(game)
        && String(game.fixtureId ?? "") === selectedFixtureId
        && !dismissedPreparedRoomIds.includes(game.gameId)
        && gameColonyRosterKey(game) === adminColonyRosterKey(validColonies)
      )) ?? null
    : null;
  const reusableRoom = coloniesConfirmed ? pendingReusableRoom ?? recoveredReusableRoom : null;
  const selectedValidation = fixtureValidations[selectedFixtureId]
    ?? (reusableRoom?.txlineValidation
      ? { status: reusableRoom.txlineValidation.status, result: reusableRoom.txlineValidation }
      : { status: "idle" as const });
  const preparedAdminRooms = games.filter(isPreparedAdminRoom);
  const launchReady = Boolean(selectedFixture && allColoniesValid && validColonies.length && coloniesConfirmed);
  const setupLocked = Boolean(working);
  const formLocked = setupLocked || Boolean(reusableRoom);
  const fixtureLocked = formLocked || loadingFixtures;
  const runningGames = games.filter((game) => ["running_replay", "running_live"].includes(game.status));
  const finishedGames = games.filter((game) => game.status === "finished");
  const selectedFixtureGames = games.filter(
    (game) => String(game.fixtureId ?? "") === selectedFixtureId && game.gameId !== reusableRoom?.gameId,
  );
  const workflowStep: WizardStep = reusableRoom ? 4 : wizardStep;
  const fixtureStatusLabel = loadingFixtures
    ? "Loading"
    : fixtureLoadState.status === "error"
      ? fixtures.length ? "Stale results" : "Error"
      : selectedFixture
        ? "Selected"
        : fixtureLoadState.status === "loaded"
          ? fixtures.length ? "Choose one" : "No match found"
          : "No match loaded";

  async function loadFixtures() {
    setLoadingFixtures(true);
    setFixtureLoadState({ status: "loading", message: "Scanning recent TXLine matches for replay data..." });
    try {
      const data = await api.replayFixtures({
        days: 90,
        limit: 24,
        scan_limit: 48,
        search: fixtureSearch.trim() || undefined,
      });
      const list = data.fixtures ?? [];
      setFixtures(list);
      setSelectedFixtureKey((current) =>
        list.some((fixture) => String(fixtureId(fixture)) === current)
          ? current
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

  async function refreshSimulations() {
    setRefreshing(true);
    try {
      const [freshHealth] = await Promise.all([api.health(), loadGames()]);
      setHealth(freshHealth);
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
    setColoniesConfirmed(false);
    setColonies((current) => current.map((colony, i) => (i === index ? { ...colony, ...patch } : colony)));
  }

  function addColony() {
    setColoniesConfirmed(false);
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
    setColoniesConfirmed(false);
    setColonies((current) => current.filter((_, i) => i !== index));
  }

  function loadDefaultColonies() {
    setColoniesConfirmed(false);
    setColonies(freshDefaultColonies());
  }

  function continueFromMatch() {
    if (!selectedFixture) return setMsg("Choose a completed match before continuing.");
    setMsg("");
    setWizardStep(2);
  }

  function reviewColonyRoster() {
    if (!allColoniesValid) return setMsg("Give every colony a name before continuing.");
    setColoniesConfirmed(true);
    setMsg("");
    setWizardStep(3);
  }

  function changeAdminView(view: AdminView) {
    setAdminView(view);
    setMsg("");
  }

  function resumePreparedRoom(game: GameState) {
    const fixture = fixtureFromGame(game);
    const drafts = colonyDraftsFromGame(game);
    const key = String(fixtureId(fixture));
    setFixtures((current) => [fixture, ...current.filter((item) => String(fixtureId(item)) !== key)]);
    setSelectedFixtureKey(key);
    setColonies(drafts);
    setColoniesConfirmed(true);
    setPendingRoom(game);
    setPendingSetupKey(adminRoomSetupKey(fixture, drafts));
    setRecoverySuspended(false);
    setAdminView("launch");
    setWizardStep(4);
    setDismissedPreparedRoomIds((current) => current.filter((gameId) => gameId !== game.gameId));
    const validation = game.txlineValidation;
    if (validation) {
      setFixtureValidations((current) => ({
        ...current,
        [key]: { status: validation.status, result: validation },
      }));
    }
    setMsg(`Room ${game.roomCode ?? game.gameId} restored. Launch it when you are ready.`);
  }

  function changePreparedSetup() {
    if (!reusableRoom) return;
    clearLaunchRequestForSetup(launchSetupKey);
    setRecoverySuspended(true);
    setDismissedPreparedRoomIds((current) => current.includes(reusableRoom.gameId) ? current : [...current, reusableRoom.gameId]);
    setPendingRoom(null);
    setPendingSetupKey("");
    setFixtureValidations((current) => ({ ...current, [selectedFixtureId]: { status: "idle" } }));
    setAdminView("launch");
    setWizardStep(2);
    setMsg(`Room ${reusableRoom.roomCode ?? reusableRoom.gameId} remains created but will not be launched from this setup.`);
  }

  async function createPreparedReplayRoom() {
    if (!selectedFixture) return setMsg("Select a replayable match first.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    if (!coloniesConfirmed) return setMsg("Review and confirm the colony roster first.");
    if (reusableRoom) return setMsg(`Room ${reusableRoom.roomCode ?? reusableRoom.gameId} is already ready to launch.`);
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
      setMsg(validation?.reason || "The final TXLine proof is not available yet. Retry verification before creating the room.");
      setWorking("");
      return;
    }

    const requestKey = launchRequestKeyFor(launchSetupKey);
    setWorking("create");
    setMsg("Proof confirmed. Creating one room with the confirmed colonies...");
    try {
      const room = await createRoomWithColonies(selectedFixture, validColonies, requestKey);
      setPendingRoom(room);
      setPendingSetupKey(launchSetupKey);
      setRecoverySuspended(false);
      setWizardStep(4);
      setGames((current) => [room, ...current.filter((game) => game.gameId !== room.gameId)].slice(0, 50));
      setMsg(`Room ${room.roomCode ?? room.gameId} is ready. Launch it when you are ready.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        clearLaunchRequestKey(requestKey);
        setMsg("The room setup changed during the previous attempt. Review it, then create the room again.");
      } else {
        setMsg((error as Error).message);
      }
    } finally {
      setWorking("");
    }
  }

  async function launchPreparedReplay() {
    if (!selectedFixture || !reusableRoom) return setMsg("Create the room before launching the simulation.");
    const room = reusableRoom;
    const requestKey = launchRequestKeyFor(launchSetupKey);
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
    const fallbackColonies = freshDefaultColonies();
    setWorking("latest");
    setMsg("Searching for the latest completed fixture with score data...");
    try {
      const game = await api.runPrevious({
        days: 90,
        limit: 160,
        stream: true,
        colonies: fallbackColonies,
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
    const fallbackColonies = freshDefaultColonies();
    const fixture: ReplayFixture = {
      fixtureId: Number.isFinite(Number(cleanId)) ? Number(cleanId) : cleanId,
      participant1: manualParticipant1.trim() || "Home",
      participant2: manualParticipant2.trim() || "Away",
      competition: "Manual admin fixture",
    };
    const requestKey = launchRequestKeyFor(adminRoomSetupKey(fixture, fallbackColonies));
    setWorking("manual");
    setMsg("Creating manual replay room...");
    try {
      const room = await createRoomWithColonies(fixture, fallbackColonies, requestKey);
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
        view={adminView}
        refreshing={refreshing}
        locked={Boolean(working) || loadingFixtures}
        runningCount={runningGames.length}
        preparedCount={preparedAdminRooms.length}
        onViewChange={changeAdminView}
        onBack={() => router.push("/lobby")}
        onRefresh={() => adminView === "simulations" ? refreshSimulations() : refreshDashboard()}
      />

      {adminView === "simulations" && (
        <>
          <AdminStatusStrip
            txline={health ? (tx ? "online" : "missing") : "checking"}
            openRouter={health ? (or ? "online" : "missing") : "checking"}
            matches={fixtures.length}
            rooms={games.length}
            running={runningGames.length}
          />

          {runningGames.length > 0 && <ActiveRuns games={runningGames} onOpen={openRun} />}

          {preparedAdminRooms.length > 0 && (
            <PreparedRoomsPanel
              games={preparedAdminRooms}
              disabled={Boolean(working) || loadingFixtures}
              onResume={resumePreparedRoom}
            />
          )}
        </>
      )}

      {msg && <Message text={msg} />}

      {adminView === "launch" && <WorkflowRail currentStep={workflowStep} />}

      {adminView === "launch" && (
      <section className="mx-auto grid w-full max-w-5xl gap-4">
        <div className="grid gap-4">
          <div className="grid min-w-0 gap-4">
            {workflowStep === 1 && (
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
                  disabled={fixtureLocked}
                  onChange={(e) => setFixtureSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLoadFixtures();
                  }}
                />
                <button
                  className="btn btn-ghost !min-h-0 !w-auto px-4 py-2 text-sm"
                  disabled={fixtureLocked}
                  onClick={handleLoadFixtures}
                >
                  {loadingFixtures ? "Loading..." : "Search matches"}
                </button>
              </div>

              {fixtureLoadState.status === "error" && fixtures.length > 0 && (
                <p className="mt-3 rounded-md border-2 border-danger/35 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger" role="status">
                  Refresh failed · showing the previous match list. {fixtureLoadState.message}
                </p>
              )}

              <div className="mt-4 grid max-h-[340px] gap-2 overflow-y-auto pr-1">
                {fixtures.map((fixture) => {
                  const key = String(fixtureId(fixture));
                  const selected = key === selectedFixtureId;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      disabled={fixtureLocked}
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
                    <p className="mt-3 text-xs text-ink-faint">Manual and demo fallbacks remain available under Diagnostic tools in Simulations.</p>
                  </EmptyPanel>
                )}
              </div>

              <WizardFooter>
                <span className="text-xs text-ink-faint">Choose one match to continue.</span>
                <button className="btn btn-primary !w-auto px-5" disabled={!selectedFixture || fixtureLocked} onClick={continueFromMatch}>
                  Continue with this match →
                </button>
              </WizardFooter>
            </StepCard>
            )}

            {workflowStep === 2 && (
            <StepCard
              number="2"
              title="Configure the colonies"
              status={coloniesConfirmed ? `✓ ${validColonies.length} confirmed` : !allColoniesValid ? "Fix names" : validColonies.length ? "Review required" : "One required"}
            >
              <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                <p className="max-w-2xl text-sm leading-relaxed text-ink-faint">
                  Every colony starts with the same 20 ants. Choose its name and strategy before attaching the roster to the room.
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
                        disabled={formLocked || colonies.length <= 1}
                        onClick={() => removeColony(index)}
                      >
                        Remove
                      </button>
                    </div>
                    <p className="mb-3 text-xs leading-relaxed text-ink-faint">
                      {adminColonySummary(colony)}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(170px,1.2fr)_80px_130px_130px_110px]">
                      <Field label="Name">
                        <input
                          className="input !px-3 !py-2 text-sm"
                          value={colony.name}
                          maxLength={40}
                          disabled={formLocked}
                          onChange={(e) => updateColony(index, { name: e.target.value })}
                        />
                      </Field>
                      <Field label="Ants">
                        <div className="input !px-3 !py-2 text-sm font-bold text-ink-soft" aria-label="Ants: 20 fixed">
                          20 <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-ink-faint">fixed</span>
                        </div>
                      </Field>
                      <Field label="Style">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.style}
                          disabled={formLocked}
                          onChange={(e) => updateColony(index, { style: e.target.value as Style })}
                        >
                          {STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Focus">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.favoriteContext}
                          disabled={formLocked}
                          onChange={(e) => updateColony(index, { favoriteContext: e.target.value as FavoriteContext })}
                        >
                          {GROUNDS.map((ground) => <option key={ground.value} value={ground.value}>{ground.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Info need">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.infoNeed}
                          disabled={formLocked}
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
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={formLocked} onClick={addColony}>+ Add a colony</button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={formLocked} onClick={loadDefaultColonies}>Load 3-colony preset</button>
              </div>
              {!allColoniesValid && (
                <p className="mt-3 text-xs font-bold text-danger" role="status">Give every colony a name before continuing.</p>
              )}
              <WizardFooter>
                <button className="btn btn-ghost !w-auto px-5" disabled={formLocked} onClick={() => setWizardStep(1)}>← Back</button>
                <button className="btn btn-primary !w-auto px-5" disabled={formLocked || !allColoniesValid} onClick={reviewColonyRoster}>
                  Review {validColonies.length} colon{validColonies.length === 1 ? "y" : "ies"} →
                </button>
              </WizardFooter>
            </StepCard>
            )}
          </div>

          {(workflowStep === 3 || workflowStep === 4) && (
          <aside className="grid min-w-0 content-start gap-4">
            <StepCard
              number={workflowStep === 4 ? "4" : "3"}
              title={workflowStep === 4 ? "Room ready" : "Review & create room"}
              status={working ? "Working" : reusableRoom ? "Ready to launch" : launchReady ? "Ready" : "Waiting"}
            >
              {workflowStep === 3 ? (
                <>
                  <p className="mb-4 text-sm leading-relaxed text-ink-faint">
                    Check the launch docket. Creating the room verifies the match and attaches this exact colony roster.
                  </p>
                  {selectedFixture && <SelectedFixture fixture={selectedFixture} />}
                  <RosterSummary colonies={validColonies} />
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <LaunchMetric label="Colonies" value={validColonies.length} detail={`${totalAnts} ants total`} />
                    <LaunchMetric label="Replay" value="×120" detail="batch ant calls" />
                    <LaunchMetric label="Payment" value="None" detail="read-only proof" />
                  </div>
                  {selectedFixtureGames.length > 0 && (
                    <p className="mt-3 rounded-md border-2 border-gold/35 bg-gold/10 px-3 py-2 text-xs leading-relaxed text-ink-soft">
                      {selectedFixtureGames.length} previous run{selectedFixtureGames.length === 1 ? "" : "s"} already {selectedFixtureGames.length === 1 ? "uses" : "use"} this match. This room will remain separate.
                    </p>
                  )}
                  <LaunchProgress working={working} roomReady={false} />
                  <WizardFooter>
                    <button className="btn btn-ghost !w-auto px-5" disabled={setupLocked} onClick={() => setWizardStep(2)}>← Edit colonies</button>
                    <button
                      className="btn btn-primary !w-auto px-5"
                      disabled={setupLocked || !launchReady}
                      onClick={createPreparedReplayRoom}
                    >
                      {working === "verify" ? "Verifying match..." : working === "create" ? "Creating room..." : "Create room →"}
                    </button>
                  </WizardFooter>
                </>
              ) : (
                <>
                  <p className="mb-4 text-sm leading-relaxed text-ink-faint">
                    The room and colonies are ready. Launch starts this existing room and opens its cockpit.
                  </p>
                  {selectedFixture && <SelectedFixture fixture={selectedFixture} />}
                  {reusableRoom && <RoomReadyDocket room={reusableRoom} colonies={validColonies.length} ants={totalAnts} />}
                  <LaunchProgress working={working} roomReady />
                  <WizardFooter>
                    <button className="btn btn-ghost !w-auto px-5" disabled={setupLocked} onClick={changePreparedSetup}>Change setup</button>
                    <button className="btn btn-primary !w-auto px-5" disabled={setupLocked || !reusableRoom} onClick={launchPreparedReplay}>
                      {working === "launch" ? "Starting simulation..." : "Launch simulation →"}
                    </button>
                  </WizardFooter>
                </>
              )}
            </StepCard>

          </aside>
          )}
        </div>
      </section>
      )}

      {adminView === "simulations" && (
      <details className="glass p-5" open>
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
                {isPreparedAdminRoom(game) ? (
                  <button className="btn btn-primary col-span-2 !min-h-11 px-3 py-2 text-sm" disabled={Boolean(working) || loadingFixtures} onClick={() => resumePreparedRoom(game)}>
                    Resume launch
                  </button>
                ) : (
                  <>
                    <button className="btn btn-ghost !min-h-11 px-3 py-2 text-sm" onClick={() => openRun(game)}>
                      {game.status === "finished" && game.players.length === 0 ? "Inspect ants" : "Open cockpit"}
                    </button>
                    <button className="btn btn-primary !min-h-11 px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => rerunGame(game)}>
                      {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                    </button>
                  </>
                )}
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
                      {isPreparedAdminRoom(game) ? (
                        <button className="btn btn-primary !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working) || loadingFixtures} onClick={() => resumePreparedRoom(game)}>
                          Resume launch
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" onClick={() => openRun(game)}>
                            {game.status === "finished" && game.players.length === 0 ? "Inspect ants" : "Open cockpit"}
                          </button>
                          <button className="btn btn-primary !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => rerunGame(game)}>
                            {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                          </button>
                        </>
                      )}
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
      )}

      {adminView === "simulations" && (
        <details className="well p-4">
          <summary className="cursor-pointer text-sm font-bold text-ink-soft">Diagnostic tools</summary>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">Fallback launchers live here so they never compete with the normal setup flow. They always use the standard 3-colony preset.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <button className="btn btn-ghost !min-h-11 py-2 text-sm" disabled={setupLocked} onClick={findLatestAndStart}>Find latest and launch</button>
            <button className="btn btn-ghost !min-h-11 py-2 text-sm" disabled={setupLocked} onClick={runDemo}>Run demo sandbox</button>
          </div>
          <div className="mt-4 grid gap-3 border-t border-[color:var(--brd-soft)] pt-4 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
            <Field label="TXLine fixture id">
              <input className="input font-mono" inputMode="numeric" placeholder="18218149" value={manualFixtureId} disabled={setupLocked} onChange={(event) => setManualFixtureId(event.target.value)} />
            </Field>
            <Field label="Participant 1">
              <input className="input" placeholder="Home" value={manualParticipant1} disabled={setupLocked} onChange={(event) => setManualParticipant1(event.target.value)} />
            </Field>
            <Field label="Participant 2">
              <input className="input" placeholder="Away" value={manualParticipant2} disabled={setupLocked} onChange={(event) => setManualParticipant2(event.target.value)} />
            </Field>
            <button className="btn btn-primary !min-h-[46px] !w-auto px-4 text-sm" disabled={setupLocked || !manualFixtureId.trim()} onClick={launchManualFixture}>Launch fixture</button>
          </div>
        </details>
      )}
    </div>
  );
}

function AdminHeader({
  view,
  refreshing,
  locked,
  runningCount,
  preparedCount,
  onViewChange,
  onBack,
  onRefresh,
}: {
  view: AdminView;
  refreshing: boolean;
  locked: boolean;
  runningCount: number;
  preparedCount: number;
  onViewChange: (view: AdminView) => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="eyebrow">Age of Colony admin</p>
          <h1 className="hud-title text-[18px] leading-relaxed md:text-[22px]">Simulation control</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-faint">
            Prepare a new replay or monitor rooms that already exist.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost !min-h-11 !w-auto px-4 py-2 text-sm" disabled={locked} onClick={onBack}>Lobby</button>
          <button className="btn btn-ghost !min-h-11 !w-auto px-4 py-2 text-sm" disabled={locked || refreshing} onClick={onRefresh}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      <nav className="glass grid grid-cols-2 gap-2 p-2" aria-label="Admin sections">
        <button
          type="button"
          className={`btn !min-h-12 py-2 text-sm ${view === "launch" ? "btn-primary" : "btn-ghost"}`}
          aria-current={view === "launch" ? "page" : undefined}
          onClick={() => onViewChange("launch")}
        >
          <span>New simulation</span>
          <span className="font-mono text-[10px] opacity-70">4 steps</span>
        </button>
        <button
          type="button"
          className={`btn !min-h-12 py-2 text-sm ${view === "simulations" ? "btn-primary" : "btn-ghost"}`}
          aria-current={view === "simulations" ? "page" : undefined}
          onClick={() => onViewChange("simulations")}
        >
          <span>Simulations</span>
          <span className="font-mono text-[10px] opacity-70">{runningCount} live · {preparedCount} ready</span>
        </button>
      </nav>
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

function ActiveRuns({ games, onOpen }: { games: GameState[]; onOpen: (game: GameState) => void }) {
  return (
    <section className="glass overflow-hidden border-2 !border-rust/45" aria-label="Active simulations">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-rust/20 bg-rust/5 px-4 py-3">
        <div>
          <p className="eyebrow !text-rust">Simulation watch</p>
          <h2 className="text-base font-bold">{games.length} run{games.length === 1 ? "" : "s"} currently active</h2>
        </div>
        <span className="status-pill !border-rust/50 !text-rust"><span className="live-dot" /> polling every 5 s</span>
      </div>
      <div className="grid gap-px bg-[color:var(--brd-soft)] lg:grid-cols-2">
        {games.slice(0, 4).map((game) => (
          <article key={game.gameId} className="grid gap-2 bg-[rgba(249,243,226,0.88)] px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <strong className="block truncate text-sm text-ink">{matchTitle(game)}</strong>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                {game.status.replace(/_/g, " ")} · {game.eventIndex ?? 0} events processed
              </p>
            </div>
            <button type="button" className="btn btn-ghost !min-h-10 !w-auto px-3 py-2 text-xs" onClick={() => onOpen(game)}>
              Open cockpit →
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PreparedRoomsPanel({
  games,
  disabled,
  onResume,
}: {
  games: GameState[];
  disabled: boolean;
  onResume: (game: GameState) => void;
}) {
  return (
    <section className="glass overflow-hidden border-2 !border-lime/40" aria-label="Prepared rooms">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-lime/20 bg-lime/5 px-4 py-3">
        <div>
          <p className="eyebrow !text-lime">Ready rooms</p>
          <h2 className="text-base font-bold">{games.length} simulation{games.length === 1 ? "" : "s"} waiting to launch</h2>
        </div>
        <span className="status-pill !border-lime/45 !text-lime">Prepared</span>
      </div>
      <div className="grid gap-px bg-[color:var(--brd-soft)] lg:grid-cols-2">
        {games.slice(0, 6).map((game) => (
          <article
            key={game.gameId}
            className="grid gap-3 bg-[rgba(249,243,226,0.88)] px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="truncate text-sm text-ink">{matchTitle(game)}</strong>
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-lime">
                  {game.roomCode ?? "Room ready"}
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                {game.colonies.length} colon{game.colonies.length === 1 ? "y" : "ies"} · {game.colonies.reduce((sum, colony) => sum + colony.size, 0)} ants
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary !min-h-10 !w-auto px-3 py-2 text-xs"
              disabled={disabled}
              onClick={() => onResume(game)}
            >
              Resume setup →
            </button>
          </article>
        ))}
      </div>
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

function WorkflowRail({ currentStep }: { currentStep: WizardStep }) {
  const steps = [
    { number: 1, label: "Match" },
    { number: 2, label: "Colonies" },
    { number: 3, label: "Review" },
    { number: 4, label: "Room" },
  ];
  return (
    <nav className="glass relative mx-auto w-full max-w-5xl overflow-hidden p-3 sm:p-4" aria-label="Simulation setup progress">
      <div className="absolute left-[12.5%] right-[12.5%] top-[31px] hidden border-t-2 border-dashed border-[color:var(--brd-soft)] sm:block" aria-hidden="true" />
      <ol className="relative grid grid-cols-4 gap-2">
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

function WizardFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-5 flex flex-col gap-2 rounded-md border-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.86)] p-3 shadow-[3px_3px_0_rgba(74,58,30,0.16)] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {children}
    </footer>
  );
}

function RosterSummary({ colonies }: { colonies: AdminColonyDraft[] }) {
  return (
    <section className="mt-3 overflow-hidden rounded-md border-2 border-[color:var(--brd-soft)]" aria-label="Colony roster summary">
      <div className="flex items-center justify-between gap-3 bg-[rgba(116,91,39,0.08)] px-3 py-2">
        <strong className="text-sm text-ink">Colony roster</strong>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">20 ants each</span>
      </div>
      <div className="divide-y divide-[color:var(--brd-soft)]">
        {colonies.map((colony, index) => (
          <div key={`${colony.name}-${index}`} className="grid gap-1 bg-[rgba(249,243,226,0.62)] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
            <span className="truncate text-sm font-bold text-ink">{String(index + 1).padStart(2, "0")} · {colony.name}</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              {colony.style} · {colony.favoriteContext} · {colony.infoNeed} info
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function LaunchProgress({ working, roomReady }: { working: string; roomReady: boolean }) {
  const verifying = working === "verify";
  const creating = working === "create";
  const launching = working === "launch";
  const proofDone = roomReady || creating || launching;
  const roomDone = roomReady || launching;

  return (
    <section className="well mt-3 p-3" aria-label="Launch progress" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-gold-deep">
          {roomReady ? "Room checklist" : "What happens next"}
        </p>
        {(verifying || creating || launching) && <span className="status-pill !border-gold/50 !text-gold-deep">In progress</span>}
      </div>
      <div className="grid gap-2">
        <LaunchPlanLine
          state={proofDone ? "done" : verifying ? "active" : "pending"}
          label={verifying ? "Checking the final TXLine score…" : "Verify the final TXLine score (read-only)"}
        />
        <LaunchPlanLine
          state={roomDone ? "done" : creating ? "active" : "pending"}
          label={creating ? "Creating the room and attaching colonies…" : "Create the room and attach the colonies"}
        />
        <LaunchPlanLine
          state={launching ? "active" : "pending"}
          label={launching ? "Starting the replay and opening the cockpit…" : "Start the replay and open the cockpit"}
        />
      </div>
    </section>
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

function RoomReadyDocket({ room, colonies, ants }: { room: GameState; colonies: number; ants: number }) {
  return (
    <section className="relative overflow-hidden rounded-md border-2 border-lime/55 bg-lime/10 p-4 shadow-[3px_3px_0_rgba(57,88,48,0.2)]" aria-label="Room ready to launch">
      <span className="absolute -right-5 top-4 rotate-12 border-2 border-lime/60 px-6 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-lime opacity-70" aria-hidden="true">
        Room ready
      </span>
      <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-lime">Launch manifest</p>
      <strong className="mt-2 block font-mono text-3xl tracking-[0.18em] text-ink">{room.roomCode ?? "READY"}</strong>
      <p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{room.gameId}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-lime/25 pt-3 text-center">
        <ManifestDatum label="Colonies" value={colonies} />
        <ManifestDatum label="Ants" value={ants} />
        <ManifestDatum label="Status" value="Created" />
      </div>
    </section>
  );
}

function ManifestDatum({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block font-mono text-[9px] uppercase tracking-wide text-ink-faint">{label}</span>
      <strong className="mt-1 block truncate text-sm text-ink">{value}</strong>
    </div>
  );
}

function LaunchPlanLine({ state, label }: { state: "done" | "active" | "pending"; label: string }) {
  const done = state === "done";
  const active = state === "active";
  return (
    <div className={`flex items-center gap-3 text-sm ${active ? "font-bold text-gold-deep" : "text-ink-soft"}`}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-bold ${
        done
          ? "border-lime bg-lime text-white"
          : active
            ? "border-gold bg-gold text-white"
            : "border-[color:var(--brd-soft)] text-ink-faint"
      }`}>
        {done ? "✓" : active ? "→" : "·"}
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
        <span className="font-mono text-xs uppercase text-gold">
          {fixture.eventCount == null ? "Replay ready" : `${fixture.eventCount} events`} · {fixture.source ?? "replay"}
        </span>
      </div>
    </div>
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

function adminColonySummary(colony: AdminColonyDraft): string {
  const temper = colony.style === "aggressive"
    ? "commits earlier"
    : colony.style === "cautious"
      ? "protects its food"
      : "balances risk and survival";
  const evidence = colony.infoNeed === "high"
    ? "waits for stronger evidence"
    : colony.infoNeed === "low"
      ? "acts with lighter evidence"
      : "uses a medium evidence threshold";
  return `${colony.size} ants · ${temper} · prioritizes ${colony.favoriteContext} · ${evidence}.`;
}

function matchTitle(game: GameState): string {
  return `${teamName(game.participant1, "Participant 1")} vs ${teamName(game.participant2, "Participant 2")}`;
}
