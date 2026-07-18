const state = {
  role: "user",
  userView: "home",
  identity: {
    anonymousId: null,
    playerName: "",
  },
  fixtures: [],
  selected: null,
  selectedStatus: null,
  game: {
    id: null,
    roomCode: null,
    stream: null,
    events: [],
    colonyCount: 0,
    players: [],
    colonies: [],
    coloniesById: {},
    strategyDrafts: {},
    selectedColonyId: null,
    betTab: "open",
    status: null,
    activeOpportunities: [],
    agentUsage: null,
    logCount: 0,
    eventsLoadedFromReplay: false,
  },
};

const ADMIN_REPLAY_DAYS = "14";
const ADMIN_REPLAY_LIMIT = "150";
const USER_LIVE_DAYS = "14";
const USER_LIVE_LIMIT = "100";
const LIVE_MATCH_WINDOW_MINUTES = 150;
const ANON_ID_STORAGE_KEY = "aocAnonymousId";
const PLAYER_NAME_STORAGE_KEY = "aocPlayerName";
const FIXED_COLONY_SIZE = 5;
const COLONY_SIZE_CHOICES = [
  { value: FIXED_COLONY_SIZE, label: "5 ants + 20 food", profile: "Fair start" },
];
const COLONY_STYLE_CHOICES = [
  { value: "cautious", label: "Cautious" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const COLONY_INFO_CHOICES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
let countdownTimer = null;
let copyRoomCodeTimer = null;

const els = {
  healthBadge: document.querySelector("#healthBadge"),
  modeUser: document.querySelector("#modeUser"),
  modeAdmin: document.querySelector("#modeAdmin"),
  fixtureCount: document.querySelector("#fixtureCount"),
  refreshFixtures: document.querySelector("#refreshFixtures"),
  fixtureFilters: document.querySelector("#fixtureFilters"),
  fixtureMode: document.querySelector("#fixtureMode"),
  fixtureDays: document.querySelector("#fixtureDays"),
  fixtureDate: document.querySelector("#fixtureDate"),
  competitionId: document.querySelector("#competitionId"),
  fixtureSearch: document.querySelector("#fixtureSearch"),
  liveMatchTarget: document.querySelector("#liveMatchTarget"),
  liveMatchStatus: document.querySelector("#liveMatchStatus"),
  liveMatchTitle: document.querySelector("#liveMatchTitle"),
  liveMatchMeta: document.querySelector("#liveMatchMeta"),
  participateMatch: document.querySelector("#participateMatch"),
  fixturesBody: document.querySelector("#fixturesBody"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  scoreBox: document.querySelector("#scoreBox"),
  manualFixture: document.querySelector("#manualFixture"),
  manualFixtureId: document.querySelector("#manualFixtureId"),
  createGame: document.querySelector("#createGame"),
  openJoinRoom: document.querySelector("#openJoinRoom"),
  startGameLive: document.querySelector("#startGameLive"),
  finishGameLive: document.querySelector("#finishGameLive"),
  exitGame: document.querySelector("#exitGame"),
  startGameReplay: document.querySelector("#startGameReplay"),
  gameStatus: document.querySelector("#gameStatus"),
  setupSteps: document.querySelector("#setupSteps"),
  roomCode: document.querySelector("#roomCode"),
  copyRoomCode: document.querySelector("#copyRoomCode"),
  roomCodeInput: document.querySelector("#roomCodeInput"),
  roomLobby: document.querySelector("#roomLobby"),
  matchCountdown: document.querySelector("#matchCountdown"),
  playerCount: document.querySelector("#playerCount"),
  joinRoomForm: document.querySelector("#joinRoomForm"),
  joinRoomPage: document.querySelector("#joinRoomPage"),
  playerName: document.querySelector("#playerName"),
  joinRoom: document.querySelector("#joinRoom"),
  backToHome: document.querySelector("#backToHome"),
  playerList: document.querySelector("#playerList"),
  simulationStatus: document.querySelector("#simulationStatus"),
  simulationStats: document.querySelector("#simulationStats"),
  agentCost: document.querySelector("#agentCost"),
  activeMarkets: document.querySelector("#activeMarkets"),
  myColonyPanel: document.querySelector("#myColonyPanel"),
  betBoardSummary: document.querySelector("#betBoardSummary"),
  betBoard: document.querySelector("#betBoard"),
  betTabs: document.querySelectorAll("[data-bet-tab]"),
  colonyForm: document.querySelector("#colonyForm"),
  colonyName: document.querySelector("#colonyName"),
  colonySize: document.querySelector("#colonySize"),
  colonySizeValue: document.querySelector("#colonySizeValue"),
  colonyStyle: document.querySelector("#colonyStyle"),
  colonyStyleValue: document.querySelector("#colonyStyleValue"),
  colonyFavoriteOptions: document.querySelectorAll('input[name="colonyFavorite"]'),
  colonyInfoNeed: document.querySelector("#colonyInfoNeed"),
  colonyInfoNeedValue: document.querySelector("#colonyInfoNeedValue"),
  colonyProfileTitle: document.querySelector("#colonyProfileTitle"),
  colonyProfileMeta: document.querySelector("#colonyProfileMeta"),
  addColony: document.querySelector("#addColony"),
  leaderboardTitle: document.querySelector("#leaderboardTitle"),
  gameLeaderboard: document.querySelector("#gameLeaderboard"),
  colonyDetail: document.querySelector("#colonyDetail"),
  gameFeed: document.querySelector("#gameFeed"),
};

const today = new Date().toISOString().slice(0, 10);
els.fixtureDate.value = today;

document.addEventListener("DOMContentLoaded", async () => {
  initAnonymousIdentity();
  bindEvents();
  applyWorkspaceRole(initialWorkspaceRole(), { load: false });
  const initialCode = initialRoomCode();
  if (initialCode) els.roomCodeInput.value = initialCode;
  setUserView(initialUserView(), { updateUrl: false });
  await checkHealth();
  await loadFixtures();
  if (initialCode) await loadRoomByCode(initialCode);
});

function bindEvents() {
  els.modeUser.addEventListener("click", () => applyWorkspaceRole("user"));
  els.modeAdmin.addEventListener("click", () => applyWorkspaceRole("admin"));
  els.refreshFixtures.addEventListener("click", loadFixtures);
  els.fixtureFilters.addEventListener("submit", (event) => {
    event.preventDefault();
    loadFixtures();
  });
  els.fixtureMode.addEventListener("change", () => {
    updateFixtureFilterState();
    loadFixtures();
  });
  els.fixtureSearch.addEventListener("input", debounce(loadFixtures, 300));
  els.roomCodeInput.addEventListener("input", () => {
    els.roomCodeInput.value = cleanRoomCode(els.roomCodeInput.value);
    updateGameActions();
  });
  els.playerName.addEventListener("input", updateGameActions);
  els.fixtureDays.addEventListener("change", loadFixtures);
  els.competitionId.addEventListener("change", loadFixtures);
  els.fixtureDate.addEventListener("change", loadFixtures);
  els.manualFixture.addEventListener("submit", (event) => {
    event.preventDefault();
    const fixtureId = Number(els.manualFixtureId.value);
    if (!fixtureId) return;
    selectFixture({ fixtureId, participant1: null, participant2: null, competition: "Manual" });
  });
  els.createGame.addEventListener("click", createGame);
  els.openJoinRoom.addEventListener("click", openJoinRoomPage);
  els.backToHome.addEventListener("click", backToHome);
  els.copyRoomCode.addEventListener("click", copyRoomCode);
  els.participateMatch.addEventListener("click", participateInMatch);
  els.startGameLive.addEventListener("click", startGameLive);
  els.finishGameLive.addEventListener("click", finishGameLive);
  els.exitGame.addEventListener("click", exitFinishedGame);
  els.startGameReplay.addEventListener("click", startGameReplay);
  els.joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    joinRoom();
  });
  els.colonyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addColony();
  });
  [els.colonyStyle, els.colonyInfoNeed].forEach((control) => {
    control.addEventListener("input", updateColonyBuilder);
  });
  els.colonyFavoriteOptions.forEach((control) => {
    control.addEventListener("change", updateColonyBuilder);
  });
  els.betTabs.forEach((button) => {
    button.addEventListener("click", () => selectBetTab(button.dataset.betTab));
  });
  updateColonyBuilder();
}

function applyWorkspaceRole(role, options = {}) {
  const { load = true } = options;
  state.role = role === "admin" ? "admin" : "user";
  document.body.dataset.workspaceRole = state.role;

  const isAdmin = state.role === "admin";
  els.modeUser.classList.toggle("active", !isAdmin);
  els.modeUser.setAttribute("aria-pressed", String(!isAdmin));
  els.modeAdmin.classList.toggle("active", isAdmin);
  els.modeAdmin.setAttribute("aria-pressed", String(isAdmin));

  els.fixtureMode.value = isAdmin ? "recent" : "upcoming";
  els.fixtureDays.value = isAdmin ? ADMIN_REPLAY_DAYS : USER_LIVE_DAYS;
  if (!isAdmin && !els.fixtureDate.value) els.fixtureDate.value = today;
  els.createGame.textContent = isAdmin ? "Create replay room" : "Create room";
  els.joinRoom.textContent = isAdmin ? "Add player" : "Join";
  els.startGameLive.textContent = "Start game";
  els.startGameLive.hidden = isAdmin;
  els.finishGameLive.hidden = isAdmin;
  els.exitGame.hidden = true;
  els.startGameReplay.hidden = !isAdmin;

  clearSelection();
  resetGameUi();
  setUserView("home", { updateUrl: false });
  updateFixtureFilterState();
  if (load) loadFixtures();
}

function initialWorkspaceRole() {
  const params = new URLSearchParams(window.location.search);
  return params.get("admin") === "1" || params.get("mode") === "admin" ? "admin" : "user";
}

function initialRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return cleanRoomCode(params.get("room") || params.get("code"));
}

function initialUserView() {
  const params = new URLSearchParams(window.location.search);
  if (state.role !== "user") return "home";
  if (params.get("join") === "1" || params.get("view") === "join" || initialRoomCode()) return "join";
  return "home";
}

function setUserView(view, options = {}) {
  const { updateUrl = true } = options;
  if (state.role !== "user") {
    state.userView = "home";
    delete document.body.dataset.userView;
    return;
  }
  state.userView = ["home", "join", "room"].includes(view) ? view : "home";
  document.body.dataset.userView = state.userView;
  if (updateUrl) {
    if (state.userView === "home") setHomeUrl();
    if (state.userView === "join") setJoinUrl(cleanRoomCode(els.roomCodeInput.value || ""));
  }
  updateGameActions();
}

function openJoinRoomPage() {
  if (state.userView !== "join" && state.game.id && !currentPlayer()) {
    resetGameUi("Enter a private code to join.");
  }
  setUserView("join");
  els.gameStatus.textContent = "Enter a private code to join.";
  els.roomCodeInput.focus();
}

function backToHome() {
  if (state.role !== "user") return;
  resetGameUi("Create or join a private room.");
  setUserView("home");
}

function exitFinishedGame() {
  if (state.role !== "user") return;
  resetGameUi("Create or join a private room.");
  setUserView("home");
}

function updateFixtureFilterState() {
  const mode = state.role === "admin" ? "recent" : "upcoming";
  els.fixtureMode.value = mode;
  els.fixtureMode.disabled = true;
  els.fixtureDate.disabled = mode === "recent";
  els.fixtureDays.disabled = mode === "date";
}

async function checkHealth() {
  try {
    const health = await getJson("/health");
    els.healthBadge.className = health.txlineConfigured ? "badge badge-ok" : "badge badge-error";
    if (!health.txlineConfigured) {
      els.healthBadge.textContent = "Missing credentials";
    } else if (health.openrouterConfigured) {
      els.healthBadge.textContent = `TXLine + ${health.colonyAgentCallMode || "agent"} ${health.colonyAgentModel}`;
    } else {
      els.healthBadge.textContent = "TXLine configured - DeepSeek required";
    }
  } catch {
    els.healthBadge.className = "badge badge-error";
    els.healthBadge.textContent = "Backend unavailable";
  }
}

