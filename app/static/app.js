const state = {
  fixtures: [],
  selected: null,
  source: "historical",
  liveSource: null,
  timelineEvents: [],
  fullData: null,
  game: {
    id: null,
    source: null,
    events: [],
    colonyCount: 0,
    status: null,
    activeOpportunities: [],
    agentUsage: null,
  },
  replay: {
    events: [],
    index: 0,
    timer: null,
    playing: false,
    speedMs: 900,
  },
};

const els = {
  healthBadge: document.querySelector("#healthBadge"),
  fixtureCount: document.querySelector("#fixtureCount"),
  refreshFixtures: document.querySelector("#refreshFixtures"),
  fixtureFilters: document.querySelector("#fixtureFilters"),
  upcomingOnly: document.querySelector("#upcomingOnly"),
  upcomingDays: document.querySelector("#upcomingDays"),
  fixtureDate: document.querySelector("#fixtureDate"),
  competitionId: document.querySelector("#competitionId"),
  fixtureSearch: document.querySelector("#fixtureSearch"),
  fixturesBody: document.querySelector("#fixturesBody"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  scoreBox: document.querySelector("#scoreBox"),
  manualFixture: document.querySelector("#manualFixture"),
  manualFixtureId: document.querySelector("#manualFixtureId"),
  matchDetailsStatus: document.querySelector("#matchDetailsStatus"),
  matchInfoGrid: document.querySelector("#matchInfoGrid"),
  lineupsGrid: document.querySelector("#lineupsGrid"),
  fullDataStatus: document.querySelector("#fullDataStatus"),
  fullDataGrid: document.querySelector("#fullDataGrid"),
  fullDataPreview: document.querySelector("#fullDataPreview"),
  loadFullData: document.querySelector("#loadFullData"),
  downloadFullData: document.querySelector("#downloadFullData"),
  importantOnly: document.querySelector("#importantOnly"),
  includePossession: document.querySelector("#includePossession"),
  loadTimeline: document.querySelector("#loadTimeline"),
  replayPlay: document.querySelector("#replayPlay"),
  replayReset: document.querySelector("#replayReset"),
  replaySpeed: document.querySelector("#replaySpeed"),
  replayProgress: document.querySelector("#replayProgress"),
  replayStatus: document.querySelector("#replayStatus"),
  timeline: document.querySelector("#timeline"),
  startLive: document.querySelector("#startLive"),
  stopLive: document.querySelector("#stopLive"),
  liveImportantOnly: document.querySelector("#liveImportantOnly"),
  liveIncludePossession: document.querySelector("#liveIncludePossession"),
  liveStatus: document.querySelector("#liveStatus"),
  liveFeed: document.querySelector("#liveFeed"),
  intervalForm: document.querySelector("#intervalForm"),
  intervalDate: document.querySelector("#intervalDate"),
  intervalHour: document.querySelector("#intervalHour"),
  intervalIndex: document.querySelector("#intervalIndex"),
  intervalTimeline: document.querySelector("#intervalTimeline"),
  runPreviousTxGame: document.querySelector("#runPreviousTxGame"),
  runDemoGame: document.querySelector("#runDemoGame"),
  createGame: document.querySelector("#createGame"),
  startGameReplay: document.querySelector("#startGameReplay"),
  rerunGame: document.querySelector("#rerunGame"),
  startGameLive: document.querySelector("#startGameLive"),
  gameStatus: document.querySelector("#gameStatus"),
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
  eventTemplate: document.querySelector("#eventTemplate"),
};

const today = new Date().toISOString().slice(0, 10);
els.fixtureDate.value = today;
els.intervalDate.value = today;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await checkHealth();
  await loadFixtures();
});

