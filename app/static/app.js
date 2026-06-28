const state = {
  fixtures: [],
  selected: null,
  game: {
    id: null,
    stream: null,
    events: [],
    colonyCount: 0,
    status: null,
    activeOpportunities: [],
    agentUsage: null,
  },
};

const els = {
  healthBadge: document.querySelector("#healthBadge"),
  fixtureCount: document.querySelector("#fixtureCount"),
  refreshFixtures: document.querySelector("#refreshFixtures"),
  fixtureFilters: document.querySelector("#fixtureFilters"),
  fixtureMode: document.querySelector("#fixtureMode"),
  fixtureDays: document.querySelector("#fixtureDays"),
  fixtureDate: document.querySelector("#fixtureDate"),
  competitionId: document.querySelector("#competitionId"),
  fixtureSearch: document.querySelector("#fixtureSearch"),
  fixturesBody: document.querySelector("#fixturesBody"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  scoreBox: document.querySelector("#scoreBox"),
  manualFixture: document.querySelector("#manualFixture"),
  manualFixtureId: document.querySelector("#manualFixtureId"),
  createGame: document.querySelector("#createGame"),
  startGameReplay: document.querySelector("#startGameReplay"),
  rerunGame: document.querySelector("#rerunGame"),
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
};

const today = new Date().toISOString().slice(0, 10);
els.fixtureDate.value = today;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  updateFixtureFilterState();
  await checkHealth();
  await loadFixtures();
});

function bindEvents() {
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
  els.startGameReplay.addEventListener("click", startGameReplay);
  els.rerunGame.addEventListener("click", rerunGame);
  els.colonyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addColony();
  });
}

function updateFixtureFilterState() {
  const mode = els.fixtureMode.value;
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
  const mode = els.fixtureMode.value;
  const params = new URLSearchParams();
  if (els.competitionId.value) params.set("competition_id", els.competitionId.value);
  if (els.fixtureSearch.value.trim()) params.set("search", els.fixtureSearch.value.trim());

  let endpoint = "/api/fixtures/recent";
  if (mode === "recent") {
    params.set("days", els.fixtureDays.value || "3");
    params.set("limit", "100");
  } else if (mode === "upcoming") {
    endpoint = "/api/fixtures/upcoming";
    params.set("days", els.fixtureDays.value || "14");
    params.set("limit", "100");
    if (els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  } else {
    endpoint = "/api/fixtures";
    if (els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  }

  try {
    const data = await getJson(`${endpoint}?${params.toString()}`);
    state.fixtures = data.fixtures || [];
    els.fixtureCount.textContent = fixtureCountLabel(mode, data);
    renderFixtures();
  } catch (error) {
    state.fixtures = [];
    els.fixtureCount.textContent = "Error";
    setFixtureRows([{ error: error.message }]);
  }
}

function fixtureCountLabel(mode, data) {
  const count = data.count || 0;
  if (mode === "recent") return `${count} completed match(es)`;
  if (mode === "upcoming") return `${count} upcoming match(es)`;
  return `${count} match(es)`;
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
          <div class="muted">ID ${escapeHtml(fixture.competitionId || "-")}</div>
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
  resetGameUi();
  state.selected = fixture;
  els.manualFixtureId.value = fixture.fixtureId || "";
  els.selectedTitle.textContent = `${fixture.participant1 || "Participant 1"} - ${fixture.participant2 || "Participant 2"}`;
  els.selectedMeta.textContent = `${fixture.competition || "Unknown competition"} - Fixture ${fixture.fixtureId}`;
  updateScore(fixture.score);
  renderFixtures();
  updateGameActions();
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

async function startGameReplay() {
  if (!state.game.id) return;
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

async function rerunGame() {
  if (!state.game.id) return;
  els.gameStatus.textContent = "Rerunning simulation...";
  closeGameStream();
  try {
    const game = await postJson(`/api/games/${state.game.id}/rerun`, {
      mode: "replay",
      source: "historical",
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
  els.gameStatus.textContent = "Create a room from the selected match.";
  els.gameLeaderboard.innerHTML = `<p class="empty">No colony.</p>`;
  els.gameFeed.innerHTML = `<li class="empty">Automatic decisions will appear here.</li>`;
  renderSimulationSummary(null);
  updateGameActions();
}

function renderGameState(game) {
  if (!game) return;
  const colonies = game.colonies || [];
  state.game.id = game.gameId || state.game.id;
  state.game.colonyCount = colonies.length;
  state.game.status = game.status || null;
  state.game.activeOpportunities = game.activeOpportunities || [];
  state.game.agentUsage = game.agentUsage || state.game.agentUsage;
  updateScore(game.match?.score);
  updateGameActions();
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
  const status = state.game.status || "created";
  const running = ["running_replay", "running_live"].includes(status);
  const locked = running || status === "finished";
  const hasColony = state.game.colonyCount > 0;
  els.createGame.disabled = hasRoom && !["finished", "error", "stopped"].includes(status);
  els.addColony.disabled = !hasRoom || locked;
  els.startGameReplay.disabled = !hasRoom || locked || !hasColony;
  els.rerunGame.disabled = !hasRoom || !hasColony || !["finished", "error", "stopped"].includes(status);
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
      <span class="event-desc">${escapeHtml(event.message || "Game update")}</span>
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