async function loadFixtures() {
  setFixtureRows([{ loading: true }]);
  const mode = state.role === "admin" ? "recent" : "upcoming";
  els.fixtureMode.value = mode;
  const params = new URLSearchParams();
  if (state.role !== "admin" && els.competitionId.value) params.set("competition_id", els.competitionId.value);
  if (state.role !== "admin" && els.fixtureSearch.value.trim()) params.set("search", els.fixtureSearch.value.trim());

  let endpoint = "/api/fixtures/recent";
  if (mode === "recent") {
    params.set("days", ADMIN_REPLAY_DAYS);
    params.set("limit", ADMIN_REPLAY_LIMIT);
  } else if (mode === "upcoming") {
    endpoint = state.role === "admin" ? "/api/fixtures/upcoming" : "/api/fixtures/live-target";
    params.set("days", els.fixtureDays.value || USER_LIVE_DAYS);
    if (state.role === "admin") params.set("limit", USER_LIVE_LIMIT);
    if (state.role === "admin" && els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  } else {
    endpoint = "/api/fixtures";
    if (els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  }

  try {
    const data = await getJson(`${endpoint}?${params.toString()}`);
    state.fixtures = data.fixtures || [];
    els.fixtureCount.textContent = fixtureCountLabel(mode, data);
    if (state.role !== "admin") {
      await applyNextFixture(data);
      return;
    }
    renderFixtures();
  } catch (error) {
    state.fixtures = [];
    els.fixtureCount.textContent = "Error";
    if (state.role !== "admin") renderLiveMatchTarget(null, "error", error.message);
    setFixtureRows([{ error: error.message }]);
  }
}

function fixtureCountLabel(mode, data) {
  const count = data.count || 0;
  if (mode === "recent") return `${count} replay fixture(s)`;
  if (data.mode === "live_target") {
    if (data.status === "current") return "Current match selected";
    if (data.status === "next") return "Next match selected";
    return "No upcoming match";
  }
  if (mode === "upcoming") return `${count} live fixture(s)`;
  return `${count} match(es)`;
}

async function applyNextFixture(data) {
  const target = data.fixture || state.fixtures[0] || null;
  const targetStatus = data.status || fixtureLiveStatus(target) || (target ? "next" : "empty");
  state.fixtures = target ? [target] : [];
  renderLiveMatchTarget(target, targetStatus);
  if (!target) {
    if (!state.game.id) {
      state.selected = null;
      state.selectedStatus = null;
      paintSelectedFixture(null);
    }
    setFixtureRows([]);
    updateGameActions();
    return;
  }

  if (!state.game.id && state.selected?.fixtureId !== target.fixtureId) {
    setSelectedFixture(target, { reset: false, status: targetStatus });
  } else {
    if (state.selected?.fixtureId === target.fixtureId) {
      state.selectedStatus = targetStatus;
      paintSelectedFixture(target);
    }
    updateGameActions();
  }
}

function renderFixtures() {
  if (!state.fixtures.length) {
    setFixtureRows([]);
    return;
  }

  els.fixturesBody.replaceChildren(
    ...state.fixtures.map((fixture) => {
      const row = document.createElement("tr");
      if (state.selected?.fixtureId === fixture.fixtureId) row.classList.add("selected");
      row.innerHTML = `
        <td>${formatDate(fixture.startTimeIso || fixture.startTime)}</td>
        <td>
          <div class="match-name">${escapeHtml(fixture.participant1 || "Participant 1")} - ${escapeHtml(
            fixture.participant2 || "Participant 2",
          )}</div>
          <div class="muted">Fixture ${escapeHtml(fixture.fixtureId)}</div>
        </td>
        <td>
          <div>${escapeHtml(fixture.competition || "-")}</div>
        </td>
      `;
      row.addEventListener("click", () => selectFixture(fixture));
      return row;
    }),
  );
}

function setFixtureRows(rows) {
  if (!rows.length) {
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">No match found.</td></tr>`;
    return;
  }
  const first = rows[0];
  if (first.loading) {
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">Loading...</td></tr>`;
    return;
  }
  if (first.error) {
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">${escapeHtml(first.error)}</td></tr>`;
  }
}

function selectFixture(fixture) {
  setSelectedFixture(fixture, { reset: true });
}

function setSelectedFixture(fixture, options = {}) {
  const { reset = true, status = null } = options;
  if (reset) resetGameUi();
  state.selectedStatus = fixture ? status || fixtureLiveStatus(fixture) : null;
  paintSelectedFixture(fixture);
  renderFixtures();
  updateGameActions();
}

function fixtureLiveStatus(fixture) {
  if (!fixture) return null;
  const value = fixture.startTimeIso || fixture.startTime;
  if (!value) return null;
  const start = new Date(normalizeDateInput(value));
  if (Number.isNaN(start.getTime())) return null;
  const diffMs = Date.now() - start.getTime();
  if (diffMs >= 0 && diffMs <= LIVE_MATCH_WINDOW_MINUTES * 60 * 1000) return "current";
  if (diffMs < 0) return "next";
  return null;
}

function renderLiveMatchTarget(fixture, status = "empty", message = "") {
  if (!els.liveMatchTarget) return;
  const hasFixture = Boolean(fixture?.fixtureId);
  const statusLabels = {
    current: "Match in progress",
    next: "Next match",
    empty: "No match",
    error: "Error",
  };
  els.liveMatchStatus.textContent = statusLabels[status] || "Match";
  els.liveMatchStatus.className = `match-status ${escapeHtml(status || "empty")}`;
  els.liveMatchTitle.textContent = hasFixture
    ? `${fixture.participant1 || "Participant 1"} - ${fixture.participant2 || "Participant 2"}`
    : "No match available";
  const liveHint =
    status === "current"
      ? "Live now - rooms can still be created."
      : status === "next"
        ? "Next kickoff - room can be prepared."
        : "";
  els.liveMatchMeta.textContent = hasFixture
    ? [liveHint, formatDate(fixture.startTimeIso || fixture.startTime), fixture.competition || "Unknown competition", `Fixture ${fixture.fixtureId}`]
        .filter(Boolean)
        .join(" - ")
    : message || "Refresh when the next TXLine fixture is available.";
  updateGameActions();
}

function paintSelectedFixture(fixture) {
  state.selected = fixture;
  if (!fixture) {
    els.manualFixtureId.value = "";
    els.selectedTitle.textContent = state.role === "admin" ? "Select a replay fixture" : "Select a live fixture";
    els.selectedMeta.textContent =
      state.role === "admin" ? "Completed TXLine matches are used for pipeline tests." : "Upcoming TXLine matches open live colony rooms.";
    updateScore(null);
    return;
  }

  els.manualFixtureId.value = fixture.fixtureId || "";
  els.selectedTitle.textContent = `${fixture.participant1 || "Participant 1"} - ${fixture.participant2 || "Participant 2"}`;
  const liveNote =
    state.selectedStatus === "current"
      ? "Match in progress - you can create a live room now."
      : state.selectedStatus === "next"
        ? "Next match - create a room before kickoff."
        : "Fixture selected.";
  els.selectedMeta.textContent = `${fixture.competition || "Unknown competition"} - Fixture ${fixture.fixtureId} - ${liveNote}`;
  updateScore(fixture.score);
}

function clearSelection() {
  state.selected = null;
  state.selectedStatus = null;
  paintSelectedFixture(null);
  renderFixtures();
  updateGameActions();
}

async function createGame() {
  if (!state.selected?.fixtureId) {
    els.gameStatus.textContent = state.role === "admin" ? "Select a replay fixture before creating a room." : "Select a live fixture before creating a room.";
    return null;
  }
  const creatorName = state.role === "user" ? currentPlayerName() || "Host" : currentPlayerName();

  closeGameStream();
  els.gameStatus.textContent =
    state.role === "admin"
      ? "Creating replay room..."
      : state.selectedStatus === "current"
        ? "Creating live room for the match in progress..."
        : "Creating live room...";
  try {
    if (creatorName) persistPlayerName(creatorName);
    const payload = {
      fixtureId: state.selected.fixtureId,
      participant1: state.selected.participant1,
      participant2: state.selected.participant2,
      competition: state.selected.competition,
      startTime: state.selected.startTime,
      startTimeIso: state.selected.startTimeIso,
    };
    if (state.role === "user") {
      payload.anonymousId = state.identity.anonymousId;
      payload.creatorName = creatorName;
    }
    const game = await postJson("/api/games", payload);
    state.game.id = game.gameId;
    state.game.roomCode = game.roomCode || null;
    state.game.events = [];
    state.game.colonyCount = 0;
    state.game.players = [];
    state.game.colonies = [];
    state.game.coloniesById = {};
    state.game.strategyDrafts = {};
    state.game.selectedColonyId = null;
    state.game.status = game.status;
    state.game.activeOpportunities = [];
    state.game.agentUsage = null;
    state.game.logCount = game.logCount || 0;
    state.game.eventsLoadedFromReplay = false;
    els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
    renderSelectedColonyDetail();
    renderGameState(game);
    if (game.roomCode) els.roomCodeInput.value = game.roomCode;
    setRoomUrl(game.roomCode);
    if (state.role === "user") setUserView("room", { updateUrl: false });
    openGameStream();
    return game;
  } catch (error) {
    els.gameStatus.textContent = error.message;
    return null;
  }
}

async function participateInMatch() {
  const target = state.fixtures[0] || null;
  if (!target?.fixtureId) {
    els.gameStatus.textContent = "No match is available yet.";
    return;
  }
  const status = state.selectedStatus || "next";
  setSelectedFixture(target, { reset: !state.game.id && state.selected?.fixtureId !== target.fixtureId, status });
  els.gameStatus.textContent =
    status === "current"
      ? "Match in progress selected. Create a live room, then add your colony."
      : "Next match selected. Create a room, then join with your name.";
}

async function loadRoomByCode(roomCode) {
  const cleanCode = cleanRoomCode(roomCode);
  if (cleanCode.length !== 6) return null;
  try {
    const game = await getJson(`/api/rooms/${cleanCode}`);
    setSelectedFixture(fixtureFromGame(game), { reset: false });
    els.roomCodeInput.value = game.roomCode || cleanCode;
    renderGameState(game);
    const isMember = Boolean(currentPlayer(game.players || []));
    if (state.role === "user") {
      setUserView(isMember ? "room" : "join", { updateUrl: false });
      if (isMember) {
        setRoomUrl(game.roomCode || cleanCode);
        openGameStream();
      } else {
        setJoinUrl(game.roomCode || cleanCode);
        closeGameStream();
        els.gameStatus.textContent = "Enter your name to join this room.";
      }
    } else {
      setRoomUrl(game.roomCode || cleanCode);
      openGameStream();
    }
    return game;
  } catch (error) {
    els.gameStatus.textContent = error.message;
    setUserView("join", { updateUrl: false });
    updateGameActions();
    return null;
  }
}

async function joinRoom() {
  const roomCode = cleanRoomCode(els.roomCodeInput.value || state.game.roomCode || "");
  if (roomCode.length !== 6) {
    els.gameStatus.textContent = "Enter the 6-digit room code.";
    return;
  }
  const name = els.playerName.value.trim();
  if (!name) {
    els.gameStatus.textContent = "Enter a player name before joining.";
    return;
  }
  els.gameStatus.textContent = "Joining room...";
  try {
    persistPlayerName(name);
    const game = await postJson(`/api/rooms/${roomCode}/players`, {
      name,
      anonymousId: state.identity.anonymousId,
    });
    els.roomCodeInput.value = game.roomCode || roomCode;
    setSelectedFixture(fixtureFromGame(game), { reset: false });
    renderGameState(game);
    setRoomUrl(game.roomCode || roomCode);
    if (state.role === "user") setUserView("room", { updateUrl: false });
    openGameStream();
    els.gameStatus.textContent = `${name} joined the room.`;
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function copyRoomCode() {
  const roomCode = cleanRoomCode(state.game.roomCode || els.roomCode.textContent);
  if (roomCode.length !== 6) return;
  try {
    await writeClipboardText(roomCode);
    showCopyRoomCodeFeedback("Copied");
    els.gameStatus.textContent = `Room code ${roomCode} copied.`;
  } catch {
    showCopyRoomCodeFeedback("Copy failed");
    els.gameStatus.textContent = `Room code ${roomCode}.`;
  }
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("input");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function showCopyRoomCodeFeedback(label) {
  if (!els.copyRoomCode) return;
  clearTimeout(copyRoomCodeTimer);
  els.copyRoomCode.textContent = label;
  copyRoomCodeTimer = setTimeout(() => {
    els.copyRoomCode.textContent = "Copy";
  }, 1600);
}

async function addColony() {
  if (!state.game.id) return;
  if (state.role === "user" && !currentPlayer()) {
    els.gameStatus.textContent = "Join the room before creating your colony.";
    return;
  }
  if (state.role === "user" && currentPlayerHasColony()) {
    els.gameStatus.textContent = "You already have a colony in this room.";
    return;
  }
  const fallbackName = state.role === "user" ? defaultColonyName() : `Colony ${Date.now().toString().slice(-4)}`;
  const styleChoice = sliderChoice(els.colonyStyle, COLONY_STYLE_CHOICES);
  const infoChoice = sliderChoice(els.colonyInfoNeed, COLONY_INFO_CHOICES);
  const payload = {
    name: els.colonyName.value.trim() || fallbackName,
    size: FIXED_COLONY_SIZE,
    style: styleChoice.value,
    favoriteContext: selectedColonyFavorite(),
    infoNeed: infoChoice.value,
  };
  if (state.role === "user") payload.anonymousId = state.identity.anonymousId;
  els.gameStatus.textContent = "Adding colony...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/colonies`, payload);
    els.colonyName.value = "";
    els.gameStatus.textContent = `${payload.name} added.`;
    renderGameState(game);
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

function updateColonyBuilder() {
  const sizeChoice = sliderChoice(els.colonySize, COLONY_SIZE_CHOICES);
  const styleChoice = sliderChoice(els.colonyStyle, COLONY_STYLE_CHOICES);
  const infoChoice = sliderChoice(els.colonyInfoNeed, COLONY_INFO_CHOICES);
  const favoriteLabel = selectedColonyFavoriteLabel();
  els.colonySizeValue.textContent = sizeChoice.label;
  els.colonyStyleValue.textContent = styleChoice.label;
  els.colonyInfoNeedValue.textContent = infoChoice.label;
  els.colonyProfileTitle.textContent = `${styleChoice.label} colony`;
  els.colonyProfileMeta.textContent = `${sizeChoice.label} · ${favoriteLabel} · ${infoChoice.label} info`;
}

function sliderChoice(control, choices) {
  const index = Math.max(0, Math.min(choices.length - 1, Number(control.value) || 0));
  return choices[index] || choices[0];
}

function selectedColonyFavorite() {
  return Array.from(els.colonyFavoriteOptions).find((control) => control.checked)?.value || "balanced";
}

function selectedColonyFavoriteLabel() {
  const value = selectedColonyFavorite();
  const option = Array.from(els.colonyFavoriteOptions).find((control) => control.value === value);
  return option?.nextElementSibling?.textContent?.trim() || "Balanced";
}

async function updateColonyStrategy(colonyId) {
  if (!state.game.id || !colonyId) return;
  const { style, favoriteContext, infoNeed } = readStrategyControls(colonyId);
  els.gameStatus.textContent = "Saving strategy...";
  try {
    const game = await patchJson(`/api/games/${state.game.id}/colonies/${encodeURIComponent(colonyId)}/strategy`, {
      style,
      favoriteContext,
      infoNeed,
      anonymousId: state.identity.anonymousId,
    });
    delete state.game.strategyDrafts[colonyId];
    renderGameState(game);
    els.gameStatus.textContent = "Strategy saved.";
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function startGameReplay() {
  if (!state.game.id) return;
  if (state.role !== "admin") {
    els.gameStatus.textContent = "Replay runs are available in admin mode.";
    return;
  }
  if (state.game.colonyCount < 1) {
    els.gameStatus.textContent = "Add at least one colony before starting the match.";
    updateGameActions();
    return;
  }
  els.gameStatus.textContent = "Replay game in progress...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/start`, {
      mode: "replay",
      source: "historical",
    });
    renderGameState(game);
    await loadGameReplay();
    els.gameStatus.textContent = "Match run started. Decisions will appear in the journal.";
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function startGameLive() {
  if (!state.game.id) return;
  if (state.role !== "user") {
    els.gameStatus.textContent = "Live games are available in user mode.";
    return;
  }
  if (!currentPlayer()?.isHost) {
    els.gameStatus.textContent = "Only the room host can start the game.";
    updateGameActions();
    return;
  }
  if (!allPlayersReady()) {
    els.gameStatus.textContent = "Every player needs a colony before start.";
    updateGameActions();
    return;
  }
  els.gameStatus.textContent = "Locking room...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/start`, {
      mode: "live",
      source: "updates",
      anonymousId: state.identity.anonymousId,
    });
    renderGameState(game);
    openGameStream();
    els.gameStatus.textContent =
      game.status === "waiting_kickoff"
        ? "Room locked. Colony decisions begin at kickoff."
        : "Live room connected. Colony decisions will appear with TXLine events.";
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function finishGameLive() {
  if (!state.game.id) return;
  if (state.role !== "user") {
    els.gameStatus.textContent = "Manual finish is available in user mode.";
    return;
  }
  if (!currentPlayer()?.isHost) {
    els.gameStatus.textContent = "Only the room host can finish the game.";
    updateGameActions();
    return;
  }
  els.gameStatus.textContent = "Finishing game...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/finish`, {
      anonymousId: state.identity.anonymousId,
    });
    renderGameState(game);
    closeGameStream();
    els.gameStatus.textContent = "Match finished. Final leaderboard available.";
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

function openGameStream() {
  closeGameStream();
  if (!state.game.id) return;
  state.game.stream = new EventSource(`/api/games/${state.game.id}/events`);
  state.game.stream.addEventListener("game_event", (event) => {
    appendGameEvent(JSON.parse(event.data));
  });
  state.game.stream.addEventListener("game_state", (event) => {
    renderGameState(JSON.parse(event.data));
  });
  state.game.stream.onerror = () => {
    if (["running_replay", "running_live"].includes(state.game.status)) {
      els.gameStatus.textContent = "Game stream reconnecting...";
    }
  };
}

function closeGameStream() {
  if (state.game.stream) {
    state.game.stream.close();
    state.game.stream = null;
  }
}

async function loadGameReplay() {
  if (!state.game.id) return;
  const data = await getJson(`/api/games/${state.game.id}/replay`);
  renderGameState(data.game);
  state.game.events = [];
  state.game.eventsLoadedFromReplay = true;
  state.game.players = data.game?.players || state.game.players || [];
  state.game.strategyDrafts = {};
  els.gameFeed.innerHTML = "";
  (data.events || []).forEach(appendGameEvent);
  state.game.logCount = Math.max(state.game.logCount || 0, state.game.events.length);
  renderSelectedColonyDetail();
  renderMyColonyPanel();
  renderBetBoard();
}

function resetGameUi(message = null) {
  closeGameStream();
  state.game.id = null;
  state.game.roomCode = null;
  state.game.events = [];
  state.game.colonyCount = 0;
  state.game.players = [];
  state.game.colonies = [];
  state.game.coloniesById = {};
  state.game.strategyDrafts = {};
  state.game.selectedColonyId = null;
  state.game.betTab = "open";
  state.game.status = null;
  state.game.activeOpportunities = [];
  state.game.agentUsage = null;
  state.game.logCount = 0;
  state.game.eventsLoadedFromReplay = false;
  els.gameStatus.textContent =
    message ||
    (state.role === "admin"
      ? "Create a replay room from a completed match."
      : "Create or join a private room.");
  els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
  if (els.leaderboardTitle) els.leaderboardTitle.textContent = "Leaderboard";
  els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
  renderSelectedColonyDetail();
  renderMyColonyPanel();
  renderBetBoard();
  if (state.role !== "admin") els.roomCodeInput.value = "";
  delete document.body.dataset.gameStatus;
  renderSimulationSummary(null);
  renderRoomSetup(null);
  updateGameActions();
}

function renderGameState(game) {
  if (!game) return;
  const colonies = game.colonies || [];
  state.game.id = game.gameId || state.game.id;
  state.game.roomCode = game.roomCode || state.game.roomCode;
  state.game.colonyCount = colonies.length;
  state.game.players = game.players || state.game.players || [];
  state.game.colonies = colonies;
  state.game.coloniesById = colonies.reduce((map, colony) => {
    if (colony.colonyId) map[colony.colonyId] = colony.name;
    return map;
  }, {});
  state.game.status = game.status || null;
  state.game.logCount = Number(game.logCount || state.game.logCount || 0);
  document.body.dataset.gameStatus = state.game.status || "created";
  state.game.activeOpportunities = game.activeOpportunities || [];
  state.game.agentUsage = game.agentUsage || state.game.agentUsage;
  if (!state.game.selectedColonyId && colonies.length) {
    const ownColony = currentUserColony(colonies);
    state.game.selectedColonyId = ownColony?.colonyId || colonies[0]?.colonyId || null;
  }
  updateScore(game.match?.score);
  updateGameActions();
  renderRoomSetup(game);
  renderSimulationSummary(game);
  renderMyColonyPanel();
  if (els.leaderboardTitle) {
    els.leaderboardTitle.textContent = state.role === "user" && state.game.status === "finished" ? "Final results" : "Leaderboard";
  }
  els.gameStatus.textContent =
    state.role === "user"
      ? userRoomStatusText(game)
      : [
          game.gameId ? `Room ${game.gameId}` : null,
          game.status ? `status ${game.status}` : null,
          game.eventIndex != null ? `${game.eventIndex} events` : null,
        ]
          .filter(Boolean)
          .join(" - ");

  if (!colonies.length) {
    els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
    state.game.selectedColonyId = null;
    renderSelectedColonyDetail();
    renderBetBoard();
    return;
  }

  els.gameLeaderboard.replaceChildren(
    ...colonies.map((colony, index) => {
      const card = document.createElement("article");
      card.className = index === 0 ? "colony-card leader" : "colony-card";
      if (state.game.selectedColonyId === colony.colonyId) card.classList.add("selected");
      card.dataset.colonyCard = colony.colonyId || "";
      card.title = `View ${colony.name} results`;
      const scoreTitle = formatScoreBreakdown(colony.scoreBreakdown);
      const strategyLocked = isRoomLockedStatus(state.game.status);
      const strategyDraft = state.game.strategyDrafts[colony.colonyId] || {};
      const selectedStyle = strategyDraft.style || colony.style;
      const selectedFavorite = strategyDraft.favoriteContext || colony.favoriteContext;
      const selectedInfoNeed = strategyDraft.infoNeed || colony.infoNeed;
      card.innerHTML = `
        <div class="colony-rank">#${index + 1}</div>
        <div>
          <div class="colony-head">
            <div>
              <h4>${escapeHtml(colony.name)}</h4>
              <span>${escapeHtml(colonyRecordLabel(colony))}</span>
            </div>
            <button type="button" class="colony-detail-trigger" data-colony-detail="${escapeHtml(
              colony.colonyId,
            )}" aria-label="View ${escapeHtml(colony.name)} results">Details</button>
          </div>
          <p>${escapeHtml(strategyLabel(colony))}</p>
          ${renderColonyEconomy(colony, scoreTitle)}
          <div class="colony-dna">${renderArchetypeSummary(colony.archetypes)}</div>
          <div class="strategy-editor">
            <label>
              Style
              <select data-strategy-style="${escapeHtml(colony.colonyId)}" ${strategyLocked ? "disabled" : ""}>
                ${strategyOptions(["cautious", "balanced", "aggressive"], selectedStyle)}
              </select>
            </label>
            <label>
              Ground
              <select data-strategy-favorite="${escapeHtml(colony.colonyId)}" ${strategyLocked ? "disabled" : ""}>
                ${strategyOptions(["balanced", "penalties", "corners", "momentum", "chaos"], selectedFavorite)}
              </select>
            </label>
            <label>
              Info
              <select data-strategy-info="${escapeHtml(colony.colonyId)}" ${strategyLocked ? "disabled" : ""}>
                ${strategyOptions(["low", "medium", "high"], selectedInfoNeed)}
              </select>
            </label>
            <button type="button" data-save-strategy="${escapeHtml(colony.colonyId)}" ${strategyLocked ? "disabled" : ""}>Save</button>
          </div>
        </div>
      `;
      card.querySelectorAll("[data-strategy-style], [data-strategy-favorite], [data-strategy-info]").forEach((control) => {
        control.addEventListener("change", () => updateStrategyDraft(colony.colonyId));
      });
      card.querySelector("[data-save-strategy]")?.addEventListener("click", (event) => {
        updateColonyStrategy(event.currentTarget.dataset.saveStrategy);
      });
      card.querySelector("[data-colony-detail]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        selectColonyDetail(event.currentTarget.dataset.colonyDetail);
      });
      card.addEventListener("click", (event) => {
        if (event.target.closest("button, select, input, label, a, textarea")) return;
        selectColonyDetail(colony.colonyId);
      });
      return card;
    }),
  );
  renderSelectedColonyDetail();
  renderMyColonyPanel();
  renderBetBoard();
}

async function selectColonyDetail(colonyId) {
  if (!colonyId) return;
  state.game.selectedColonyId = colonyId;
  updateColonyCardSelection();
  renderMyColonyPanel();
  renderBetBoard();
  renderSelectedColonyDetail({ loading: shouldLoadReplayEvents() });
  await ensureReplayEventsLoadedForAudit();
  updateColonyCardSelection();
  renderMyColonyPanel();
  renderBetBoard();
  renderSelectedColonyDetail();
}

function updateColonyCardSelection() {
  document.querySelectorAll("[data-colony-card]").forEach((card) => {
    card.classList.toggle("selected", card.dataset.colonyCard === state.game.selectedColonyId);
  });
}

function shouldLoadReplayEvents() {
  if (!state.game.id || state.game.eventsLoadedFromReplay) return false;
  const visibleEvents = state.game.events.length;
  const expectedEvents = Number(state.game.logCount || 0);
  if (expectedEvents > visibleEvents) return true;
  const selectedColony = (state.game.colonies || []).find((item) => item.colonyId === state.game.selectedColonyId);
  if (!selectedColony) return false;
  const results = colonyResultEvents(selectedColony);
  return Number(selectedColony.wins || 0) > results.wins.length || Number(selectedColony.losses || 0) > results.losses.length;
}

async function ensureReplayEventsLoadedForAudit() {
  if (!shouldLoadReplayEvents()) return;
  try {
    const data = await getJson(`/api/games/${state.game.id}/replay`);
    const events = Array.isArray(data.events) ? data.events : [];
    state.game.events = events;
    state.game.eventsLoadedFromReplay = true;
    state.game.players = data.game?.players || state.game.players || [];
    state.game.logCount = Math.max(Number(data.game?.logCount || 0), events.length, state.game.logCount || 0);
    if (data.game) renderGameState(data.game);
    renderGameJournal();
    renderSimulationSummary(data.game);
    renderMyColonyPanel();
    renderBetBoard();
  } catch (error) {
    els.gameStatus.textContent = `Could not load colony results: ${error.message}`;
  }
}

function renderSelectedColonyDetail(options = {}) {
  if (!els.colonyDetail) return;
  const colony = (state.game.colonies || []).find((item) => item.colonyId === state.game.selectedColonyId);
  if (!colony) {
    state.game.selectedColonyId = null;
    els.colonyDetail.hidden = true;
    els.colonyDetail.innerHTML = `<p class="empty">Select a colony to inspect its resolved bets.</p>`;
    updateColonyCardSelection();
    return;
  }

  const results = colonyResultEvents(colony);
  const visibleWins = results.wins.length;
  const visibleLosses = results.losses.length;
  const engineWins = Number(colony.wins || 0);
  const engineLosses = Number(colony.losses || 0);
  const historyMatches = visibleWins === engineWins && visibleLosses === engineLosses;
  const recordNote = options.loading
    ? "Loading full match history..."
    : historyMatches
      ? "W/L is counted from settled bets only. Voided bets release ants and do not count."
      : `Engine record is ${engineWins}W / ${engineLosses}L; visible history currently shows ${visibleWins}W / ${visibleLosses}L.`;

  els.colonyDetail.hidden = false;
  els.colonyDetail.innerHTML = `
    <div class="colony-detail-head">
      <div>
        <span class="detail-kicker">Colony audit</span>
        <h4>${escapeHtml(colony.name)}</h4>
        <p>${escapeHtml(recordNote)}</p>
      </div>
      <button type="button" class="detail-close" data-close-colony-detail aria-label="Close colony detail">Close</button>
    </div>
    <div class="colony-detail-metrics" aria-label="${escapeHtml(`${colony.name} result summary`)}">
      ${colonyAuditMetric(`${engineWins}W / ${engineLosses}L`, "Record", "resolved bets")}
      ${colonyAuditMetric(formatSignedNumber(colony.foodNet || 0), "Net food", "from bets", Number(colony.foodNet || 0) >= 0 ? "good" : "bad")}
      ${colonyAuditMetric(formatScoreValue(colony.score), "Score", "final rank")}
      ${colonyAuditMetric(`${results.voids.length}`, "Voided", "not counted")}
    </div>
    <div class="colony-result-columns">
      ${renderColonyResultSection("Winning bets", results.wins, "win")}
      ${renderColonyResultSection("Losing bets", results.losses, "loss")}
    </div>
    ${results.voids.length ? renderColonyResultSection("Voided bets", results.voids, "void") : ""}
  `;
  els.colonyDetail.querySelector("[data-close-colony-detail]")?.addEventListener("click", () => {
    state.game.selectedColonyId = null;
    updateColonyCardSelection();
    renderMyColonyPanel();
    renderBetBoard();
    renderSelectedColonyDetail();
  });
}

function renderMyColonyPanel() {
  if (!els.myColonyPanel) return;

  if (!state.game.id) {
    renderMyColonyEmpty("My colony", "Create or join a room to see your colony stats.");
    return;
  }

  const colony = myColonyForView();
  if (!colony) {
    const message =
      state.role === "user"
        ? "Join the room and deploy your colony to follow food, ants and bets here."
        : "Select a colony to inspect its live stats.";
    renderMyColonyEmpty("My colony", message);
    return;
  }

  const rank = colonyRank(colony);
  const insight = colonyEconomyInsight(colony);
  const food = Number(colony.food || 0);
  const alive = Number(colony.antsAlive || 0);
  const active = Number(colony.antsActive ?? colony.antsAlive ?? 0);
  const atStake = Number(colony.antsEngaged || 0);
  const wounded = Number(colony.antsWounded || 0);
  const dead = Number(colony.antsDead || 0);
  const wins = Number(colony.wins || 0);
  const losses = Number(colony.losses || 0);
  const settled = wins + losses;
  const accuracy = settled ? `${Math.round((wins / settled) * 100)}%` : "No result";
  const records = collectBetRecords(colony.colonyId);
  const openBets = records.filter((record) => record.status === "open");
  const potentialFood = openBets.reduce((total, record) => total + Math.round(Number(record.ants || 0) * Number(record.multiplier || 0)), 0);
  const subtitle = state.role === "user" ? "Your live colony status" : "Selected colony status";
  const netFoodLevel = Number(colony.foodNet || 0) >= 0 ? "good" : "danger";
  const stakeLevel = metricRiskLevel(atStake, Math.max(active, alive));
  const lossLevel = metricDeathLevel(dead, Number(colony.size || alive || 1));

  els.myColonyPanel.innerHTML = `
    <div class="my-colony-head">
      <div>
        <span class="section-kicker">${escapeHtml(subtitle)}</span>
        <h3>${escapeHtml(colony.name)}</h3>
        <p class="my-colony-status ${escapeHtml(insight.level)}">${escapeHtml(insight.text)}</p>
      </div>
      <div class="my-colony-rank" aria-label="${escapeHtml(rank ? `Rank ${rank}` : "Rank unavailable")}">
        <span>Rank</span>
        <strong>${rank ? `#${rank}` : "-"}</strong>
      </div>
    </div>
    <div class="my-colony-primary" aria-label="${escapeHtml(`${colony.name} main stats`)}">
      ${myColonyMetric(formatScoreValue(colony.score), "Score", "ranking power")}
      ${myColonyMetric(formatInteger(food), "Food", formatSignedNumber(colony.foodNet || 0), netFoodLevel)}
      ${myColonyMetric(formatInteger(alive), "Alive", `${formatInteger(active)} ready`)}
      ${myColonyMetric(formatInteger(atStake), "At stake", openBets.length ? `${openBets.length} open bets` : "no open bet", stakeLevel)}
    </div>
    <div class="my-colony-secondary" aria-label="${escapeHtml(`${colony.name} bet record`)}">
      ${myColonyPill(`${wins}W / ${losses}L`, "Record")}
      ${myColonyPill(accuracy, "Accuracy")}
      ${myColonyPill(`${formatInteger(wounded)} wounded`, "Recovery", wounded ? "warning" : "")}
      ${myColonyPill(`${formatInteger(dead)} dead`, "Losses", lossLevel)}
    </div>
    ${renderMyColonyOpenBets(openBets, potentialFood)}
  `;
}

function renderMyColonyEmpty(title, message) {
  if (!els.myColonyPanel) return;
  els.myColonyPanel.innerHTML = `
    <div class="my-colony-empty">
      <span class="section-kicker">${escapeHtml(title)}</span>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function myColonyForView() {
  const colonies = state.game.colonies || [];
  if (!colonies.length) return null;
  if (state.role === "user") return currentUserColony(colonies);
  return colonies.find((colony) => colony.colonyId === state.game.selectedColonyId) || colonies[0] || null;
}

function colonyRank(colony) {
  if (!colony?.colonyId) return null;
  const ranked = [...(state.game.colonies || [])].sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const index = ranked.findIndex((item) => item.colonyId === colony.colonyId);
  return index >= 0 ? index + 1 : null;
}

function myColonyMetric(value, label, caption, level = "") {
  const className = ["my-colony-metric", level].filter(Boolean).map((item) => escapeHtml(item)).join(" ");
  return `
    <span class="${className}">
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(caption)}</small>
    </span>
  `;
}

function myColonyPill(value, label, level = "") {
  const className = ["my-colony-pill", level].filter(Boolean).map((item) => escapeHtml(item)).join(" ");
  return `
    <span class="${className}">
      <b>${escapeHtml(value)}</b>
      <small>${escapeHtml(label)}</small>
    </span>
  `;
}

function renderMyColonyOpenBets(openBets, potentialFood) {
  if (!openBets.length) {
    return `
      <div class="my-colony-open-bets empty-state">
        <strong>No open bet right now</strong>
        <span>Your ants are free for the next live market.</span>
      </div>
    `;
  }

  const items = openBets
    .slice(0, 2)
    .map((record) => {
      const ants = Number(record.ants || 0);
      const possibleReward = Math.round(ants * Number(record.multiplier || 0));
      return `
        <span class="my-colony-open-bet">
          <b>${escapeHtml(record.optionLabel || "Prediction")}</b>
          <small>${formatInteger(ants)} ants · ${possibleReward ? `${formatInteger(possibleReward)} possible food` : "reward pending"}</small>
        </span>
      `;
    })
    .join("");
  const more = openBets.length > 2 ? `<span class="my-colony-more">+${openBets.length - 2} more</span>` : "";

  return `
    <div class="my-colony-open-bets">
      <div class="my-colony-open-head">
        <strong>${openBets.length} open ${openBets.length === 1 ? "bet" : "bets"}</strong>
        <span>${formatInteger(potentialFood)} possible food</span>
      </div>
      <div class="my-colony-open-list">
        ${items}
        ${more}
      </div>
    </div>
  `;
}

async function selectBetTab(tab) {
  const next = ["open", "won", "lost"].includes(tab) ? tab : "open";
  state.game.betTab = next;
  renderBetBoard();
  if (next !== "open" && shouldLoadReplayEvents()) {
    await ensureReplayEventsLoadedForAudit();
    renderBetBoard();
  }
}

function renderBetBoard() {
  if (!els.betBoard || !els.betBoardSummary) return;
  const tab = ["open", "won", "lost"].includes(state.game.betTab) ? state.game.betTab : "open";
  state.game.betTab = tab;
  els.betTabs.forEach((button) => {
    const active = button.dataset.betTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const scopeColony = betBoardColony();
  const records = collectBetRecords(scopeColony?.colonyId || null);
  const visible = records.filter((record) => record.status === tab);
  const counts = {
    open: records.filter((record) => record.status === "open").length,
    won: records.filter((record) => record.status === "won").length,
    lost: records.filter((record) => record.status === "lost").length,
    void: records.filter((record) => record.status === "void").length,
  };

  const scopeLabel =
    state.role === "user"
      ? scopeColony
        ? `${scopeColony.name}'s bets`
        : "Create your colony to see your bets"
      : scopeColony
        ? `${scopeColony.name}'s bets`
        : "All colony bets";
  els.betBoardSummary.textContent = `${scopeLabel} · ${counts.open} open · ${counts.won} won · ${counts.lost} lost`;

  if (!state.game.id) {
    els.betBoard.innerHTML = `<p class="empty">Create a room to track bets.</p>`;
    return;
  }
  if (!scopeColony && state.role === "user") {
    els.betBoard.innerHTML = `<p class="empty">Join the room and deploy a colony first.</p>`;
    return;
  }
  if (!visible.length) {
    const message =
      tab === "open"
        ? "No open bet right now."
        : tab === "won"
          ? "No winning bet yet."
          : "No losing bet yet.";
    els.betBoard.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
    return;
  }
  els.betBoard.replaceChildren(...visible.slice(0, 12).map(renderBetRecordCard));
}

function betBoardColony() {
  const colonies = state.game.colonies || [];
  if (!colonies.length) return null;
  const selected = colonies.find((colony) => colony.colonyId === state.game.selectedColonyId) || null;
  if (state.role === "user") return currentUserColony(colonies) || selected || null;
  return selected;
}

function collectBetRecords(colonyId = null) {
  const marketLabels = new Map();
  const records = new Map();

  (state.game.events || []).forEach((event) => {
    if (event.kind === "opportunity") {
      const opportunity = event.data?.opportunity || {};
      const marketId = opportunity.opportunityId;
      if (marketId) {
        marketLabels.set(marketId, {
          label: event.message || opportunity.label || "Market",
          context: opportunity.context || opportunity.kind || "",
          minute: opportunity.minute,
        });
      }
      return;
    }

    if (event.kind === "prediction") {
      const predictionId = event.data?.predictionId || `prediction-${event.index}`;
      const opportunityId = event.data?.opportunityId || null;
      const option = event.data?.option || {};
      const record = {
        id: predictionId,
        predictionId,
        status: "open",
        colonyId: event.data?.colonyId || "",
        colonyName: eventColonyName(event) || marketResultColonyName(event),
        marketId: opportunityId,
        marketLabel: marketLabels.get(opportunityId)?.label || "Live market",
        marketContext: marketLabels.get(opportunityId)?.context || "",
        minute: marketLabels.get(opportunityId)?.minute,
        optionLabel: option.label || "Prediction",
        optionRisk: option.risk || "",
        multiplier: Number(option.multiplier || 0),
        ants: Number(event.data?.ants || 0),
        infoBought: Boolean(event.data?.infoBought),
        eventIndex: Number(event.index || 0),
        message: event.message || "",
      };
      records.set(predictionId, record);
      return;
    }

    if (!["settlement", "void"].includes(event.kind)) return;
    const predictionId = event.data?.predictionId || `result-${event.index}`;
    const existing = records.get(predictionId) || {
      id: predictionId,
      predictionId,
      status: "open",
      colonyId: event.data?.colonyId || "",
      colonyName: marketResultColonyName(event),
      marketId: event.data?.opportunityId || null,
      marketLabel: marketLabels.get(event.data?.opportunityId)?.label || "Resolved market",
      marketContext: marketLabels.get(event.data?.opportunityId)?.context || "",
      minute: marketLabels.get(event.data?.opportunityId)?.minute,
      optionLabel: event.data?.option?.label || "Prediction",
      optionRisk: event.data?.option?.risk || "",
      multiplier: Number(event.data?.option?.multiplier || 0),
      ants: Number(event.data?.ants || 0),
      infoBought: false,
      eventIndex: Number(event.index || 0),
      message: event.message || "",
    };
    const win = Boolean(event.kind === "settlement" && event.data?.win);
    records.set(predictionId, {
      ...existing,
      status: event.kind === "void" ? "void" : win ? "won" : "lost",
      colonyId: event.data?.colonyId || existing.colonyId,
      colonyName: marketResultColonyName(event) || existing.colonyName,
      optionLabel: event.data?.option?.label || existing.optionLabel,
      optionRisk: event.data?.option?.risk || existing.optionRisk,
      multiplier: Number(event.data?.option?.multiplier || existing.multiplier || 0),
      rewardFood: Number(event.data?.food || 0),
      rewardLarvae: Number(event.data?.larvae || 0),
      dead: Number(event.data?.dead || 0),
      wounded: Number(event.data?.wounded || 0),
      voidReason: event.data?.reason || "",
      resultIndex: Number(event.index || existing.eventIndex || 0),
      resultMessage: event.message || "",
    });
  });

  return Array.from(records.values())
    .filter((record) => !colonyId || record.colonyId === colonyId)
    .sort((left, right) => Number(right.resultIndex ?? right.eventIndex ?? 0) - Number(left.resultIndex ?? left.eventIndex ?? 0));
}

function renderBetRecordCard(record) {
  const item = document.createElement("article");
  item.className = `bet-card ${record.status}`;
  const headline =
    record.status === "open"
      ? `${formatInteger(record.ants)} ants at stake`
      : record.status === "won"
        ? `+${formatInteger(record.rewardFood || 0)} food · +${formatInteger(record.rewardLarvae || 0)} larvae`
        : `${formatInteger(record.dead || 0)} dead · ${formatInteger(record.wounded || 0)} wounded`;
  const potential =
    record.status === "open" && record.multiplier && record.ants
      ? `<span>Possible reward ${formatInteger(Math.round(record.ants * record.multiplier))} food</span>`
      : "";
  const meta = [
    record.colonyName,
    record.marketContext ? contextLabel(record.marketContext) : "",
    record.minute != null ? `minute ${record.minute}` : "",
    record.optionRisk ? `risk ${record.optionRisk}` : "",
    record.infoBought ? "info bought" : "",
  ].filter(Boolean);
  item.innerHTML = `
    <div class="bet-card-status">${escapeHtml(betStatusLabel(record.status))}</div>
    <div class="bet-card-body">
      <div class="bet-card-topline">
        <strong>${escapeHtml(record.optionLabel || "Prediction")}</strong>
        <b>${escapeHtml(headline)}</b>
      </div>
      <p>${escapeHtml(record.marketLabel || "Live market")}</p>
      <div class="bet-card-meta">
        ${meta.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}
        ${potential}
      </div>
    </div>
  `;
  return item;
}

function betStatusLabel(status) {
  return {
    open: "Open",
    won: "Won",
    lost: "Lost",
    void: "Void",
  }[status] || "Bet";
}

function contextLabel(value) {
  return String(value || "").replaceAll("_", " ");
}

function colonyResultEvents(colony) {
  const events = (state.game.events || []).filter((event) => {
    if (!["settlement", "void"].includes(event.kind)) return false;
    return colonyOwnsResultEvent(colony, event);
  });
  return {
    wins: events.filter((event) => event.kind === "settlement" && event.data?.win),
    losses: events.filter((event) => event.kind === "settlement" && !event.data?.win),
    voids: events.filter((event) => event.kind === "void"),
  };
}

function colonyOwnsResultEvent(colony, event) {
  const eventColonyId = event.data?.colonyId;
  if (eventColonyId && colony.colonyId) return eventColonyId === colony.colonyId;
  const eventName = marketResultColonyName(event) || eventColonyName(event);
  return Boolean(eventName && eventName === colony.name);
}

function colonyAuditMetric(value, label, caption, level = "") {
  const className = ["colony-audit-metric", level].filter(Boolean).map((item) => escapeHtml(item)).join(" ");
  return `
    <span class="${className}">
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(caption)}</small>
    </span>
  `;
}

function renderColonyResultSection(title, events, type) {
  const emptyText =
    type === "win"
      ? "No winning bet yet."
      : type === "loss"
        ? "No losing bet yet."
        : "No voided bet.";
  return `
    <section class="colony-result-section ${escapeHtml(type)}">
      <div class="colony-result-section-head">
        <span>${escapeHtml(title)}</span>
        <b>${events.length}</b>
      </div>
      ${
        events.length
          ? `<ul>${events.map((event) => renderColonyResultItem(event, type)).join("")}</ul>`
          : `<p class="empty">${escapeHtml(emptyText)}</p>`
      }
    </section>
  `;
}

function renderColonyResultItem(event, type) {
  const option = event.data?.option?.label || "Prediction";
  const detail = marketResultDetail(event);
  const reason = resultReasonLabel(event.data?.reason);
  const index = Number.isInteger(event.index) ? `event #${event.index + 1}` : null;
  const meta = [reason, index].filter(Boolean).join(" · ");
  return `
    <li class="colony-result-item ${escapeHtml(type)}">
      <span class="result-dot" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(option)}</strong>
        <p>${escapeHtml(detail)}</p>
        ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      </div>
    </li>
  `;
}

function resultReasonLabel(reason) {
  return (
    {
      resolved: "match event resolved",
      expired: "market expired",
      full_time: "closed at full time",
      expired_no_foul: "no matching foul",
    }[reason] || reason || ""
  );
}

function initAnonymousIdentity() {
  let anonymousId = "";
  try {
    anonymousId = localStorage.getItem(ANON_ID_STORAGE_KEY) || "";
    if (!anonymousId) {
      anonymousId = makeAnonymousId();
      localStorage.setItem(ANON_ID_STORAGE_KEY, anonymousId);
    }
    state.identity.playerName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
  } catch {
    anonymousId = makeAnonymousId();
  }
  state.identity.anonymousId = anonymousId;
  if (state.identity.playerName && !els.playerName.value) {
    els.playerName.value = state.identity.playerName;
  }
}

function makeAnonymousId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `anon_${crypto.randomUUID()}`;
  }
  return `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function currentPlayerName() {
  return els.playerName.value.trim() || state.identity.playerName || "";
}

function defaultColonyName() {
  return currentPlayer()?.name || currentPlayerName() || "Host";
}

function cleanRoomCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function fixtureFromGame(game) {
  return {
    fixtureId: game?.fixtureId,
    participant1: game?.participant1,
    participant2: game?.participant2,
    competition: game?.competition,
    startTime: game?.startTime,
    startTimeIso: game?.startTimeIso,
  };
}

function setRoomUrl(roomCode) {
  const cleanCode = cleanRoomCode(roomCode);
  if (!cleanCode || !history.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.set("room", cleanCode);
  url.searchParams.delete("code");
  url.searchParams.delete("join");
  url.searchParams.delete("view");
  history.replaceState({}, "", url);
}

function setJoinUrl(roomCode = "") {
  if (!history.replaceState) return;
  const cleanCode = cleanRoomCode(roomCode);
  const url = new URL(window.location.href);
  url.searchParams.set("join", "1");
  if (cleanCode) url.searchParams.set("room", cleanCode);
  else url.searchParams.delete("room");
  url.searchParams.delete("code");
  url.searchParams.delete("view");
  history.replaceState({}, "", url);
}

function setHomeUrl() {
  if (!history.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  url.searchParams.delete("code");
  url.searchParams.delete("join");
  url.searchParams.delete("view");
  history.replaceState({}, "", url);
}

function persistPlayerName(name) {
  const cleanName = String(name || "").trim().slice(0, 32);
  state.identity.playerName = cleanName;
  if (!cleanName) return;
  try {
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, cleanName);
  } catch {
    // Browsers can disable storage; anonymous play still works for the session.
  }
}

function updateStrategyDraft(colonyId) {
  if (!colonyId) return;
  state.game.strategyDrafts[colonyId] = readStrategyControls(colonyId);
}

function readStrategyControls(colonyId) {
  const escapedId = cssEscape(colonyId);
  return {
    style: document.querySelector(`[data-strategy-style="${escapedId}"]`)?.value,
    favoriteContext: document.querySelector(`[data-strategy-favorite="${escapedId}"]`)?.value,
    infoNeed: document.querySelector(`[data-strategy-info="${escapedId}"]`)?.value,
  };
}

function currentPlayer(players = state.game.players) {
  return (players || []).find((player) => player.anonymousId && player.anonymousId === state.identity.anonymousId) || null;
}

function currentUserColony(colonies = state.game.colonies) {
  const me = currentPlayer();
  const anonymousId = me?.anonymousId || state.identity.anonymousId;
  const playerId = me?.playerId || "";
  return (
    (colonies || []).find((colony) => colony.playerId && playerId && colony.playerId === playerId) ||
    (colonies || []).find((colony) => colony.playerAnonymousId && anonymousId && colony.playerAnonymousId === anonymousId) ||
    null
  );
}

function playerIsReady(player) {
  if (!player) return false;
  if (player.ready || player.colonyId) return true;
  return (state.game.colonies || []).some((colony) => {
    if (colony.playerId && colony.playerId === player.playerId) return true;
    return colony.playerAnonymousId && player.anonymousId && colony.playerAnonymousId === player.anonymousId;
  });
}

function currentPlayerHasColony() {
  return playerIsReady(currentPlayer());
}

function allPlayersReady(players = state.game.players) {
  return Boolean(players?.length) && players.every(playerIsReady);
}

function isRoomLockedStatus(status) {
  return ["waiting_kickoff", "running_replay", "running_live", "finished"].includes(status);
}

function userRoomStatusText(game = null) {
  const status = game?.status || state.game.status || "created";
  const roomCode = game?.roomCode || state.game.roomCode || "";
  if (status === "waiting_kickoff") return "Room locked. Waiting for kickoff.";
  if (status === "running_live") return "Live match running. Colony decisions are active.";
  if (status === "finished") return "Match finished. Final colony scores are available.";
  if (!roomCode) return "Create a private room for this match.";

  const players = game?.players || state.game.players || [];
  const me = currentPlayer(players);
  if (!me) return `Room ${roomCode} ready. Join with your name.`;
  if (!playerIsReady(me)) return `Room ${roomCode} ready. Create your colony.`;
  if (me.isHost && allPlayersReady(players)) {
    return state.selectedStatus === "current" ? "Everyone is ready. Connect to the live match now." : "Everyone is ready. Start game to lock the room.";
  }
  if (me.isHost) return "You are ready. Waiting for every player to create a colony.";
  return "You are ready. Waiting for the host to start.";
}

function renderRoomSetup(game = null) {
  const players = game?.players || state.game.players || [];
  const status = game?.status || state.game.status || "created";
  const hasRoom = Boolean(state.game.id);
  const hasPlayers = players.length > 0;
  const hasColonies = state.game.colonyCount > 0;
  const locked = isRoomLockedStatus(status);
  const liveReady = hasRoom && hasColonies && !locked;
  const me = currentPlayer(players);
  const meReady = playerIsReady(me);
  const readyCount = players.filter(playerIsReady).length;
  const roomCode = game?.roomCode || state.game.roomCode || "";
  els.roomCode.textContent = roomCode || "No code yet";
  if (els.copyRoomCode) {
    els.copyRoomCode.disabled = cleanRoomCode(roomCode).length !== 6;
    if (!roomCode) els.copyRoomCode.textContent = "Copy";
  }
  if (roomCode && cleanRoomCode(els.roomCodeInput.value) !== roomCode) {
    els.roomCodeInput.value = roomCode;
  }
  if (state.role === "user" && me && !meReady && !els.colonyName.value.trim()) {
    els.colonyName.value = defaultColonyName();
  }
  renderRoomCountdown(game);
  els.playerCount.textContent = `${players.length} joined · ${readyCount} ready`;
  const hasJoinCode = cleanRoomCode(els.roomCodeInput.value || roomCode).length === 6;
  els.joinRoom.textContent = state.role === "admin" ? "Add player" : me ? "Joined" : "Join";
  els.joinRoom.disabled = state.role === "user" ? Boolean(me) || !hasJoinCode || locked : !hasRoom || locked;
  els.playerName.disabled = state.role === "admin" ? !hasRoom || locked : locked || Boolean(me);
  els.playerList.replaceChildren(
    ...(hasPlayers
      ? players.map((player) => {
          const item = document.createElement("span");
          const ready = playerIsReady(player);
          item.className = `player-pill ${ready ? "ready" : "pending"}`;
          const tags = [
            player.isHost ? `<span class="player-tag">Host</span>` : "",
            ready ? `<span class="player-tag">Ready</span>` : `<span class="player-tag">Needs colony</span>`,
          ].join("");
          item.innerHTML = `<span>${escapeHtml(player.name || "Player")}</span><span class="player-tags">${tags}</span>`;
          return item;
        })
      : [
          emptyInline(
            hasRoom
              ? "No player has joined yet."
              : state.role === "admin"
                ? "Create a room, then players can join."
                : "Create a private room, or enter a 6-digit code to join.",
          ),
        ]),
  );
  const steps =
    state.role === "admin"
      ? [
          ["Room", hasRoom],
          ["Players", hasPlayers],
          ["Colonies", hasColonies],
          ["Replay", liveReady || ["running_replay", "running_live", "finished"].includes(status)],
        ]
      : [
          ["Match", Boolean(state.selected?.fixtureId)],
          ["Room", hasRoom],
          ["Colony", meReady],
          ["Kickoff", ["waiting_kickoff", "running_live", "finished"].includes(status)],
        ];
  els.setupSteps.replaceChildren(
    ...steps.map(([label, done], index) => {
      const item = document.createElement("span");
      item.className = `setup-step ${done ? "done" : "pending"}`;
      item.textContent = `${index + 1} ${label}`;
      return item;
    }),
  );
}

function renderRoomCountdown(game = null) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const startValue = matchStartValue(game);
  if (!startValue) {
    els.matchCountdown.textContent = state.game.id ? "Time unavailable" : "Create a room";
    return;
  }
  const tick = () => {
    els.matchCountdown.textContent = formatCountdown(startValue);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function matchStartValue(game = null) {
  return game?.startTimeIso || game?.startTime || state.selected?.startTimeIso || state.selected?.startTime || null;
}

function formatCountdown(value) {
  const start = new Date(normalizeDateInput(value));
  if (Number.isNaN(start.getTime())) return "Time unavailable";
  const diffMs = start.getTime() - Date.now();
  if (diffMs <= 0) return "Match started";
  const totalSeconds = Math.ceil(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function updateGameActions() {
  const isAdmin = state.role === "admin";
  const hasRoom = Boolean(state.game.id);
  const status = state.game.status || "created";
  const running = ["running_replay", "running_live"].includes(status);
  const locked = isRoomLockedStatus(status);
  const hasColony = state.game.colonyCount > 0;
  const hasJoinCode = cleanRoomCode(els.roomCodeInput.value || state.game.roomCode || "").length === 6;
  const me = currentPlayer();
  const meReady = playerIsReady(me);
  const roomReady = allPlayersReady();
  const selectedMatchIsCurrent = state.role === "user" && state.selectedStatus === "current";
  els.createGame.textContent = isAdmin ? "Create replay room" : selectedMatchIsCurrent ? "Create live room" : "Create room";
  els.createGame.disabled =
    state.role === "user"
      ? state.userView !== "home" || !state.selected?.fixtureId || hasRoom
      : !state.selected?.fixtureId || (hasRoom && !["finished", "error", "stopped"].includes(status));
  if (els.openJoinRoom) {
    els.openJoinRoom.disabled = state.role !== "user" || state.userView !== "home";
  }
  const firstUpcoming = state.fixtures[0] || null;
  const firstSelected = firstUpcoming?.fixtureId && state.selected?.fixtureId === firstUpcoming.fixtureId;
  els.participateMatch.disabled = !firstUpcoming?.fixtureId || firstSelected || (hasRoom && !["finished", "error", "stopped"].includes(status));
  els.participateMatch.textContent = firstSelected ? "Match selected" : "Select match";
  els.addColony.disabled = state.role === "user" ? !hasRoom || !me || meReady || locked : !hasRoom || locked;
  els.addColony.textContent = state.role === "user" && meReady ? "Colony ready" : "Add colony";
  els.joinRoom.textContent = state.role === "admin" ? "Add player" : me ? "Joined" : "Join";
  els.joinRoom.disabled = state.role === "user" ? Boolean(me) || !hasJoinCode || locked : !hasRoom || locked;
  els.startGameLive.textContent = !hasRoom || me?.isHost ? (selectedMatchIsCurrent ? "Connect live" : "Start game") : "Waiting for host";
  els.startGameLive.disabled = isAdmin || !hasRoom || locked || !roomReady || !me?.isHost;
  if (els.finishGameLive) {
    const canFinishLive = state.role === "user" && hasRoom && me?.isHost && ["waiting_kickoff", "running_live"].includes(status);
    els.finishGameLive.hidden = !canFinishLive;
    els.finishGameLive.disabled = !canFinishLive;
  }
  if (els.exitGame) {
    const showExit = state.role === "user" && hasRoom && status === "finished";
    els.exitGame.hidden = !showExit;
    els.exitGame.disabled = !showExit;
  }
  els.startGameReplay.disabled = !isAdmin || !hasRoom || running || status === "finished" || !hasColony;
  if (els.copyRoomCode) els.copyRoomCode.disabled = cleanRoomCode(state.game.roomCode || "").length !== 6;
}

function appendGameEvent(event) {
  if (!event || state.game.events.some((item) => item.index === event.index)) return;
  state.game.events.push(event);
  state.game.logCount = Math.max(state.game.logCount || 0, state.game.events.length, Number(event.index || 0) + 1);
  if (event.kind === "game_finished") {
    state.game.status = "finished";
    document.body.dataset.gameStatus = "finished";
    state.game.agentUsage = event.data?.agentUsage || state.game.agentUsage;
    if (els.leaderboardTitle) els.leaderboardTitle.textContent = "Final results";
    closeGameStream();
    updateGameActions();
  } else if (event.kind === "game_error") {
    state.game.status = "error";
    updateGameActions();
  }

  renderGameJournal();
  els.gameFeed.scrollTop = els.gameFeed.scrollHeight;
  renderSimulationSummary();
  renderSelectedColonyDetail();
  renderMyColonyPanel();
  renderBetBoard();
}

function renderGameJournal() {
  const events = state.game.events || [];
  if (!events.length) {
    const message =
      state.game.status === "running_live"
        ? "Live room connected. Waiting for the first TXLine update before ants can vote."
        : "Automatic decisions will appear here.";
    els.gameFeed.innerHTML = `<li class="empty">${message}</li>`;
    return;
  }
  els.gameFeed.replaceChildren(...buildJournalNodes(events));
}

function buildJournalNodes(events) {
  const groups = [];
  const markets = new Map();
  let lastMarket = null;

  events.forEach((event) => {
    if (event.kind === "opportunity") {
      const opportunity = event.data?.opportunity || {};
      const marketId = opportunity.opportunityId;
      const group = { type: "market", event, opportunity, events: [] };
      groups.push(group);
      if (marketId) markets.set(marketId, group);
      lastMarket = group;
      return;
    }

    const marketId = eventMarketId(event);
    const market = marketId ? markets.get(marketId) : null;
    if (market && isMarketEvent(event)) {
      market.events.push(event);
      return;
    }
    if (event.kind === "game_error" && lastMarket) {
      lastMarket.events.push(event);
      return;
    }

    groups.push({ type: "event", event });
  });

  return groups.map((group) => (group.type === "market" ? renderMarketGroup(group) : renderPlainJournalEvent(group.event)));
}

function renderPlainJournalEvent(event) {
  const item = document.createElement("li");
  item.className = `game-log-${event.kind || "event"}`;
  const details = formatEventDetails(event);
  item.innerHTML = `
    <div class="event-main">
      <span class="event-label ${escapeHtml(event.kind || "update")}">${escapeHtml(gameKindLabel(event.kind))}</span>
      <span class="event-desc">${escapeHtml(event.message || "Game update")}</span>
    </div>
    ${details ? `<div class="event-details">${details}</div>` : ""}
  `;
  return item;
}

function renderMarketGroup(group) {
  const item = document.createElement("li");
  const lanes = marketColonyLanes(group.events);
  const endings = group.events.filter((event) => ["settlement", "void", "markets_closed"].includes(event.kind));
  const errors = group.events.filter((event) => event.kind === "game_error");
  const status = marketGroupStatus(group.events);
  item.className = `journal-market ${status.className}`;
  item.innerHTML = `
    <div class="market-head">
      <span class="event-label opportunity">Market</span>
      <div class="market-title">
        <strong>${escapeHtml(group.event.message || group.opportunity.label || "Market")}</strong>
        <p>${escapeHtml(status.summary)}</p>
      </div>
      <span class="market-state ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
    </div>
    <div class="market-lanes">
      ${
        lanes.length
          ? lanes.map(renderMarketLane).join("")
          : `<div class="market-lane waiting"><span class="colony-chip">-</span><div><strong>Waiting for colonies</strong></div></div>`
      }
    </div>
    ${
      endings.length
        ? `<div class="market-end"><span>Market finished</span><div class="market-result-list">${endings.map(renderMarketResult).join("")}</div></div>`
        : ""
    }
    ${errors.map((event) => `<div class="market-error">${escapeHtml(event.message || "")}${formatEventDetails(event) ? `<div>${formatEventDetails(event)}</div>` : ""}</div>`).join("")}
  `;
  return item;
}

function marketGroupStatus(events) {
  const hasClosed = events.some((event) => event.kind === "markets_closed");
  const hasVoid = events.some((event) => event.kind === "void");
  const hasSettlement = events.some((event) => event.kind === "settlement");
  const hasPrediction = events.some((event) => event.kind === "prediction");
  const hasVote = events.some((event) => ["ant_agent_vote", "vote"].includes(event.kind));
  if (hasClosed) {
    return { label: "Finished", className: "finished", summary: "Market closed; no more ants are at risk here." };
  }
  if (hasSettlement || hasVoid) {
    return { label: "Settled", className: "settled", summary: "Result received; colony gains or losses are applied." };
  }
  if (hasPrediction) {
    return { label: "Live", className: "live", summary: "Ants are committed; waiting for the match to resolve it." };
  }
  if (hasVote) {
    return { label: "Voting", className: "voting", summary: "Colonies are deciding whether to commit ants." };
  }
  return { label: "Open", className: "open", summary: "New market opened from the live match feed." };
}

function renderMarketResult(event) {
  const label = marketResultLabel(event);
  const detail = marketResultDetail(event);
  const option = event.data?.option?.label;
  const colony = marketResultColonyName(event);
  return `
    <div class="market-result ${escapeHtml(label.className)}">
      <span class="market-result-label">${escapeHtml(label.text)}</span>
      <div>
        <strong>${escapeHtml(colony)}</strong>
        <p>${escapeHtml(detail)}${option ? ` · ${escapeHtml(option)}` : ""}</p>
      </div>
    </div>
  `;
}

function marketResultLabel(event) {
  if (event.kind === "settlement") {
    return event.data?.win ? { text: "Won", className: "win" } : { text: "Lost", className: "loss" };
  }
  if (event.kind === "void") return { text: "Voided", className: "void" };
  return { text: "Closed", className: "closed" };
}

function marketResultDetail(event) {
  if (event.kind === "settlement" && event.data?.win) {
    return [`+${event.data.food || 0} food`, `+${event.data.larvae || 0} larvae`].join(" · ");
  }
  if (event.kind === "settlement") {
    return [`${event.data?.dead || 0} dead`, `${event.data?.wounded || 0} wounded`].join(" · ");
  }
  if (event.kind === "void") {
    const ants = event.data?.ants == null ? "ants released" : `${event.data.ants} ants released`;
    return `${ants} · ${event.data?.reason || "void"}`;
  }
  return event.message || "Market closed";
}

function marketResultColonyName(event) {
  const colonyId = event.data?.colonyId;
  if (colonyId && state.game.coloniesById[colonyId]) return state.game.coloniesById[colonyId];
  const message = event.message || "";
  const resultMatch = message.match(/^Result\s+(.+?):/);
  if (resultMatch) return resultMatch[1].trim();
  const voidMatch = message.match(/^(.+?): prediction voided/);
  if (voidMatch) return voidMatch[1].trim();
  if (event.kind === "markets_closed") return "All open predictions";
  return "Colony";
}

function marketColonyLanes(events) {
  const lanes = new Map();
  events.forEach((event) => {
    if (!["ant_agent_start", "ant_agent_vote", "vote", "prediction", "observe"].includes(event.kind)) return;
    const name = eventColonyName(event);
    if (!name) return;
    const lane = lanes.get(name) || { name, status: "waiting", counts: null, vote: null, bet: null, availability: null };
    if (event.kind === "ant_agent_start") {
      lane.status = "calling";
      lane.call = event.message;
      lane.availability = laneAvailabilityFromData(event.data) || lane.availability;
    } else if (event.kind === "ant_agent_vote") {
      lane.status = "voted";
      lane.ai = event.message;
      lane.counts = event.data?.vote?.voteCounts || null;
      lane.availability = laneAvailabilityFromData(event.data?.vote) || lane.availability;
    } else if (event.kind === "vote") {
      lane.status = "voted";
      lane.vote = event.message;
      lane.counts = event.data?.vote?.voteCounts || lane.counts;
      lane.availability = laneAvailabilityFromData(event.data?.vote) || lane.availability;
    } else if (event.kind === "prediction") {
      lane.status = "bet";
      lane.bet = event.message;
    } else if (event.kind === "observe") {
      lane.status = "observe";
      lane.bet = event.message;
    }
    lanes.set(name, lane);
  });
  return Array.from(lanes.values());
}

function renderMarketLane(lane) {
  const title = lane.status === "bet" ? `Colony ${lane.name} bets` : lane.status === "observe" ? `Colony ${lane.name} observes` : `Colony ${lane.name}`;
  const main = lane.bet || lane.vote || (lane.ai ? "Vote complete." : null) || (lane.call ? "DeepSeek is voting." : null) || "Waiting";
  const availability = lane.availability ? `<p class="lane-meta">${formatLaneAvailability(lane.availability)}</p>` : "";
  const counts = lane.counts ? `<p class="lane-counts">votes: ${formatVoteCounts(lane.counts)}</p>` : "";
  return `
    <div class="market-lane ${escapeHtml(lane.status)}">
      <span class="colony-chip">${escapeHtml(lane.name)}</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        ${availability}
        <p>${escapeHtml(stripColonyPrefix(main, lane.name))}</p>
        ${counts}
      </div>
    </div>
  `;
}

function isMarketEvent(event) {
  return ["ant_agent_start", "ant_agent_vote", "vote", "prediction", "settlement", "void", "markets_closed", "observe"].includes(event.kind);
}

function eventMarketId(event) {
  return (
    event.data?.opportunityId ||
    event.data?.opportunity?.opportunityId ||
    event.data?.vote?.market?.marketId ||
    event.data?.prediction?.opportunityId ||
    null
  );
}

function eventColonyName(event) {
  const colonyId = event.data?.colonyId;
  if (colonyId && state.game.coloniesById[colonyId]) {
    return state.game.coloniesById[colonyId];
  }
  const message = event.message || "";
  if (event.kind === "prediction") {
    const match = message.match(/^(.+?) (?:commits|stakes) /);
    return match ? match[1].trim() : "";
  }
  if (event.kind === "observe") {
    const match = message.match(/^(.+?) watches /);
    return match ? match[1].trim() : "";
  }
  if (event.kind === "ant_agent_vote") {
    const match = message.match(/\bfrom\s+(.+?)(?:\s+\(|:)/i);
    if (match) return match[1].trim();
  }
  const colon = message.match(/^([^:]+):/);
  return colon ? colon[1].trim() : "";
}

function stripColonyPrefix(message, colonyName) {
  return String(message || "").replace(new RegExp(`^${escapeRegExp(colonyName)}:\\s*`), "");
}

function formatVoteCounts(counts) {
  const preferredOrder = ["yes", "no", "option_a", "option_b", "option_c", "option_d", "abstain"];
  const keys = [
    ...preferredOrder.filter((key) => counts[key] != null),
    ...Object.keys(counts).filter((key) => !preferredOrder.includes(key)),
  ];
  return keys
    .filter((key) => counts[key] != null)
    .map((key) => `${key} ${counts[key]}`)
    .join(" · ");
}

function laneAvailabilityFromData(data) {
  if (!data || data.activeCount == null) return null;
  return {
    active: Number(data.activeCount) || 0,
    alive: data.aliveCount == null ? null : Number(data.aliveCount) || 0,
    engaged: data.engagedCount == null ? null : Number(data.engagedCount) || 0,
    wounded: data.woundedCount == null ? null : Number(data.woundedCount) || 0,
  };
}

function formatLaneAvailability(availability) {
  const parts = [];
  if (availability.alive != null) {
    parts.push(`can vote ${availability.active}/${availability.alive}`);
  } else {
    parts.push(`can vote ${availability.active}`);
  }
  if (availability.engaged) parts.push(`at risk ${availability.engaged}`);
  if (availability.wounded) parts.push(`wounded ${availability.wounded}`);
  return parts.join(" · ");
}

function formatEventDetails(event) {
  if (event.kind !== "game_error" || !Array.isArray(event.data?.details) || !event.data.details.length) {
    return "";
  }
  return event.data.details.slice(0, 3).map(formatErrorDetail).filter(Boolean).join("<br>");
}

function formatErrorDetail(detail) {
  const nested = Array.isArray(detail.details) && detail.details.length ? detail.details[0] : {};
  const pickDetail = (key) => detail[key] ?? nested[key];
  const parts = [
    pickDetail("antId") ? `ant ${pickDetail("antId")}` : null,
    pickDetail("category") || pickDetail("type") || null,
    pickDetail("parsedType") ? `json ${pickDetail("parsedType")}` : null,
    pickDetail("rejectionReason") ? `reason ${pickDetail("rejectionReason")}` : null,
    pickDetail("finishReason") ? `finish ${pickDetail("finishReason")}` : null,
  ].filter(Boolean);

  const expected = pickDetail("expectedAntIds");
  const candidates = pickDetail("candidateAntIds");
  if (Array.isArray(expected) && expected.length) parts.push(`expected ${expected.join(", ")}`);
  if (Array.isArray(candidates) && candidates.length) parts.push(`got ${candidates.join(", ")}`);

  const snippet = pickDetail("parsedSnippet") || pickDetail("contentSnippet") || pickDetail("responseBody");
  if (snippet) parts.push(`response ${snippet}`);
  return escapeHtml(parts.join(" · "));
}

function renderSimulationSummary(game = null) {
  const status = game?.status || state.game.status || "created";
  const events = state.game.events || [];
  const counts = countGameEvents(events);
  const statusLabels = {
    created: "Room ready",
    waiting_kickoff: "Waiting for kickoff",
    running_replay: "Simulation running",
    running_live: "Live running",
    finished: "Simulation finished",
    error: "Error",
    stopped: "Stopped",
  };
  els.simulationStatus.className = `sim-status ${status}`;
  els.simulationStatus.textContent = statusLabels[status] || status;
  const eventIndex = game?.eventIndex;
  const waitingForFirstLiveUpdate = status === "running_live" && Number(eventIndex || 0) === 0;
  els.simulationStats.textContent = waitingForFirstLiveUpdate
    ? "Connected to live match · waiting for the first update"
    : [
        eventIndex != null ? `${eventIndex} match updates` : null,
        `${counts.opportunity || 0} markets opened`,
        `${counts.ant_agent_vote || 0} AI ant votes`,
        counts.agent_decision ? `${counts.agent_decision} agent decisions` : null,
        `${counts.prediction || 0} bets placed`,
        `${counts.settlement || 0} results settled`,
        counts.void ? `${counts.void} voided` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  renderAgentCost(status, game?.agentUsage || state.game.agentUsage);

  const markets = game?.activeOpportunities || state.game.activeOpportunities || [];
  if (!markets.length) {
    const message = waitingForFirstLiveUpdate
      ? "Waiting for live match updates. Bets open on penalties, danger, corners, free kicks or shots."
      : "No bet open right now.";
    els.activeMarkets.innerHTML = `<span class="empty">${message}</span>`;
    return;
  }
  els.activeMarkets.replaceChildren(
    ...markets.slice(0, 3).map(renderActiveMarketCard),
  );
}

function renderActiveMarketCard(market) {
  const item = document.createElement("article");
  item.className = "market-pill";
  const options = Array.isArray(market.options) ? market.options : [];
  item.innerHTML = `
    <div>
      <span>${escapeHtml(contextLabel(market.context || market.kind || "market"))}</span>
      <strong>${escapeHtml(market.label || market.question || "Live market")}</strong>
    </div>
    ${
      options.length
        ? `<div class="market-pill-options">${options.slice(0, 4).map((option) => `<b>${escapeHtml(option.label || option.value || "Option")}</b>`).join("")}</div>`
        : ""
    }
  `;
  return item;
}

function renderAgentCost(status, usage) {
  const apiCalls = Number(usage?.apiCalls || 0);
  const budgetedCalls = Number(usage?.budgetedCalls || 0);
  if (status !== "finished" || !usage || (apiCalls <= 0 && budgetedCalls <= 0)) {
    els.agentCost.hidden = true;
    els.agentCost.textContent = "";
    return;
  }

  if (apiCalls <= 0) {
    els.agentCost.textContent = `AI cost unavailable · ${formatInteger(budgetedCalls)} calls without usage`;
    els.agentCost.hidden = false;
    return;
  }

  const parts = [
    `AI cost: ${formatUsd(Number(usage.costUsd || 0))}`,
    `${formatInteger(apiCalls)} calls`,
    `${formatInteger(usage.inputTokens || 0)} input`,
    `${formatInteger(usage.outputTokens || 0)} output tokens`,
  ];
  if (!usage.costComplete) {
    parts.push(`${formatInteger(usage.missingUsageResponses || 0)} without usage`);
  }
  els.agentCost.textContent = parts.join(" · ");
  els.agentCost.hidden = false;
}

function countGameEvents(events) {
  return events.reduce((acc, event) => {
    acc[event.kind] = (acc[event.kind] || 0) + 1;
    return acc;
  }, {});
}

function renderColonyEconomy(colony, scoreTitle) {
  const food = Number(colony.food || 0);
  const brood = Number(colony.larvae || 0);
  const alive = Number(colony.antsAlive || 0);
  const active = Number(colony.antsActive ?? colony.antsAlive ?? 0);
  const atRisk = Number(colony.antsEngaged || 0);
  const wounded = Number(colony.antsWounded || 0);
  const dead = Number(colony.antsDead || 0);
  const born = Number(colony.antsBorn || 0);
  const insight = colonyEconomyInsight(colony);
  const riskLevel = metricRiskLevel(atRisk, Math.max(active, alive));
  const deathLevel = metricDeathLevel(dead, colony.size || alive || 1);

  return `
    <div class="colony-economy-note ${escapeHtml(insight.level)}">${escapeHtml(insight.text)}</div>
    <div class="simple-economy" aria-label="${escapeHtml(`${colony.name} economy`)}}">
      ${economyCoreMetric(food, "Food", "fuel", "Food is the main resource. Wins add food; upkeep and hatching spend it.", "", "food")}
      ${economyCoreMetric(alive, "Alive", `${active} ready`, "Living ants are your voting power. Wounded ants come back; dead ants do not.", "", "alive")}
      ${economyCoreMetric(atRisk, "At stake", atRisk ? "open bets" : "safe", "At stake ants are alive, but committed to unresolved bets.", riskLevel, "stake")}
    </div>
    ${renderEconomyExtras({ brood, born, wounded, dead, deathLevel, score: colony.score, scoreTitle })}
  `;
}

function economyCoreMetric(value, label, caption, hint, level = "", kind = "") {
  const className = ["economy-core", kind, level].filter(Boolean).map((item) => escapeHtml(item)).join(" ");
  return `
    <span class="${className}" title="${escapeHtml(hint)}">
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(caption)}</small>
    </span>
  `;
}

function renderEconomyExtras({ brood, born, wounded, dead, deathLevel, score, scoreTitle }) {
  const extras = [];
  if (brood > 0) extras.push(economyExtra(`${brood} soon`, "Future ants waiting to hatch."));
  if (born > 0) extras.push(economyExtra(`${born} born`, "New ants hatched during this match."));
  if (wounded > 0) extras.push(economyExtra(`${wounded} wounded`, "Temporary losses; they cannot vote yet.", "warning"));
  if (dead > 0) extras.push(economyExtra(`${dead} dead`, "Permanent ant losses.", deathLevel));
  extras.push(economyExtra(`${score} score`, scoreTitle));
  return `<div class="economy-extras">${extras.join("")}</div>`;
}

function economyExtra(text, hint, level = "") {
  const levelClass = level ? ` ${escapeHtml(level)}` : "";
  return `<span class="economy-extra${levelClass}" title="${escapeHtml(hint)}">${escapeHtml(text)}</span>`;
}

function colonyEconomyInsight(colony) {
  const food = Number(colony.food || 0);
  const alive = Number(colony.antsAlive || 0);
  const active = Number(colony.antsActive ?? colony.antsAlive ?? 0);
  const atRisk = Number(colony.antsEngaged || 0);
  const dead = Number(colony.antsDead || 0);
  const brood = Number(colony.larvae || 0);
  const baseSize = Number(colony.size || alive || 1);
  const foodPerAlive = alive > 0 ? food / alive : 0;
  const riskShare = active > 0 ? atRisk / active : 0;
  const deathShare = baseSize > 0 ? dead / baseSize : 0;

  if (alive <= 0) {
    return { level: "danger", text: "No alive ants left." };
  }
  if (riskShare >= 0.65) {
    return { level: "danger", text: "Too exposed: most ants are at stake." };
  }
  if (deathShare >= 0.5 && foodPerAlive >= 8) {
    return { level: "danger", text: "Rich but fragile: too many dead ants." };
  }
  if (foodPerAlive < 0.5) {
    return { level: "danger", text: "Low food: play safer." };
  }
  if (riskShare >= 0.35) {
    return { level: "warning", text: "High stake: many ants are in open bets." };
  }
  if (deathShare >= 0.25) {
    return { level: "warning", text: "Damaged: fewer ants for future votes." };
  }
  if (brood > 0) {
    return { level: "growth", text: "Growing: new ants are coming." };
  }
  if (foodPerAlive >= 8) {
    return { level: "stable", text: "Strong food bank." };
  }
  if (atRisk > 0) {
    return { level: "active", text: "Some ants are waiting on results." };
  }
  return { level: "stable", text: "Ready: no ants at stake." };
}

function colonyRecordLabel(colony) {
  const wins = Number(colony.wins || 0);
  const losses = Number(colony.losses || 0);
  if (!wins && !losses) return "No results yet";
  return `${wins}W / ${losses}L`;
}

function metricRiskLevel(atRisk, active) {
  if (!atRisk || !active) return "";
  const share = atRisk / active;
  if (share >= 0.65) return "danger";
  if (share >= 0.35) return "warning";
  return "active";
}

function metricDeathLevel(dead, baseSize) {
  if (!dead || !baseSize) return "";
  const share = dead / baseSize;
  if (share >= 0.5) return "danger";
  if (share >= 0.25) return "warning";
  return "";
}

function renderArchetypeSummary(archetypes) {
  if (!archetypes || typeof archetypes !== "object") return "";
  return Object.entries(archetypes)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([name, count]) => `${escapeHtml(name)} ${count}`)
    .join(" · ");
}

function formatScoreBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== "object") {
    return "Relative score = base + survival + growth + net food + reserve + accuracy - losses";
  }
  return [
    `base ${breakdown.base ?? 0}`,
    `survival ${breakdown.survival ?? 0}`,
    `growth ${breakdown.growth ?? 0}`,
    `food net ${breakdown.foodNet ?? 0}`,
    `reserve ${breakdown.foodReserve ?? 0}`,
    `accuracy ${breakdown.accuracy ?? 0}`,
    `losses ${breakdown.lossPenalty ?? 0}`,
  ].join(" · ");
}

function updateScore(score) {
  if (!score || (score.participant1 == null && score.participant2 == null)) {
    els.scoreBox.textContent = "-";
    return;
  }
  els.scoreBox.textContent = `${score.participant1 ?? 0} - ${score.participant2 ?? 0}`;
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

async function patchJson(url, payload) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function emptyInline(message) {
  const item = document.createElement("span");
  item.className = "empty";
  item.textContent = message;
  return item;
}

function strategyLabel(colony) {
  return `${colony.style || "balanced"} - ${colony.favoriteContext || "balanced"} - info ${colony.infoNeed || "medium"}`;
}

function strategyOptions(options, selected) {
  return options
    .map((option) => {
      const isSelected = option === selected ? "selected" : "";
      return `<option value="${escapeHtml(option)}" ${isSelected}>${escapeHtml(option)}</option>`;
    })
    .join("");
}

function formatInteger(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatScoreValue(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatSignedNumber(value) {
  const number = Number(value || 0);
  const formatted = formatScoreValue(Math.abs(number));
  if (number > 0) return `+${formatted}`;
  if (number < 0) return `-${formatted}`;
  return "0";
}

function formatUsd(value) {
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(normalizeDateInput(value));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeDateInput(value) {
  const numericValue = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numericValue === "number" && numericValue > 0 && numericValue < 100_000_000_000) return numericValue * 1000;
  return numericValue;
}

function gameKindLabel(kind) {
  return (
    {
      game_created: "Room",
      player_joined: "Player",
      colony_created: "Colony",
      strategy_updated: "Strategy",
      game_started: "Start",
      opportunity: "Window",
      vote: "Vote",
      info: "Info",
      info_result: "Hint",
      ant_agent_start: "AI calls",
      ant_agent_vote: "AI ants",
      agent_decision: "Agent",
      prediction: "Prediction",
      settlement: "Result",
      observe: "Observe",
      starvation: "Starvation",
      hatch: "Hatch",
      void: "Void",
      markets_closed: "Closure",
      game_finished: "Final",
      game_error: "Error",
    }[kind] || kind || "Game"
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replaceAll('"', '\\"');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