function bindEvents() {
  els.refreshFixtures.addEventListener("click", loadFixtures);
  els.fixtureFilters.addEventListener("submit", (event) => {
    event.preventDefault();
    loadFixtures();
  });
  els.fixtureSearch.addEventListener("input", debounce(loadFixtures, 300));
  els.upcomingOnly.addEventListener("change", loadFixtures);
  els.upcomingDays.addEventListener("change", loadFixtures);
  els.competitionId.addEventListener("change", loadFixtures);
  els.fixtureDate.addEventListener("change", loadFixtures);
  els.manualFixture.addEventListener("submit", (event) => {
    event.preventDefault();
    const fixtureId = Number(els.manualFixtureId.value);
    if (!fixtureId) return;
    selectFixture({ fixtureId, participant1: null, participant2: null, competition: "Manual" });
    loadTimeline();
  });
  els.loadTimeline.addEventListener("click", loadTimeline);
  els.loadFullData.addEventListener("click", loadFullData);
  els.downloadFullData.addEventListener("click", downloadFullData);
  els.replayPlay.addEventListener("click", toggleReplay);
  els.replayReset.addEventListener("click", resetReplay);
  els.replaySpeed.addEventListener("change", () => {
    state.replay.speedMs = Number(els.replaySpeed.value);
    if (state.replay.playing) {
      window.clearTimeout(state.replay.timer);
      state.replay.timer = window.setTimeout(stepReplay, state.replay.speedMs);
    }
  });
  els.replayProgress.addEventListener("input", () => {
    seekReplay(Number(els.replayProgress.value));
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      state.source = button.dataset.source;
      loadTimeline();
    });
  });
  els.startLive.addEventListener("click", startLive);
  els.stopLive.addEventListener("click", stopLive);
  els.intervalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadInterval();
  });
  els.runPreviousTxGame.addEventListener("click", runPreviousTxGame);
  els.runDemoGame.addEventListener("click", runDemoGame);
  els.createGame.addEventListener("click", createGame);
  els.startGameReplay.addEventListener("click", () => startGame("replay"));
  els.rerunGame.addEventListener("click", rerunGame);
  els.startGameLive.addEventListener("click", () => startGame("live"));
  els.colonyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addColony();
  });
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
  } catch (error) {
    els.healthBadge.className = "badge badge-error";
    els.healthBadge.textContent = "Backend unavailable";
  }
}

