const state = {
  fixtures: [],
  selected: null,
  source: "historical",
  liveSource: null,
  timelineEvents: [],
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
  fixtureDate: document.querySelector("#fixtureDate"),
  competitionId: document.querySelector("#competitionId"),
  fixtureSearch: document.querySelector("#fixtureSearch"),
  fixturesBody: document.querySelector("#fixturesBody"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  scoreBox: document.querySelector("#scoreBox"),
  manualFixture: document.querySelector("#manualFixture"),
  manualFixtureId: document.querySelector("#manualFixtureId"),
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
  els.competitionId.addEventListener("change", loadFixtures);
  els.fixtureDate.addEventListener("change", loadFixtures);
  els.manualFixture.addEventListener("submit", (event) => {
    event.preventDefault();
    const fixtureId = Number(els.manualFixtureId.value);
    if (!fixtureId) return;
    selectFixture({ fixtureId, participant1: null, participant2: null, competition: "Manuel" });
    loadTimeline();
  });
  els.loadTimeline.addEventListener("click", loadTimeline);
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
}

async function checkHealth() {
  try {
    const health = await getJson("/health");
    els.healthBadge.className = health.txlineConfigured ? "badge badge-ok" : "badge badge-error";
    els.healthBadge.textContent = health.txlineConfigured ? "TXLine configure" : "Credentials manquants";
  } catch (error) {
    els.healthBadge.className = "badge badge-error";
    els.healthBadge.textContent = "Backend indisponible";
  }
}

async function loadFixtures() {
  setFixtureRows([{ loading: true }]);
  const params = new URLSearchParams();
  if (els.fixtureDate.value) params.set("date", els.fixtureDate.value);
  if (els.competitionId.value) params.set("competition_id", els.competitionId.value);
  if (els.fixtureSearch.value.trim()) params.set("search", els.fixtureSearch.value.trim());

  try {
    const data = await getJson(`/api/fixtures?${params.toString()}`);
    state.fixtures = data.fixtures || [];
    els.fixtureCount.textContent = `${data.count || 0} match(s)`;
    renderFixtures();
  } catch (error) {
    state.fixtures = [];
    els.fixtureCount.textContent = "Erreur";
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
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">Aucun match trouve.</td></tr>`;
    return;
  }
  const first = rows[0];
  if (first.loading) {
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">Chargement...</td></tr>`;
    return;
  }
  if (first.error) {
    els.fixturesBody.innerHTML = `<tr><td colspan="3" class="empty">${escapeHtml(first.error)}</td></tr>`;
  }
}

function selectFixture(fixture) {
  stopReplay();
  state.selected = fixture;
  els.manualFixtureId.value = fixture.fixtureId || "";
  els.selectedTitle.textContent = `${fixture.participant1 || "Participant 1"} - ${fixture.participant2 || "Participant 2"}`;
  els.selectedMeta.textContent = `${fixture.competition || "Competition inconnue"} - Fixture ${fixture.fixtureId}`;
  els.scoreBox.textContent = "-";
  renderFixtures();
}

async function loadTimeline() {
  stopReplay();
  if (!state.selected?.fixtureId) {
    prepareReplay([]);
    renderEvents(els.timeline, [], "Selectionne un match d'abord.");
    return;
  }

  prepareReplay([]);
  els.timeline.innerHTML = `<li class="empty">Chargement de la timeline...</li>`;
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
    renderEvents(els.timeline, state.timelineEvents, "Aucun moment fort trouve pour cette source.");
    prepareReplay(state.timelineEvents, data);
    return state.timelineEvents;
  } catch (error) {
    state.timelineEvents = [];
    prepareReplay([]);
    renderEvents(els.timeline, [], error.message);
    return [];
  }
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

  els.intervalTimeline.innerHTML = `<li class="empty">Chargement de l'intervalle...</li>`;
  try {
    const data = await getJson(`/api/scores/interval?${params.toString()}`);
    renderEvents(els.intervalTimeline, data.events || [], "Aucun moment fort trouve dans cet intervalle.");
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
    ? `Connecte sur fixture ${state.selected.fixtureId}`
    : "Connecte sur tous les matchs";
  els.startLive.disabled = true;
  els.stopLive.disabled = false;
  els.liveFeed.innerHTML = "";

  state.liveSource.onopen = () => {
    els.liveStatus.textContent = "Connecte, en attente d'events";
  };
  state.liveSource.addEventListener("score", (event) => {
    const item = JSON.parse(event.data);
    prependLiveEvent(item);
  });
  state.liveSource.addEventListener("heartbeat", () => {
    els.liveStatus.textContent = "Flux actif";
  });
  state.liveSource.addEventListener("txline_error", (event) => {
    const message = event.data ? JSON.parse(event.data).detail : "Flux interrompu";
    prependLiveEvent({ description: message, highlights: ["error"], fixtureId: "-" });
    els.liveStatus.textContent = "Erreur flux";
  });
  state.liveSource.onerror = () => {
    els.liveStatus.textContent = "Reconnexion...";
  };
}

function stopLive() {
  if (state.liveSource) {
    state.liveSource.close();
    state.liveSource = null;
  }
  els.liveStatus.textContent = "Flux arrete";
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
    els.replayStatus.textContent = `Replay termine (${state.replay.events.length}/${state.replay.events.length}).`;
    return;
  }

  state.replay.index += 1;
  renderReplayFrame();
  state.replay.timer = window.setTimeout(stepReplay, state.replay.speedMs);
}

function renderReplayFrame() {
  const visibleEvents = state.replay.events.slice(0, state.replay.index);
  const currentEvent = visibleEvents[visibleEvents.length - 1];
  renderEvents(els.timeline, visibleEvents, "Replay pret.", { currentIndex: visibleEvents.length - 1 });
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
    ? `Replay pret (0/${state.replay.events.length}).`
    : "Charge une timeline pour lancer le replay.";
  renderEvents(els.timeline, state.timelineEvents, "Aucune timeline chargee.");
}

function seekReplay(index) {
  state.replay.index = Math.max(0, Math.min(index, state.replay.events.length));
  if (state.replay.index === 0) {
    renderEvents(els.timeline, [], "Replay au debut. Appuie sur Play.");
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
    els.replayStatus.textContent = "Charge une timeline pour lancer le replay.";
    return;
  }

  const rawCount = timelineData?.rawCount;
  const source =
    timelineData?.resolvedSource && timelineData.resolvedSource !== timelineData.source
      ? `Source ${timelineData.resolvedSource} utilisee`
      : null;
  els.replayStatus.textContent = [
    `${state.replay.events.length} action(s) pretes pour le replay`,
    rawCount != null ? `${rawCount} updates bruts` : null,
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

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function labelFor(flag) {
  return (
    {
      goal: "But",
      penalty: "Penalty",
      free_kick: "Coup franc",
      corner: "Corner",
      red_card: "Rouge",
      yellow_card: "Jaune",
      possession: "Possession",
      var: "VAR",
      error: "Erreur",
      update: "Update",
    }[flag] || flag
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
