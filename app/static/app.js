const state = {
  role: "user",
  fixtures: [],
  selected: null,
  game: {
    id: null,
    stream: null,
    events: [],
    colonyCount: 0,
    players: [],
    coloniesById: {},
    strategyDrafts: {},
    status: null,
    activeOpportunities: [],
    agentUsage: null,
  },
};

const ADMIN_REPLAY_DAYS = "14";
const ADMIN_REPLAY_LIMIT = "150";
const USER_LIVE_DAYS = "14";
const USER_LIVE_LIMIT = "100";

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
  startGameLive: document.querySelector("#startGameLive"),
  startGameReplay: document.querySelector("#startGameReplay"),
  gameStatus: document.querySelector("#gameStatus"),
  setupSteps: document.querySelector("#setupSteps"),
  roomCode: document.querySelector("#roomCode"),
  joinRoomForm: document.querySelector("#joinRoomForm"),
  playerName: document.querySelector("#playerName"),
  joinRoom: document.querySelector("#joinRoom"),
  playerList: document.querySelector("#playerList"),
  simulationStatus: document.querySelector("#simulationStatus"),
  simulationStats: document.querySelector("#simulationStats"),
  agentCost: document.querySelector("#agentCost"),
  activeMarkets: document.querySelector("#activeMarkets"),
  colonyForm: document.querySelector("#colonyForm"),
  colonyName: document.querySelector("#colonyName"),
  colonySize: document.querySelector("#colonySize"),
  colonyStyle: document.querySelector("#colonyStyle"),
  colonyFavorite: document.querySelector("#colonyFavorite"),
  colonyInfoNeed: document.querySelector("#colonyInfoNeed"),
  addColony: document.querySelector("#addColony"),
  gameLeaderboard: document.querySelector("#gameLeaderboard"),
  gameFeed: document.querySelector("#gameFeed"),
};

const today = new Date().toISOString().slice(0, 10);
els.fixtureDate.value = today;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  applyWorkspaceRole("user", { load: false });
  await checkHealth();
  await loadFixtures();
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
  els.participateMatch.addEventListener("click", participateInMatch);
  els.startGameLive.addEventListener("click", startGameLive);
  els.startGameReplay.addEventListener("click", startGameReplay);
  els.joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    joinRoom();
  });
  els.colonyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addColony();
  });
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
  els.createGame.textContent = isAdmin ? "Create room" : "Participate";
  els.startGameLive.hidden = isAdmin;
  els.startGameReplay.hidden = !isAdmin;

  clearSelection();
  resetGameUi();
  updateFixtureFilterState();
  if (load) loadFixtures();
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
      applyLiveTarget(data);
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
    if (data.status === "current") return "Current match";
    if (data.status === "next") return "Next match";
    return "No live match";
  }
  if (mode === "upcoming") return `${count} live fixture(s)`;
  return `${count} match(es)`;
}

function applyLiveTarget(data) {
  const target = data.fixture || state.fixtures[0] || null;
  renderLiveMatchTarget(target, data.status);
  if (!target) {
    if (!state.game.id) {
      state.selected = null;
      paintSelectedFixture(null);
    }
    setFixtureRows([]);
    updateGameActions();
    return;
  }

  state.fixtures = [target];
  setSelectedFixture(target, { reset: !state.game.id && state.selected?.fixtureId !== target.fixtureId });
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
  const { reset = true } = options;
  if (reset) resetGameUi();
  paintSelectedFixture(fixture);
  renderFixtures();
  updateGameActions();
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
  els.liveMatchMeta.textContent = hasFixture
    ? [formatDate(fixture.startTimeIso || fixture.startTime), fixture.competition || "Unknown competition", `Fixture ${fixture.fixtureId}`]
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
  els.selectedMeta.textContent = `${fixture.competition || "Unknown competition"} - Fixture ${fixture.fixtureId}`;
  updateScore(fixture.score);
}

function clearSelection() {
  state.selected = null;
  paintSelectedFixture(null);
  renderFixtures();
  updateGameActions();
}