async function loadFixtures() {
  setFixtureRows([{ loading: true }]);
  const params = new URLSearchParams();
  if (els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  if (els.competitionId.value) params.set("competition_id", els.competitionId.value);
  if (els.fixtureSearch.value.trim()) params.set("search", els.fixtureSearch.value.trim());
  const endpoint = els.upcomingOnly.checked ? "/api/fixtures/upcoming" : "/api/fixtures";
  if (els.upcomingOnly.checked) {
    params.set("days", els.upcomingDays.value || "14");
    params.set("limit", "100");
  }

  try {
    const data = await getJson(`${endpoint}?${params.toString()}`);
    state.fixtures = data.fixtures || [];
    els.fixtureCount.textContent = els.upcomingOnly.checked
      ? `${data.count || 0} match(es) upcoming across ${data.days || els.upcomingDays.value || 14} day(s)`
      : `${data.count || 0} match(es)`;
    renderFixtures();
  } catch (error) {
    state.fixtures = [];
    els.fixtureCount.textContent = "Error";
    setFixtureRows([{ error: error.message }]);
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
        <td>${formatDate(fixture.startTimeIso)}</td>
        <td>
          <div class="match-name">${escapeHtml(fixture.participant1 || "Participant 1")} - ${escapeHtml(
            fixture.participant2 || "Participant 2",
          )}</div>
          <div class="muted">Fixture ${escapeHtml(fixture.fixtureId)}</div>
        </td>
        <td>
          <div>${escapeHtml(fixture.competition || "-")}</div>
          <div class="muted">ID ${escapeHtml(fixture.competitionId || "-")}</div>
        </td>
      `;
      row.addEventListener("click", () => {
        selectFixture(fixture);
        loadTimeline();
      });
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
  stopReplay();
  resetGameUi();
  state.selected = fixture;
  els.manualFixtureId.value = fixture.fixtureId || "";
  els.selectedTitle.textContent = `${fixture.participant1 || "Participant 1"} - ${fixture.participant2 || "Participant 2"}`;
  els.selectedMeta.textContent = `${fixture.competition || "Unknown competition"} - Fixture ${fixture.fixtureId}`;
  els.scoreBox.textContent = "-";
  renderFullData(null);
  loadMatchDetails();
  renderFixtures();
}

async function runPreviousTxGame() {
  closeGameStream();
  state.game.agentUsage = null;
  els.gameStatus.textContent = "Searching for the latest TXLine match with data...";
  try {
    const payload = {
      days: 30,
      limit: 60,
    };
    if (els.competitionId.value) payload.competitionId = Number(els.competitionId.value);
    if (els.fixtureSearch.value.trim()) payload.search = els.fixtureSearch.value.trim();
    const game = await postJson("/api/games/run-previous", payload);
    state.game.id = game.gameId;
    state.selected = {
      fixtureId: game.fixtureId,
      participant1: game.participant1,
      participant2: game.participant2,
      competition: "TXLine previous match",
    };
    els.selectedTitle.textContent = `${game.participant1 || "Participant 1"} - ${game.participant2 || "Participant 2"}`;
    els.selectedMeta.textContent = `TXLine previous match - Fixture ${game.fixtureId}`;
    updateScore(game.match?.score);
    els.addColony.disabled = true;
    els.startGameReplay.disabled = true;
    els.startGameLive.disabled = true;
    renderGameState(game);
    await loadGameReplay();
    els.gameStatus.textContent = `Run TXLine finished - ${state.game.events.length} game events.`;
  } catch (error) {
    els.gameStatus.textContent = `Cannot run TXLine: ${error.message}`;
  }
}

async function runDemoGame() {
  closeGameStream();
  state.game.agentUsage = null;
  els.gameStatus.textContent = "Local demo run in progress...";
  try {
    const game = await postJson("/api/demo/run", {});
    state.game.id = game.gameId;
    state.selected = {
      fixtureId: game.fixtureId,
      participant1: game.participant1,
      participant2: game.participant2,
      competition: "Demo Previous Match",
    };
    els.selectedTitle.textContent = `${game.participant1 || "Participant 1"} - ${game.participant2 || "Participant 2"}`;
    els.selectedMeta.textContent = `Demo Previous Match - Fixture ${game.fixtureId}`;
    updateScore(game.match?.score);
    els.addColony.disabled = true;
    els.startGameReplay.disabled = true;
    els.startGameLive.disabled = true;
    renderGameState(game);
    await loadGameReplay();
    els.gameStatus.textContent = `Local demo run finished - ${state.game.events.length} game events.`;
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function createGame() {
  if (!state.selected?.fixtureId) {
    els.gameStatus.textContent = "Select a match before creating a room.";
    return;
  }

  closeGameStream();
  els.gameStatus.textContent = "Creating room...";
  try {
    const game = await postJson("/api/games", {
      fixtureId: state.selected.fixtureId,
      participant1: state.selected.participant1,
      participant2: state.selected.participant2,
    });
    state.game.id = game.gameId;
    state.game.events = [];
    state.game.colonyCount = 0;
    state.game.status = game.status;
    state.game.activeOpportunities = [];
    state.game.agentUsage = null;
    els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
    els.gameStatus.textContent = `Room ${game.gameId} ready. Add colonies.`;
    renderGameState(game);
    openGameStream();
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

async function startGame(mode) {
  if (!state.game.id) return;
  if (state.game.colonyCount < 1) {
    els.gameStatus.textContent = "Add at least one colony before starting the match.";
    updateGameActions();
    return;
  }
  els.gameStatus.textContent = mode === "live" ? "Connecting live..." : "Replay game in progress...";
  try {
    const game = await postJson(`/api/games/${state.game.id}/start`, {
      mode,
      source: state.source,
    });
    renderGameState(game);
    if (mode === "replay") {
      await loadGameReplay();
      els.gameStatus.textContent = "Match run started. Decisions will appear in the journal.";
    } else {
      els.gameStatus.textContent = "Live game started.";
    }
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

async function rerunGame() {
  if (!state.game.id) return;
  els.gameStatus.textContent = "Rerunning simulation...";
  closeGameStream();
  try {
    const game = await postJson(`/api/games/${state.game.id}/rerun`, {
      mode: "replay",
      source: state.source,
    });
    state.game.id = game.gameId;
    state.game.events = [];
    state.game.agentUsage = null;
    els.gameFeed.innerHTML = "";
    renderGameState(game);
    openGameStream();
    await loadGameReplay();
    els.gameStatus.textContent = "New simulation started.";
  } catch (error) {
    els.gameStatus.textContent = error.message;
  }
}

function openGameStream() {
  closeGameStream();
  if (!state.game.id) return;
  state.game.source = new EventSource(`/api/games/${state.game.id}/events`);
  state.game.source.addEventListener("game_event", (event) => {
    const item = JSON.parse(event.data);
    appendGameEvent(item);
  });
  state.game.source.addEventListener("game_state", (event) => {
    const game = JSON.parse(event.data);
    renderGameState(game);
  });
  state.game.source.onerror = () => {
    els.gameStatus.textContent = "Game stream reconnecting...";
  };
}

function closeGameStream() {
  if (state.game.source) {
    state.game.source.close();
    state.game.source = null;
  }
}

async function loadGameReplay() {
  if (!state.game.id) return;
  const data = await getJson(`/api/games/${state.game.id}/replay`);
  renderGameState(data.game);
  state.game.events = [];
  els.gameFeed.innerHTML = "";
  (data.events || []).forEach(appendGameEvent);
}

function resetGameUi() {
  closeGameStream();
  state.game.id = null;
  state.game.events = [];
  state.game.colonyCount = 0;
  state.game.status = null;
  state.game.activeOpportunities = [];
  state.game.agentUsage = null;
  updateGameActions();
  els.gameStatus.textContent = "Create a room from the selected match.";
  els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
  els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
  renderSimulationSummary(null);
}

function renderGameState(game) {
  if (!game) return;
  const colonies = game.colonies || [];
  state.game.id = game.gameId || state.game.id;
  state.game.colonyCount = colonies.length;
  state.game.status = game.status || null;
  state.game.activeOpportunities = game.activeOpportunities || [];
  state.game.agentUsage = game.agentUsage || state.game.agentUsage;
  updateGameActions();
  renderSimulationSummary(game);
  els.gameStatus.textContent = [
    game.gameId ? `Room ${game.gameId}` : null,
    game.status ? `statut ${game.status}` : null,
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
      card.innerHTML = `
        <div class="colony-rank">#${index + 1}</div>
        <div>
          <div class="colony-head">
            <h4>${escapeHtml(colony.name)}</h4>
            <span>${colony.wins || 0}W / ${colony.losses || 0}L</span>
          </div>
          <p>${escapeHtml(colony.style)} - ${escapeHtml(colony.favoriteContext)} - info ${escapeHtml(colony.infoNeed)}</p>
          <div class="colony-stats">
            <span><b>${colony.food}</b> food</span>
            <span><b>${colony.larvae}</b> larvae</span>
            <span><b>${colony.antsAlive}</b> alive</span>
            <span><b>${colony.antsBorn || 0}</b> born</span>
            <span><b>${colony.antsWounded}</b> wounded</span>
            <span><b>${colony.antsDead}</b> dead</span>
            <span><b>${colony.infoPurchases || 0}</b> infos</span>
            <span title="${escapeHtml(scoreTitle)}">score <b>${colony.score}</b></span>
          </div>
          <div class="colony-dna">${renderArchetypeSummary(colony.archetypes)}</div>
        </div>
      `;
      return card;
    }),
  );
}

function updateGameActions() {
  const hasRoom = Boolean(state.game.id);
  const locked = ["running_replay", "running_live", "finished"].includes(state.game.status);
  const running = ["running_replay", "running_live"].includes(state.game.status);
  const hasColony = state.game.colonyCount > 0;
  els.createGame.disabled = hasRoom && !locked;
  els.addColony.disabled = !hasRoom || locked;
  els.startGameReplay.disabled = !hasRoom || locked || !hasColony;
  els.rerunGame.disabled = !hasRoom || running || !hasColony;
  els.startGameLive.disabled = !hasRoom || locked || !hasColony;
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
  if (els.gameFeed.querySelector(".empty")) els.gameFeed.innerHTML = "";
  const item = document.createElement("li");
  item.className = `game-log-${event.kind || "event"}`;
  item.innerHTML = `
    <div class="event-main">
      <span class="event-label ${escapeHtml(event.kind || "update")}">${escapeHtml(gameKindLabel(event.kind))}</span>
      <span class="event-desc">${escapeHtml(event.message || "Update game")}</span>
    </div>
  `;
  els.gameFeed.append(item);
  while (els.gameFeed.children.length > 160) {
    els.gameFeed.firstElementChild.remove();
  }
  els.gameFeed.scrollTop = els.gameFeed.scrollHeight;
  renderSimulationSummary();
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
  if (!els.agentCost) return;
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

async function loadMatchDetails() {
  if (!state.selected?.fixtureId) {
    renderMatchDetails(null);
    return;
  }

  els.matchDetailsStatus.textContent = "Loading info...";
  els.matchInfoGrid.innerHTML = "";
  els.lineupsGrid.innerHTML = "";
  const params = new URLSearchParams();
  if (state.selected.participant1) params.set("participant1", state.selected.participant1);
  if (state.selected.participant2) params.set("participant2", state.selected.participant2);

  try {
    const data = await getJson(`/api/scores/${state.selected.fixtureId}/details?${params.toString()}`);
    renderMatchDetails(data);
  } catch (error) {
    els.matchDetailsStatus.textContent = error.message;
  }
}

async function loadTimeline() {
  stopReplay();
  if (!state.selected?.fixtureId) {
    prepareReplay([]);
    renderEvents(els.timeline, [], "Select a match first.");
    return;
  }

  prepareReplay([]);
  els.timeline.innerHTML = `<li class="empty">Loading timeline...</li>`;
  const params = new URLSearchParams({
    source: state.source,
    important_only: String(els.importantOnly.checked),
    include_possession: String(els.includePossession.checked),
    limit: els.importantOnly.checked ? "500" : "2000",
  });
  if (state.selected.participant1) params.set("participant1", state.selected.participant1);
  if (state.selected.participant2) params.set("participant2", state.selected.participant2);

  try {
    const data = await getJson(`/api/scores/${state.selected.fixtureId}/timeline?${params.toString()}`);
    state.timelineEvents = data.events || [];
    updateScore(data.score);
    renderEvents(els.timeline, state.timelineEvents, "No highlight found for this source.");
    prepareReplay(state.timelineEvents, data);
    return state.timelineEvents;
  } catch (error) {
    state.timelineEvents = [];
    prepareReplay([]);
    renderEvents(els.timeline, [], error.message);
    return [];
  }
}

function renderMatchDetails(data) {
  if (!data) {
    els.matchDetailsStatus.textContent = "Select a match.";
    els.matchInfoGrid.innerHTML = "";
    els.lineupsGrid.innerHTML = "";
    return;
  }

  els.matchDetailsStatus.textContent = `${data.recordCount || 0} raw updates - source ${data.source || "-"}`;
  const env = data.environment || {};
  const stats = data.stats || {};
  const infoItems = [
    ["Pitch", env.pitchConditions?.join(", ")],
    ["Weather", env.weatherConditions?.join(", ")],
    ["Venue", env.venueType],
    ["Jerseys", formatJerseys(env.jerseys)],
    ["Stats", formatStats(stats)],
    ["Added time", formatAdditionalTime(data.additionalTime)],
  ].filter(([, value]) => value);

  els.matchInfoGrid.replaceChildren(
    ...infoItems.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "info-item";
      item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return item;
    }),
  );

  const teams = data.lineups || [];
  els.lineupsGrid.replaceChildren(...teams.map(renderLineupTeam));
}

async function loadFullData() {
  if (!state.selected?.fixtureId) {
    renderFullData(null);
    return;
  }

  els.fullDataStatus.textContent = "Loading full package...";
  els.fullDataGrid.innerHTML = "";
  els.fullDataPreview.textContent = "{}";
  els.downloadFullData.disabled = true;

  const params = new URLSearchParams({ include_raw: "true" });
  if (state.selected.participant1) params.set("participant1", state.selected.participant1);
  if (state.selected.participant2) params.set("participant2", state.selected.participant2);

  try {
    const data = await getJson(`/api/scores/${state.selected.fixtureId}/full?${params.toString()}`);
    renderFullData(data);
  } catch (error) {
    state.fullData = null;
    els.fullDataStatus.textContent = error.message;
  }
}

function renderFullData(data) {
  state.fullData = data;
  if (!data) {
    els.fullDataStatus.textContent = "No package loaded.";
    els.fullDataGrid.innerHTML = "";
    els.fullDataPreview.textContent = "{}";
    els.downloadFullData.disabled = true;
    return;
  }

  const inventory = data.inventory || {};
  const timeline = data.timeline || {};
  const sourceCounts = data.sourceCounts || {};
  const items = [
    ["Source", `${data.source || "-"} (${formatSourceCounts(sourceCounts)})`],
    ["Records", `${data.recordCount || 0} raw / ${timeline.count || 0} normalized`],
    ["Actions", formatTopEntries(inventory.actionCounts, 8)],
    ["Top fields", formatTopEntries(inventory.topFieldCounts, 8)],
    ["Data fields", formatTopEntries(inventory.dataFieldCounts, 8)],
    ["Possession", formatTopEntries(inventory.possessionTypeCounts, 6)],
    ["Score", formatTopEntries(inventory.scoreFieldPaths, 6)],
    ["Stats", formatTopEntries(inventory.statsFieldPaths, 6)],
  ].filter(([, value]) => value);

  els.fullDataStatus.textContent = `${data.recordCount || 0} records kept for later`;
  els.fullDataGrid.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "info-item";
      item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return item;
    }),
  );
  els.fullDataPreview.textContent = JSON.stringify(
    {
      source: data.source,
      sourceCounts: data.sourceCounts,
      latestState: data.latestState,
      inventory: data.inventory,
    },
    null,
    2,
  );
  els.downloadFullData.disabled = false;
}

function downloadFullData() {
  if (!state.fullData) return;
  const fixtureId = state.selected?.fixtureId || state.fullData.fixture?.fixtureId || "fixture";
  const blob = new Blob([JSON.stringify(state.fullData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `txline-${fixtureId}-full.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderLineupTeam(team) {
  const section = document.createElement("section");
  section.className = "lineup-team";
  const starters = team.starters || [];
  const substitutes = team.substitutes || [];
  section.innerHTML = `
    <h4>${escapeHtml(team.teamName || "Team")}</h4>
    <p>${starters.length} starter(s), ${substitutes.length} substitute(s)</p>
    <div class="lineup-list">
      ${starters.slice(0, 11).map(formatPlayerChip).join("")}
    </div>
    <details>
      <summary>Substitutes</summary>
      <div class="lineup-list">${substitutes.map(formatPlayerChip).join("")}</div>
    </details>
  `;
  return section;
}

function formatPlayerChip(player) {
  const number = player.rosterNumber ? `#${escapeHtml(player.rosterNumber)} ` : "";
  const name = escapeHtml(player.name || `Player ${player.normativeId || ""}`);
  return `<span class="player-chip">${number}${name}</span>`;
}

function formatJerseys(jerseys = {}) {
  const entries = Object.entries(jerseys);
  if (!entries.length) return null;
  return entries.map(([team, color]) => `${team}: ${color}`).join(" / ");
}

function formatStats(stats = {}) {
  const teams = [stats.participant1, stats.participant2].filter(Boolean);
  if (!teams.length) return null;
  return teams
    .map((team) => {
      const bits = [
        team.goals != null ? `${team.goals} goals` : null,
        team.corners != null ? `${team.corners} corners` : null,
        team.yellowCards != null ? `${team.yellowCards} yellow` : null,
        team.redCards != null ? `${team.redCards} red` : null,
      ].filter(Boolean);
      return bits.length ? `${team.label || "Team"}: ${bits.join(", ")}` : null;
    })
    .filter(Boolean)
    .join(" / ");
}

function formatAdditionalTime(items = []) {
  if (!items.length) return null;
  return items.map((item) => `${item.period || "period"} +${item.minutes}'`).join(" / ");
}

function formatSourceCounts(sourceCounts = {}) {
  return Object.entries(sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(" / ");
}

function formatTopEntries(counts = {}, limit = 6) {
  const entries = Object.entries(counts).slice(0, limit);
  if (!entries.length) return null;
  return entries.map(([name, count]) => `${name} ${count}`).join(" / ");
}

async function loadInterval() {
  const params = new URLSearchParams({
    date: els.intervalDate.value,
    hour: els.intervalHour.value,
    interval: els.intervalIndex.value,
    important_only: "true",
    include_possession: "true",
    limit: "500",
  });

  els.intervalTimeline.innerHTML = `<li class="empty">Loading interval...</li>`;
  try {
    const data = await getJson(`/api/scores/interval?${params.toString()}`);
    renderEvents(els.intervalTimeline, data.events || [], "No highlight found in this interval.");
  } catch (error) {
    renderEvents(els.intervalTimeline, [], error.message);
  }
}

function startLive() {
  stopLive();
  const params = new URLSearchParams({
    important_only: String(els.liveImportantOnly.checked),
    include_possession: String(els.liveIncludePossession.checked),
  });
  if (state.selected?.fixtureId) params.set("fixture_id", state.selected.fixtureId);

  state.liveSource = new EventSource(`/api/live/events?${params.toString()}`);
  els.liveStatus.textContent = state.selected?.fixtureId
    ? `Connected to fixture ${state.selected.fixtureId}`
    : "Connected to all matches";
  els.startLive.disabled = true;
  els.stopLive.disabled = false;
  els.liveFeed.innerHTML = "";

  state.liveSource.onopen = () => {
    els.liveStatus.textContent = "Connected, waiting for events";
  };
  state.liveSource.addEventListener("score", (event) => {
    const item = JSON.parse(event.data);
    prependLiveEvent(item);
  });
  state.liveSource.addEventListener("heartbeat", () => {
    els.liveStatus.textContent = "Stream active";
  });
  state.liveSource.addEventListener("txline_error", (event) => {
    const message = event.data ? JSON.parse(event.data).detail : "Stream interrupted";
    prependLiveEvent({ description: message, highlights: ["error"], fixtureId: "-" });
    els.liveStatus.textContent = "Stream error";
  });
  state.liveSource.onerror = () => {
    els.liveStatus.textContent = "Reconnecting...";
  };
}

function stopLive() {
  if (state.liveSource) {
    state.liveSource.close();
    state.liveSource = null;
  }
  els.liveStatus.textContent = "Stream stopped";
  els.startLive.disabled = false;
  els.stopLive.disabled = true;
}

function prependLiveEvent(event) {
  if (els.liveFeed.querySelector(".empty")) els.liveFeed.innerHTML = "";
  const node = renderEvent(event);
  els.liveFeed.prepend(node);
  while (els.liveFeed.children.length > 100) {
    els.liveFeed.lastElementChild.remove();
  }
}

function renderEvents(container, events, emptyText, options = {}) {
  if (!events.length) {
    container.innerHTML = `<li class="empty">${escapeHtml(emptyText)}</li>`;
    return;
  }
  container.replaceChildren(
    ...events.map((event, index) => renderEvent(event, { current: index === options.currentIndex })),
  );
}

function renderEvent(event, options = {}) {
  const node = els.eventTemplate.content.firstElementChild.cloneNode(true);
  if (options.current) node.classList.add("current");
  const primary = event.highlights?.[0] || "update";
  const label = node.querySelector(".event-label");
  label.textContent = labelFor(primary);
  label.classList.add(primary);
  node.querySelector(".event-desc").textContent = event.description || event.action || "Update score";
  node.querySelector(".event-meta").textContent = [
    event.fixtureId ? `Fixture ${event.fixtureId}` : null,
    event.tsIso ? formatDate(event.tsIso) : null,
    event.seq != null ? `Seq ${event.seq}` : null,
  ]
    .filter(Boolean)
    .join(" - ");
  const details = event.details || [];
  if (details.length) {
    const detailNode = document.createElement("div");
    detailNode.className = "event-details";
    detailNode.textContent = details.join(" - ");
    node.append(detailNode);
  }
  return node;
}

async function toggleReplay() {
  if (state.replay.playing) {
    pauseReplay();
    return;
  }

  if (!state.replay.events.length) {
    const loaded = await loadTimeline();
    if (!loaded?.length) return;
  }

  if (state.replay.index >= state.replay.events.length) {
    state.replay.index = 0;
  }
  state.replay.playing = true;
  els.replayPlay.textContent = "Pause";
  els.replayReset.disabled = false;
  stepReplay();
}

function stepReplay() {
  if (!state.replay.playing) return;
  if (state.replay.index >= state.replay.events.length) {
    pauseReplay();
    els.replayStatus.textContent = `Replay finished (${state.replay.events.length}/${state.replay.events.length}).`;
    return;
  }

  state.replay.index += 1;
  renderReplayFrame();
  state.replay.timer = window.setTimeout(stepReplay, state.replay.speedMs);
}

function renderReplayFrame() {
  const visibleEvents = state.replay.events.slice(0, state.replay.index);
  const currentEvent = visibleEvents[visibleEvents.length - 1];
  renderEvents(els.timeline, visibleEvents, "Replay ready.", { currentIndex: visibleEvents.length - 1 });
  els.replayProgress.value = String(state.replay.index);
  els.replayStatus.textContent = currentEvent
    ? `${state.replay.index}/${state.replay.events.length} - ${currentEvent.description || currentEvent.action || "Action"}`
    : `0/${state.replay.events.length}`;
  if (currentEvent?.score && (currentEvent.score.participant1 != null || currentEvent.score.participant2 != null)) {
    updateScore(currentEvent.score);
  }
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

function pauseReplay() {
  window.clearTimeout(state.replay.timer);
  state.replay.timer = null;
  state.replay.playing = false;
  els.replayPlay.textContent = "Play";
}

function stopReplay() {
  pauseReplay();
}

function resetReplay() {
  pauseReplay();
  state.replay.index = 0;
  els.replayProgress.value = "0";
  els.replayStatus.textContent = state.replay.events.length
    ? `Replay ready (0/${state.replay.events.length}).`
    : "Load a timeline to start the replay.";
  renderEvents(els.timeline, state.timelineEvents, "No timeline loaded.");
}

function seekReplay(index) {
  state.replay.index = Math.max(0, Math.min(index, state.replay.events.length));
  if (state.replay.index === 0) {
    renderEvents(els.timeline, [], "Replay at the beginning. Press Play.");
    els.replayStatus.textContent = `0/${state.replay.events.length}`;
    return;
  }
  renderReplayFrame();
}

function prepareReplay(events, timelineData = null) {
  pauseReplay();
  state.replay.events = events || [];
  state.replay.index = 0;
  els.replayPlay.disabled = !state.replay.events.length;
  els.replayReset.disabled = !state.replay.events.length;
  els.replayProgress.disabled = !state.replay.events.length;
  els.replayProgress.max = String(state.replay.events.length);
  els.replayProgress.value = "0";
  if (!state.replay.events.length) {
    els.replayStatus.textContent = "Load a timeline to start the replay.";
    return;
  }

  const rawCount = timelineData?.rawCount;
  const source =
    timelineData?.resolvedSource && timelineData.resolvedSource !== timelineData.source
      ? `Source ${timelineData.resolvedSource} used`
      : null;
  els.replayStatus.textContent = [
    `${state.replay.events.length} action(s) ready for replay`,
    rawCount != null ? `${rawCount} raw updates` : null,
    source,
  ]
    .filter(Boolean)
    .join(" - ");
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

function labelFor(flag) {
  return (
    {
      goal: "Goal",
      penalty: "Penalty",
      free_kick: "Free kick",
      corner: "Corner",
      red_card: "Red",
      yellow_card: "Yellow",
      possession: "Possession",
      discarded: "Void",
      var: "VAR",
      error: "Error",
      update: "Update",
    }[flag] || flag
  );
}

function gameKindLabel(kind) {
  return (
    {
      game_created: "Room",
      colony_created: "Colony",
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

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