async function createGame() {
  if (!state.selected?.fixtureId) {
    els.gameStatus.textContent = state.role === "admin" ? "Select a replay fixture before creating a room." : "Select a live fixture before creating a room.";
    return null;
  }

  closeGameStream();
  els.gameStatus.textContent = state.role === "admin" ? "Creating replay room..." : "Creating live room...";
  try {
    const game = await postJson("/api/games", {
      fixtureId: state.selected.fixtureId,
      participant1: state.selected.participant1,
      participant2: state.selected.participant2,
    });
    state.game.id = game.gameId;
    state.game.events = [];
    state.game.colonyCount = 0;
    state.game.players = [];
    state.game.coloniesById = {};
    state.game.strategyDrafts = {};
    state.game.status = game.status;
    state.game.activeOpportunities = [];
    state.game.agentUsage = null;
    els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
    renderGameState(game);
    openGameStream();
    return game;
  } catch (error) {
    els.gameStatus.textContent = error.message;
    return null;
  }
}

async function participateInMatch() {
  if (!state.selected?.fixtureId) {
    els.gameStatus.textContent = "No match is available yet.";
    return;
  }
  const name = els.playerName.value.trim();
  if (!name) {
    els.gameStatus.textContent = "Enter your player name before participating.";
    els.playerName.focus();
    return;
  }
  if (!state.game.id) {
    const game = await createGame();
    if (!game) return;
  }
  await joinRoom();
}

async function joinRoom() {
  if (!state.game.id) return;
  const name = els.playerName.value.trim();
  if (!name) {
    els.gameStatus.textContent = "Enter a player name before joining.";
    return;
  }
  els.gameStatus.textContent = "Joining room...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/players`, { name });
    els.playerName.value = "";
    renderGameState(game);
    els.gameStatus.textContent = `${name} joined the room.`;
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function addColony() {
  if (!state.game.id) return;
  const payload = {
    name: els.colonyName.value.trim() || `Colony ${Date.now().toString().slice(-4)}`,
    size: Number(els.colonySize.value),
    style: els.colonyStyle.value,
    favoriteContext: els.colonyFavorite.value,
    infoNeed: els.colonyInfoNeed.value,
  };
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

async function updateColonyStrategy(colonyId) {
  if (!state.game.id || !colonyId) return;
  const { style, favoriteContext, infoNeed } = readStrategyControls(colonyId);
  els.gameStatus.textContent = "Saving strategy...";
  try {
    const game = await patchJson(`/api/games/${state.game.id}/colonies/${encodeURIComponent(colonyId)}/strategy`, {
      style,
      favoriteContext,
      infoNeed,
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
  if (state.game.colonyCount < 1) {
    els.gameStatus.textContent = "Add at least one colony before starting the live match.";
    updateGameActions();
    return;
  }
  els.gameStatus.textContent = "Connecting live TXLine stream...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/start`, {
      mode: "live",
      source: "updates",
    });
    renderGameState(game);
    openGameStream();
    els.gameStatus.textContent = "Live room connected. Colony decisions will appear with TXLine events.";
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
  state.game.players = data.game?.players || state.game.players || [];
  state.game.strategyDrafts = {};
  els.gameFeed.innerHTML = "";
  (data.events || []).forEach(appendGameEvent);
}

function resetGameUi(message = null) {
  closeGameStream();
  state.game.id = null;
  state.game.events = [];
  state.game.colonyCount = 0;
  state.game.players = [];
  state.game.coloniesById = {};
  state.game.strategyDrafts = {};
  state.game.status = null;
  state.game.activeOpportunities = [];
  state.game.agentUsage = null;
  els.gameStatus.textContent =
    message ||
    (state.role === "admin"
      ? "Create a replay room from a completed match."
      : "Create a live room from an upcoming match.");
  els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
  els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
  renderSimulationSummary(null);
  renderRoomSetup(null);
  updateGameActions();
}

function renderGameState(game) {
  if (!game) return;
  const colonies = game.colonies || [];
  state.game.id = game.gameId || state.game.id;
  state.game.colonyCount = colonies.length;
  state.game.players = game.players || state.game.players || [];
  state.game.coloniesById = colonies.reduce((map, colony) => {
    if (colony.colonyId) map[colony.colonyId] = colony.name;
    return map;
  }, {});
  state.game.status = game.status || null;
  state.game.activeOpportunities = game.activeOpportunities || [];
  state.game.agentUsage = game.agentUsage || state.game.agentUsage;
  updateScore(game.match?.score);
  updateGameActions();
  renderRoomSetup(game);
  renderSimulationSummary(game);
  els.gameStatus.textContent = [
    game.gameId ? `Room ${game.gameId}` : null,
    game.status ? `status ${game.status}` : null,
    game.eventIndex != null ? `${game.eventIndex} events` : null,
  ]
    .filter(Boolean)
    .join(" - ");

  if (!colonies.length) {
    els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
    return;
  }

  els.gameLeaderboard.replaceChildren(
    ...colonies.map((colony, index) => {
      const card = document.createElement("article");
      card.className = "colony-card";
      const scoreTitle = formatScoreBreakdown(colony.scoreBreakdown);
      const strategyLocked = state.game.status === "finished";
      const strategyDraft = state.game.strategyDrafts[colony.colonyId] || {};
      const selectedStyle = strategyDraft.style || colony.style;
      const selectedFavorite = strategyDraft.favoriteContext || colony.favoriteContext;
      const selectedInfoNeed = strategyDraft.infoNeed || colony.infoNeed;
      card.innerHTML = `
        <div class="colony-rank">#${index + 1}</div>
        <div>
          <div class="colony-head">
            <h4>${escapeHtml(colony.name)}</h4>
            <span>${colony.wins || 0}W / ${colony.losses || 0}L</span>
          </div>
          <p>${escapeHtml(strategyLabel(colony))}</p>
          <div class="colony-stats">
            <span><b>${colony.food}</b> food</span>
            <span><b>${colony.larvae}</b> larvae</span>
            <span><b>${colony.antsAlive}</b> alive</span>
            <span><b>${colony.antsActive ?? colony.antsAlive}</b> can vote</span>
            <span><b>${colony.antsEngaged || 0}</b> at risk</span>
            <span><b>${colony.antsBorn || 0}</b> born</span>
            <span><b>${colony.antsWounded}</b> wounded</span>
            <span><b>${colony.antsDead}</b> dead</span>
            <span><b>${colony.infoPurchases || 0}</b> infos</span>
            <span title="${escapeHtml(scoreTitle)}">score <b>${colony.score}</b></span>
          </div>
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
      return card;
    }),
  );
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

function renderRoomSetup(game = null) {
  const players = game?.players || state.game.players || [];
  const status = game?.status || state.game.status || "created";
  const hasRoom = Boolean(state.game.id);
  const hasPlayers = players.length > 0;
  const hasColonies = state.game.colonyCount > 0;
  const liveReady = hasRoom && hasColonies && !["running_replay", "running_live", "finished"].includes(status);
  els.roomCode.textContent = hasRoom ? state.game.id : "No room yet";
  els.joinRoom.disabled = !hasRoom || status === "finished";
  els.playerName.disabled = state.role === "admin" ? !hasRoom || status === "finished" : status === "finished";
  els.playerList.replaceChildren(
    ...(hasPlayers
      ? players.map((player) => {
          const item = document.createElement("span");
          item.className = "player-pill";
          item.textContent = player.name || "Player";
          return item;
        })
      : [
          emptyInline(
            hasRoom
              ? "No player has joined yet."
              : state.role === "admin"
                ? "Create a room, then players can join."
                : "Enter your name, then participate in the match.",
          ),
        ]),
  );
  const steps = [
    ["Room", hasRoom],
    ["Players", hasPlayers],
    ["Colonies", hasColonies],
    [state.role === "admin" ? "Replay" : "Live", liveReady || ["running_replay", "running_live", "finished"].includes(status)],
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

function updateGameActions() {
  const isAdmin = state.role === "admin";
  const hasRoom = Boolean(state.game.id);
  const status = state.game.status || "created";
  const running = ["running_replay", "running_live"].includes(status);
  const locked = running || status === "finished";
  const hasColony = state.game.colonyCount > 0;
  els.createGame.disabled = hasRoom && !["finished", "error", "stopped"].includes(status);
  els.participateMatch.disabled = !state.selected?.fixtureId || (hasRoom && !["finished", "error", "stopped"].includes(status));
  els.participateMatch.textContent =
    hasRoom && !["finished", "error", "stopped"].includes(status) ? "Room ready" : "Participate in match";
  els.addColony.disabled = !hasRoom || locked;
  els.joinRoom.disabled = !hasRoom || status === "finished";
  els.startGameLive.disabled = isAdmin || !hasRoom || locked || !hasColony;
  els.startGameReplay.disabled = !isAdmin || !hasRoom || locked || !hasColony;
}

function appendGameEvent(event) {
  if (!event || state.game.events.some((item) => item.index === event.index)) return;
  state.game.events.push(event);
  if (event.kind === "game_finished") {
    state.game.status = "finished";
    state.game.agentUsage = event.data?.agentUsage || state.game.agentUsage;
    updateGameActions();
  } else if (event.kind === "game_error") {
    state.game.status = "error";
    updateGameActions();
  }

  renderGameJournal();
  els.gameFeed.scrollTop = els.gameFeed.scrollHeight;
  renderSimulationSummary();
}

function renderGameJournal() {
  const events = state.game.events || [];
  if (!events.length) {
    els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
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
  item.className = "journal-market";
  const lanes = marketColonyLanes(group.events);
  const endings = group.events.filter((event) => ["settlement", "void", "markets_closed"].includes(event.kind));
  const errors = group.events.filter((event) => event.kind === "game_error");
  item.innerHTML = `
    <div class="market-head">
      <span class="event-label opportunity">Market</span>
      <strong>${escapeHtml(group.event.message || group.opportunity.label || "Market")}</strong>
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
        ? `<div class="market-end"><span>End market</span>${endings.map((event) => `<p>${escapeHtml(event.message || "")}</p>`).join("")}</div>`
        : ""
    }
    ${errors.map((event) => `<div class="market-error">${escapeHtml(event.message || "")}${formatEventDetails(event) ? `<div>${formatEventDetails(event)}</div>` : ""}</div>`).join("")}
  `;
  return item;
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
    running_replay: "Simulation running",
    running_live: "Live running",
    finished: "Simulation finished",
    error: "Error",
    stopped: "Stopped",
  };
  els.simulationStatus.className = `sim-status ${status}`;
  els.simulationStatus.textContent = statusLabels[status] || status;
  const eventIndex = game?.eventIndex;
  els.simulationStats.textContent = [
    eventIndex != null ? `${eventIndex} TXLine events read` : null,
    `${counts.opportunity || 0} markets`,
    `${counts.ant_agent_vote || 0} AI ant votes`,
    counts.agent_decision ? `${counts.agent_decision} agent decisions` : null,
    `${counts.prediction || 0} commitments`,
    `${counts.settlement || 0} results`,
    counts.void ? `${counts.void} void` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  renderAgentCost(status, game?.agentUsage || state.game.agentUsage);

  const markets = game?.activeOpportunities || state.game.activeOpportunities || [];
  if (!markets.length) {
    els.activeMarkets.innerHTML = `<span class="empty">No active market.</span>`;
    return;
  }
  els.activeMarkets.replaceChildren(
    ...markets.slice(0, 4).map((market) => {
      const item = document.createElement("span");
      item.className = "market-pill";
      item.textContent = market.label || market.context || "Market";
      return item;
    }),
  );
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

function formatUsd(value) {
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
