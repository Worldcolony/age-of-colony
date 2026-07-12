// WorldColony — HUD: top stats, inspector, thoughts, transport, hotbar, banners
window.DN = window.DN || {};

DN.hud = (function () {
  const H = {};
  const $ = id => document.getElementById(id);
  function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }
  function cap(s) { return s.replace(/^./, c => c.toUpperCase()); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  // Shared inspector helpers live at module scope because the inspector is
  // rendered outside initBackendControl(). Keeping private copies inside that
  // initializer made wallet colonies and forecast-bearing ants throw a
  // ReferenceError as soon as they were selected.
  function shortPubkey(pubkey) {
    const value = String(pubkey || '');
    return value.length <= 12 ? value : value.slice(0, 4) + '…' + value.slice(-4);
  }

  function currentSelectedGame() {
    const select = document.getElementById('forecast-game');
    const key = select && select.value;
    const games = (DN.databridge && DN.databridge.forecastGames) || [];
    return games.find((game) =>
      game && (game.market_key === key || game.match_id === key || game.id === key)
    ) || {};
  }

  function inspectorMarketLabels(source) {
    const supplied = source && source.match;
    const match = supplied && typeof supplied === 'object' ? supplied : {};
    const selected = currentSelectedGame();
    return {
      home: match.home_team || match.team1 || match.team_a || selected.home_team || 'Team A',
      draw: 'Draw',
      away: match.away_team || match.team2 || match.team_b || selected.away_team || 'Team B',
    };
  }

  function inspectorMarketSideLabel(side, source) {
    const labels = inspectorMarketLabels(source);
    if (side === 'pass') return 'No stake';
    return labels[side] || String(side || 'unknown');
  }

  function inspectorQualitativeLean(homeProbability, source) {
    if (homeProbability == null) return '-';
    const value = Number(homeProbability);
    if (!Number.isFinite(value)) return '-';
    const labels = inspectorMarketLabels(source);
    if (value >= 0.62) return 'strong ' + labels.home;
    if (value >= 0.54) return 'soft ' + labels.home;
    if (value <= 0.38) return 'strong ' + labels.away;
    if (value <= 0.46) return 'soft ' + labels.away;
    return 'balanced';
  }

  const ICON = {
    forage: '<svg viewBox="0 0 24 24"><path d="M4 18c4-1 4-6 8-6s4 5 8 4"/><circle cx="4" cy="18" r="1.4"/><circle cx="20" cy="16" r="1.4"/></svg>',
    defend: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4"/></svg>'
  };
  const HOTBAR = [
    { id: 'world', name: 'World', svg: '<path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/><circle cx="12" cy="12" r="9"/>' },
    { id: 'colonies', name: 'Colonies', svg: '<path d="M4 20l4-11 4 11M12 20l4-9 4 9"/><circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="8" r="1.5"/>' },
    { id: 'agents', name: 'Agents', svg: '<circle cx="12" cy="7" r="3"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>' },
    { id: 'economy', name: 'Economy', svg: '<circle cx="12" cy="12" r="8"/><path d="M9 9.5C9 8 10.3 7.5 12 7.5s3 .8 3 2-1.3 1.8-3 2-3 .8-3 2 1.3 2 3 2 3-.6 3-2M12 6v1.5M12 16.5V18"/>' },
    { id: 'forecasts', name: 'Forecasts', svg: '<path d="M4 16l4-5 4 3 6-8"/><path d="M14 6h4v4"/>' },
    { id: 'lineages', name: 'Lineages', svg: '<circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4M12 11l-6 6M12 11l6 6"/>' }
  ];

  H.init = function () {
    // hotbar
    $('hotbar').innerHTML = HOTBAR.map((s, i) =>
      `<div class="slot${i === 0 ? ' active' : ''}" data-lens="${s.id}" data-idx="${i}">
        <span class="sl-key">${i + 1}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${s.svg}</svg>
        <span class="sl-name">${s.name}</span></div>`).join('');
    $('hotbar').querySelectorAll('.slot').forEach(el => el.addEventListener('click', () => DN.app.setLens(parseInt(el.dataset.idx))));
    // region selector
    $('regions').innerHTML = '<div class="reg-title">Region</div>' + DN.biomes.map((b, i) =>
      `<div class="reg${i === 0 ? ' active' : ''}" data-i="${i}"><span class="reg-dot" style="background:${hex(b.ground.grass)};color:${hex(b.ground.grass)}"></span><div class="reg-tx"><div class="reg-name">${b.name}</div><div class="reg-tag">${b.tag}</div></div></div>`).join('');
    $('regions').querySelectorAll('.reg').forEach(el => el.addEventListener('click', () => DN.app.setBiome(parseInt(el.dataset.i))));
    initBackendControl();
    initWalletControl();
    H.clearInspector();
    // MVP polish: strip every persistent HUD chrome element except the
    // backend pill (Run button), exit-banner, and the bottom log
    // terminal. The user wants a minimal "3D + terminal" surface.
    // NOTE: do NOT include `inspector` here — CSS hides it by default
    // and `.has-content` (added by H.showAnt / H.showColony) shows it.
    // Forcing inline display:none here would beat that toggle.
    ['hotbar', 'transport', 'thoughts', 'cammode', 'keys', 'regions', 'brand', 'stats'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
    return H;
  };

  function initBackendControl() {
    const root = $('backend');
    if (!root) return;
    // Collapsed control surface: the primary `Run` button plus the Match
    // dropdown stay always visible. The debug buttons (Get ants / Get
    // KG / Deploy / Buy KG / Stake / Settle) live
    // inside a `▾ Advanced` disclosure so the chrome stays clean.
    root.innerHTML =
      '<div class="backend-copy"><div class="backend-k">Backend</div><div class="backend-s" id="backend-status">Railway linked</div></div>' +
      '<div class="backend-actions">' +
        '<select class="forecast-select" id="forecast-game-scope" aria-label="Game scope">' +
          '<option value="upcoming">Upcoming</option>' +
          '<option value="previous">Previous test</option>' +
        '</select>' +
        '<select class="forecast-game-select" id="forecast-game" aria-label="Game">' +
          '<option value="match:world_cup_2026:013:2026_06_13_brazil_morocco">Brazil vs Morocco</option>' +
        '</select>' +
        '<select class="forecast-select" id="forecast-winner" aria-label="Winner">' +
          '<option value="Brazil">Brazil</option>' +
          '<option value="Draw">Draw</option>' +
          '<option value="Morocco">Morocco</option>' +
        '</select>' +
        '<button class="backend-btn secondary" id="backend-scout">Run KG</button>' +
        '<button class="backend-btn" id="backend-run">Run Full Pipe</button>' +
        '<button class="backend-btn secondary" id="backend-run-fast">Run Agent</button>' +
        '<button class="backend-btn secondary" id="backend-runs">Runs</button>' +
        '<button class="backend-btn secondary" id="backend-reset" title="Stop the running debate and reset agents to idle">Reset</button>' +
        '<button class="backend-btn secondary backend-toggle" id="backend-adv-toggle" title="Show advanced controls">▾</button>' +
      '</div>' +
      '<div class="kg-plugin-panel" id="kg-plugin-panel">' +
        '<div class="kg-plugin-head"><span>KG plugins</span><span id="kg-plugin-summary">loading</span></div>' +
        '<div class="kg-plugin-list" id="kg-plugin-list">Loading plugins...</div>' +
        '<div class="kg-plugin-options">' +
          '<label>Mode <select class="forecast-select" id="kg-run-mode"><option value="fast">fast</option><option value="deep">deep</option></select></label>' +
          '<label>Timeout <input class="kg-timeout-input" id="kg-run-timeout" type="number" min="5" max="300" step="5" value="120"></label>' +
        '</div>' +
      '</div>' +
      '<div class="colony-control-panel" id="colony-control-panel">' +
        '<div class="kg-plugin-head"><span>Colony</span><span id="colony-summary">connect wallet</span></div>' +
        '<div class="colony-options">' +
          '<label>Ants <select class="forecast-select" id="colony-ant-count"><option value="50">50</option><option value="100">100</option><option value="200">200</option></select></label>' +
          '<label>Preset <select class="forecast-select" id="colony-preset"><option value="market">market</option><option value="scout">scout</option><option value="quant">quant</option></select></label>' +
          '<label>Risk <select class="forecast-select" id="colony-risk"><option value="balanced">balanced</option><option value="cautious">cautious</option><option value="aggressive">aggressive</option></select></label>' +
          '<label>Model <select class="forecast-select" id="colony-model"><option value="mixed">mixed</option><option value="parametric">parametric</option><option value="MiniMax-M2.7">MiniMax-M2.7</option><option value="MiniMax-M3">MiniMax-M3</option><option value="deepseek-v3.2">deepseek-v3.2</option><option value="claude-haiku">claude-haiku</option><option value="qwen-3">qwen-3</option></select></label>' +
        '</div>' +
        '<div class="colony-actions">' +
          '<button class="backend-btn" id="colony-create">Create</button>' +
          '<button class="backend-btn secondary" id="colony-add-ants">Add ants</button>' +
          '<button class="backend-btn secondary" id="colony-list-ants">List</button>' +
          '<button class="backend-btn secondary" id="colony-run">Run all</button>' +
          '<button class="backend-btn secondary" id="colony-remove">Delete colony</button>' +
        '</div>' +
        '<div class="colony-ant-editor">' +
          '<input class="colony-ant-input" id="colony-ant-id" type="text" value="ant_0000" aria-label="Ant ID">' +
          '<select class="forecast-select" id="colony-ant-status" aria-label="Ant status"><option value="alive">alive</option><option value="dead">dead</option><option value="inactive">inactive</option><option value="retired">retired</option></select>' +
          '<button class="backend-btn secondary" id="colony-update-ant">Update</button>' +
        '</div>' +
        '<div class="colony-preview" id="colony-preview">No colony loaded for connected wallet.</div>' +
        '<div class="colony-ant-list" id="colony-ant-list"></div>' +
      '</div>' +
      '<div class="backend-advanced" id="backend-advanced" style="display:none;gap:6px;margin-top:6px;flex-wrap:wrap">' +
        '<button class="backend-btn secondary" id="backend-ants">Get ants</button>' +
        '<button class="backend-btn secondary" id="backend-kg">Get KG</button>' +
        '<button class="backend-btn secondary" id="forecast-deploy">Deploy</button>' +
        '<button class="backend-btn secondary" id="x402-buy">Buy KG</button>' +
        '<button class="backend-btn secondary" id="forecast-setup">Stake</button>' +
        '<button class="backend-btn secondary" id="forecast-settle">Settle</button>' +
      '</div>';
    const advToggle = $('backend-adv-toggle');
    const advTray = $('backend-advanced');
    if (advToggle && advTray) {
      advToggle.addEventListener('click', () => {
        const open = advTray.style.display !== 'none';
        advTray.style.display = open ? 'none' : 'flex';
        advToggle.textContent = open ? '▾' : '▴';
      });
    }
    const btn = $('backend-run');
    const fastBtn = $('backend-run-fast');
    const antsBtn = $('backend-ants');
    const kgBtn = $('backend-kg');
    const scoutBtn = $('backend-scout');
    const runsBtn = $('backend-runs');
    const forecastDeployBtn = $('forecast-deploy');
    const x402BuyBtn = $('x402-buy');
    const forecastSetupBtn = $('forecast-setup');
    const forecastSettleBtn = $('forecast-settle');
    const forecastWinner = $('forecast-winner');
    const forecastGameScope = $('forecast-game-scope');
    const forecastGame = $('forecast-game');
    const status = $('backend-status');
    const kgPluginPanel = $('kg-plugin-panel');
    const kgPluginList = $('kg-plugin-list');
    const kgPluginSummary = $('kg-plugin-summary');
    const kgRunMode = $('kg-run-mode');
    const kgRunTimeout = $('kg-run-timeout');
    const colonySummary = $('colony-summary');
    const colonyPreview = $('colony-preview');
    const colonyAntList = $('colony-ant-list');
    const colonyAntCount = $('colony-ant-count');
    const colonyPreset = $('colony-preset');
    const colonyRisk = $('colony-risk');
    const colonyModel = $('colony-model');
    const colonyCreateBtn = $('colony-create');
    const colonyAddAntsBtn = $('colony-add-ants');
    const colonyListAntsBtn = $('colony-list-ants');
    const colonyRunBtn = $('colony-run');
    const colonyRemoveBtn = $('colony-remove');
    const colonyAntId = $('colony-ant-id');
    const colonyAntStatus = $('colony-ant-status');
    const colonyUpdateAntBtn = $('colony-update-ant');
    const colonyOptions = root.querySelector('.colony-options');
    const colonyAntEditor = root.querySelector('.colony-ant-editor');
    const forecastCfg = (window.DN_CONFIG && window.DN_CONFIG.FORECAST) || {};
    const configuredKgRun = (window.DN_CONFIG && window.DN_CONFIG.KG_RUN) || {};
    let kgPluginCatalog = [];
    let forecastContract = forecastCfg.CONTRACT || '';
    let forecastMarketKey = '';
    let forecastStakes = [];
    let colonyBusy = false;
    let forecastGamesHavePreviousTestData = false;
    let previousTestGamesPromise = null;
    let lastColonyPayload = null;
    let lastRunResults = null;
    let selectedGame = {
      match_id: 'match:world_cup_2026:013:2026_06_13_brazil_morocco',
      market_key: 'match:world_cup_2026:013:2026_06_13_brazil_morocco',
      market_type: 'three_way',
      home_team: forecastCfg.HOME_TEAM || 'Brazil',
      away_team: forecastCfg.AWAY_TEAM || 'Morocco',
      name: (forecastCfg.HOME_TEAM || 'Brazil') + ' vs ' + (forecastCfg.AWAY_TEAM || 'Morocco'),
    };

    function todayIsoDate() {
      try {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
      } catch (err) {
        return '2026-06-23';
      }
    }

    function gameKey(game) {
      return String((game && (game.market_key || game.match_id || game.id || game.name)) || '');
    }

    function isGroupStageGame(game) {
      return Boolean(game && game.group && game.date);
    }

    function selectedGameScope() {
      return forecastGameScope ? forecastGameScope.value : 'upcoming';
    }

    function isPreviousGameScope() {
      return selectedGameScope() === 'previous';
    }

    function hasPreviousTestData(game) {
      return Boolean(game && game.has_previous_test_data && game.previous_test_data);
    }

    function hasBenchmarkSnapshotData(game) {
      const data = (game && game.previous_test_data) || {};
      return Boolean(hasPreviousTestData(game) && data.snapshot_id);
    }

    function isPreviousTestGame(game) {
      return isGroupStageGame(game) && game.date < todayIsoDate() && hasBenchmarkSnapshotData(game);
    }

    function updateColonyRunButtonLabel() {
      if (!colonyRunBtn) return;
      colonyRunBtn.textContent = isPreviousGameScope() ? 'Run with colony' : 'Run all';
      if (!colonyBusy) colonyRunBtn.disabled = isPreviousGameScope() && !hasBenchmarkSnapshotData(selectedGame);
    }

    function updatePreviousModeChrome() {
      const previous = isPreviousGameScope();
      const display = (el, show) => { if (el) el.style.display = show ? '' : 'none'; };
      display(forecastWinner, !previous);
      display(scoutBtn, !previous);
      display(btn, !previous);
      display(fastBtn, !previous);
      display(kgPluginPanel, !previous);
      display(advToggle, !previous);
      if (advTray) {
        advTray.style.display = previous ? 'none' : advTray.style.display;
        if (previous && advToggle) advToggle.textContent = '▾';
      }
      if (runsBtn) runsBtn.textContent = previous ? 'Results' : 'Runs';
      display(colonyOptions, !previous);
      display(colonyAddAntsBtn, !previous);
      display(colonyListAntsBtn, !previous);
      display(colonyRemoveBtn, !previous);
      display(colonyAntEditor, !previous);
      display(colonyAntList, !previous);
      const hasColony = Boolean(lastColonyPayload && lastColonyPayload.colony);
      display(colonyCreateBtn, !previous || !hasColony);
      updateColonyRunButtonLabel();
    }

    function selectedPrematchSnapshotId() {
      const data = (selectedGame && selectedGame.previous_test_data) || {};
      return String(data.snapshot_id || '');
    }

    function sortGamesForScope(games, scope) {
      return games.slice().sort((a, b) => {
        const ak = [a.date || '', a.time || '', a.name || ''].join(' ');
        const bk = [b.date || '', b.time || '', b.name || ''].join(' ');
        return scope === 'previous' ? bk.localeCompare(ak) : ak.localeCompare(bk);
      });
    }

    function forecastGameLabel(game, scope) {
      const parts = [game.date, game.time, game.name].filter(Boolean);
      if (game.score) parts.push('score ' + game.score);
      else if (scope === 'previous') {
        const testData = game.previous_test_data || {};
        const docs = Number(testData.usable_document_count || 0);
        const claims = Number(testData.evidence_claim_count || 0);
        parts.push(docs || claims ? 'test ' + docs + ' docs / ' + claims + ' claims' : 'test data');
      }
      return parts.join(' - ');
    }

    function gamesForScope(games, scope) {
      const filtered = scope === 'previous'
        ? games.filter(isPreviousTestGame)
        : games.filter(isUpcomingGroupStage);
      if (scope === 'previous') return sortGamesForScope(filtered, scope);
      return sortGamesForScope(filtered.length ? filtered : games, scope);
    }

    function renderForecastGames(scope, preferred) {
      if (!forecastGame) return;
      const games = (DN.databridge && DN.databridge.forecastGames) || [];
      const visibleGames = gamesForScope(games, scope || 'upcoming');
      if (!visibleGames.length) {
        forecastGame.innerHTML = '<option value="">' + (scope === 'previous' ? 'No saved test data' : 'No games available') + '</option>';
        forecastGame.disabled = true;
        if (scope === 'previous') selectedGame = Object.assign({}, selectedGame, { has_previous_test_data: false, previous_test_data: null });
        if (scope === 'previous') status.textContent = 'No saved test data';
        updateWinnerOptions();
        updatePreviousModeChrome();
        return;
      }
      forecastGame.disabled = false;
      forecastGame.innerHTML = visibleGames.slice(0, 104).map((game) =>
        '<option value="' + esc(gameKey(game)) + '">' + esc(forecastGameLabel(game, scope || 'upcoming')) + '</option>'
      ).join('');
      const currentKey = gameKey(selectedGame);
      const preferredKey = gameKey(preferred);
      const chosen = visibleGames.find((game) => gameKey(game) === currentKey) ||
        visibleGames.find((game) => gameKey(game) === preferredKey) ||
        (scope === 'previous' ? visibleGames.find((game) => /France vs Iraq/i.test(game.name || '')) : null) ||
        visibleGames[0] ||
        preferred;
      if (!chosen) return;
      selectedGame = chosen;
      forecastGame.value = gameKey(selectedGame);
      updateWinnerOptions();
      updatePreviousModeChrome();
    }

    function loadPreviousTestGames() {
      if (forecastGamesHavePreviousTestData) return Promise.resolve({ games: (DN.databridge && DN.databridge.forecastGames) || [] });
      if (previousTestGamesPromise) return previousTestGamesPromise;
      if (!DN.databridge || !DN.databridge.fetchForecastGames) {
        return Promise.reject(new Error('Forecast games API is not available.'));
      }
      if (forecastGame) {
        forecastGame.disabled = true;
        forecastGame.innerHTML = '<option value="">Loading saved test data...</option>';
      }
      if (colonyRunBtn) colonyRunBtn.disabled = true;
      status.textContent = 'Loading saved tests...';
      previousTestGamesPromise = DN.databridge.fetchForecastGames({ includePreviousTestData: true })
        .then((payload) => {
          forecastGamesHavePreviousTestData = Boolean(payload && payload.include_previous_test_data);
          return payload;
        })
        .finally(() => {
          previousTestGamesPromise = null;
        });
      return previousTestGamesPromise;
    }

    function fallbackKgModules() {
      const modules = configuredKgRun.modules || ['fixture', 'public_x', 'polymarket_market_context', 'wikidata_profiles'];
      return modules.map((id, index) => ({
        id,
        display_name: id.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()),
        description: 'Configured frontend KG plugin.',
        claim_types: [],
        configured: true,
        default_enabled: true,
        ui_order: index,
      }));
    }

    function renderKgPlugins(payload) {
      const defaults = (payload && payload.defaults) || configuredKgRun || {};
      kgPluginCatalog = (payload && payload.modules && payload.modules.length ? payload.modules : fallbackKgModules())
        .filter((module) => module && module.id);
      const selectedDefaults = new Set(defaults.modules || configuredKgRun.modules || kgPluginCatalog.filter((module) => module.default_enabled).map((module) => module.id));
      if (kgRunMode) kgRunMode.value = defaults.mode || configuredKgRun.mode || 'fast';
      if (kgRunTimeout) kgRunTimeout.value = defaults.timeout || configuredKgRun.timeout || 120;
      if (!kgPluginList) return;
      kgPluginList.innerHTML = kgPluginCatalog.map((module) => {
        const disabled = module.configured === false;
        const checked = !disabled && selectedDefaults.has(module.id);
        const claims = (module.claim_types || []).slice(0, 4).join(', ');
        const missing = disabled ? module.setup_hint || module.missing_env?.join(', ') || 'setup required' : claims;
        return '<label class="kg-plugin-row' + (disabled ? ' disabled' : '') + '" title="' + esc(module.description || '') + '">' +
          '<input type="checkbox" value="' + esc(module.id) + '" ' + (checked ? 'checked ' : '') + (disabled ? 'disabled ' : '') + '>' +
          '<span class="kg-plugin-name">' + esc(module.display_name || module.id) + '</span>' +
          '<span class="kg-plugin-meta">' + esc(missing || module.source_family || '') + '</span>' +
        '</label>';
      }).join('');
      kgPluginList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener('change', updateKgPluginSummary);
      });
      updateKgPluginSummary();
    }

    function selectedKgModules(opts) {
      if (!kgPluginList) return (configuredKgRun.modules || ['fixture']).slice();
      const selected = Array.from(kgPluginList.querySelectorAll('input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
      if (selected.length) return selected;
      return opts && opts.allowEmpty ? [] : ['fixture'];
    }

    function updateKgPluginSummary() {
      const selected = selectedKgModules({ allowEmpty: true });
      if (kgPluginSummary) kgPluginSummary.textContent = selected.length + ' selected';
      if (scoutBtn) scoutBtn.disabled = selected.length === 0;
    }

    function buildKgRunPayload(modules) {
      const selected = modules || selectedKgModules({ allowEmpty: true });
      const kgDefaults = Object.assign(
        {
          mode: 'fast',
          modules: selected,
          timeout: 120,
          camel_agents: 4,
        },
        (window.DN_CONFIG && window.DN_CONFIG.KG_RUN) || {},
      );
      kgDefaults.modules = selected;
      if (kgRunMode && kgRunMode.value) kgDefaults.mode = kgRunMode.value;
      if (kgRunTimeout && kgRunTimeout.value) kgDefaults.timeout = Number(kgRunTimeout.value) || kgDefaults.timeout;
      return Object.assign({}, kgDefaults, {
        match: selectedGame.name,
        match_id: selectedGame.match_id || selectedGame.market_key,
      });
    }

    function buildFallbackScoutingPayload() {
      return {
        match: selectedGame.name,
        match_id: selectedGame.match_id || selectedGame.market_key,
        data_mode: 'public',
        refresh_data: false,
        include_x: true,
        include_camel: false,
        include_deepseek_scout: false,
        agents: 4,
        rooms: 1,
        voice_mode: 'template',
        agent_wallets: false,
      };
    }

    function startSelectedKgRun(contextLabel) {
      if (!DN.databridge || !(DN.databridge.startKgRun || DN.databridge.startScoutingRun)) {
        return Promise.reject(new Error('KG API is not available.'));
      }
      const modules = selectedKgModules({ allowEmpty: true });
      if (!modules.length) return Promise.reject(new Error('Select at least one KG plugin before running.'));
      const kgPayload = buildKgRunPayload(modules);
      const fallbackScoutingPayload = buildFallbackScoutingPayload();
      const starter = DN.databridge.startKgRun || DN.databridge.startScoutingRun;
      status.textContent = contextLabel === 'all' ? 'Run all · KG...' : 'KG run...';
      H.pushThought('KG run started for ' + selectedGame.name + ' with ' + modules.length + ' plugins.', 'Backend', '#3FA89F');
      if (DN.logTerm) {
        DN.logTerm.push('KG', (contextLabel === 'all' ? 'Run all KG step' : 'KG-only run') + ' kicked off for ' + selectedGame.name + ' · ' + modules.join(', ') + '.');
      }
      if (DN.kgview && DN.kgview.showScoutingProgress) {
        DN.kgview.showScoutingProgress({
          match: selectedGame.name,
          matchId: selectedGame.match_id || selectedGame.market_key,
          team: selectedGame.home_team,
          opponent: selectedGame.away_team,
        });
      }
      return starter(DN.databridge.startKgRun ? kgPayload : fallbackScoutingPayload)
        .then((result) => {
          const manifest = result.manifest || {};
          const kg = result.kg || {};
          const entities = manifest.entity_count || kg.entity_count || 0;
          const links = manifest.relationship_count || kg.relationship_count || 0;
          const ready = manifest.validation && manifest.validation.kg_load_ready === false ? 'needs review' : 'ready';
          status.textContent = 'KG ' + ready + ' · ' + entities + ' entities';
          H.pushThought('KG run finished: ' + entities + ' entities and ' + links + ' relationships.', 'Backend', '#3FA89F');
          if (DN.logTerm) DN.logTerm.push('KG', 'KG run finished' + (contextLabel === 'all' ? '; starting colony pipeline next.' : '. Opening run results.'));
          const newId = (DN.databridge && DN.databridge.runId) || null;
          if (DN.databridge && DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(newId);
          if (DN.commsViz && DN.commsViz.reset) DN.commsViz.reset();
          if (H._pollComms) H._pollComms();
          if (H.refreshRunsPage) H.refreshRunsPage(false);
          return result;
        });
    }

    function currentPubkey() {
      const w = window.DN && DN.wallet;
      return w && w.connected && w.pubkey ? w.pubkey : '';
    }

    function hashString(value) {
      let h = 0x811c9dc5;
      const text = String(value || '');
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return h >>> 0;
    }

    function selectedColonyConfig() {
      return {
        ant_count: Number(colonyAntCount && colonyAntCount.value || 50),
        preset: (colonyPreset && colonyPreset.value) || 'market',
        risk_profile: (colonyRisk && colonyRisk.value) || 'balanced',
        model_preference: (colonyModel && colonyModel.value) || 'mixed',
      };
    }

    function selectedColonyPlacement(pubkey) {
      const existing = DN.app && DN.app.findMyColony ? DN.app.findMyColony() : null;
      if (existing) {
        return {
          angle: Math.atan2(existing.pos.z, existing.pos.x),
          dist: Math.hypot(existing.pos.x, existing.pos.z),
          accent: existing.accent,
          name: existing.name,
        };
      }
      const h = hashString(pubkey);
      const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const dist = 82 + (((h >>> 16) & 0xff) / 255) * 54;
      const w = window.DN && DN.wallet;
      const accent = w && typeof w.accentColor === 'function' ? w.accentColor() : 0xB07E1C;
      return { angle, dist, accent, name: shortPubkey(pubkey) + "'s Colony" };
    }

    function renderColonySummary(payload) {
      lastColonyPayload = payload || null;
      const pubkey = currentPubkey();
      if (!pubkey) {
        if (colonySummary) colonySummary.textContent = 'connect wallet';
        if (colonyPreview) colonyPreview.textContent = 'Connect your wallet to manage a colony.';
        if (colonyAntList) colonyAntList.innerHTML = '';
        updatePreviousModeChrome();
        return;
      }
      if (!payload || !payload.colony) {
        if (colonySummary) colonySummary.textContent = 'not created';
        if (colonyPreview) colonyPreview.textContent = 'No colony for ' + shortPubkey(pubkey) + ' yet.';
        if (colonyAntList) colonyAntList.innerHTML = '';
        updatePreviousModeChrome();
        return;
      }
      const colony = payload.colony;
      const summary = payload.ant_summary || {};
      const statuses = summary.statuses || {};
      const config = colony.config || {};
      if (colonySummary) {
        colonySummary.textContent = (statuses.alive || 0) + '/' + (summary.total || 0) + ' alive';
      }
      if (colonyPreview) {
        const models = summary.models || {};
        const modelText = Object.keys(models).slice(0, 3).map((key) => key + '=' + models[key]).join(' ');
        colonyPreview.textContent =
          (colony.name || shortPubkey(pubkey)) +
          ' · ' + (config.preset || 'market') +
          ' · target ' + (config.ant_count || 50) +
          ' · ' + (modelText || 'no ants');
      }
      if (colonyAntCount && config.ant_count) colonyAntCount.value = String(config.ant_count);
      if (colonyPreset && config.preset) colonyPreset.value = String(config.preset);
      if (colonyRisk && config.risk_profile) colonyRisk.value = String(config.risk_profile);
      if (colonyModel && config.model_preference) colonyModel.value = String(config.model_preference);
      updatePreviousModeChrome();
    }

    function rosterPopulationFromPayload(payload) {
      const colony = payload && payload.colony;
      const summary = (payload && payload.ant_summary) || {};
      const statuses = summary.statuses || {};
      const config = (colony && colony.config) || {};
      const total = Number(summary.total);
      const alive = Number(statuses.alive);
      const target = Number(config.ant_count);
      const hasTotal = Number.isFinite(total) && total >= 0;
      const hasAlive = Number.isFinite(alive) && alive >= 0;
      const hasTarget = Number.isFinite(target) && target > 0;
      if (hasTotal || hasAlive || hasTarget) {
        const totalValue = hasTotal ? total : (hasAlive ? alive : null);
        const aliveValue = hasAlive ? alive : (hasTotal ? totalValue : null);
        return {
          total: totalValue,
          alive: aliveValue,
          target: hasTarget ? target : null,
          display: aliveValue,
        };
      }
      return null;
    }

    function syncWalletColonyRosterStats(col, payload) {
      const roster = rosterPopulationFromPayload(payload);
      if (!col || !roster) return col;
      const colony = (payload && payload.colony) || {};
      const summary = (payload && payload.ant_summary) || {};
      const hasDisplayPopulation = Number.isFinite(Number(roster.display));
      col._rosterLockedPopulation = true;
      col._rosterTotal = roster.total;
      col._rosterAlive = roster.alive;
      col._rosterTarget = roster.target;
      col._rosterPopulationKnown = hasDisplayPopulation;
      col._rosterPopulation = hasDisplayPopulation ? roster.display : 0;
      col._colonyConfig = colony.config || {};
      col._antSummary = summary;
      col.stats.population = col._rosterPopulation;
      if (H._updateColony) H._updateColony(col);
      return col;
    }

    function renderColonyAntList(ants) {
      if (!colonyAntList) return;
      const rows = (ants || []).map((ant) => {
        const datafeeds = (ant.datafeed_interests || []).slice(0, 3).join(', ');
        const parent = ant.parent_agent_id || '-';
        return '<button class="colony-ant-row" type="button" data-agent="' + esc(ant.agent_id || '') + '" data-status="' + esc(ant.status || 'alive') + '">' +
          '<span class="colony-ant-main"><b>' + esc(ant.agent_id || ant.name || 'ant') + '</b><i>' + esc(ant.status || 'alive') + '</i></span>' +
          '<span>' + esc(ant.model || '-') + ' · ' + esc(ant.persona || '-') + '</span>' +
          '<span>risk ' + esc(ant.risk_profile || '-') + ' · parent ' + esc(parent) + '</span>' +
          '<span>' + esc(datafeeds || 'no datafeeds') + '</span>' +
        '</button>';
      }).join('');
      colonyAntList.innerHTML = rows || '<div class="colony-ant-empty">No ants yet.</div>';
      colonyAntList.querySelectorAll('.colony-ant-row').forEach((row) => {
        row.addEventListener('click', () => {
          if (colonyAntId) colonyAntId.value = row.dataset.agent || '';
          if (colonyAntStatus) colonyAntStatus.value = row.dataset.status || 'alive';
        });
      });
    }

    function setColonyBusy(disabled) {
      colonyBusy = !!disabled;
      [colonyCreateBtn, colonyAddAntsBtn, colonyListAntsBtn, colonyRunBtn, colonyRemoveBtn, colonyUpdateAntBtn].forEach((button) => {
        if (button) button.disabled = colonyBusy;
      });
      if (colonyAntId) colonyAntId.disabled = colonyBusy;
      if (colonyAntStatus) colonyAntStatus.disabled = colonyBusy;
      if (!colonyBusy) updateColonyRunButtonLabel();
    }

    function materializeWalletColony(row) {
      if (!row || !row.pubkey || !(DN.colony && DN.colony.foundColony)) return null;
      let col = DN.app && DN.app.findMyColony ? DN.app.findMyColony() : null;
      if (!col) {
        col = DN.colony.foundColony({
          angle: Number(row.angle || 0),
          dist: Number(row.dist || 120),
          accent: Number(row.accent || 0xB07E1C),
          name: row.name || shortPubkey(row.pubkey) + "'s Colony",
          owner: row.pubkey,
          spawnAnts: false,
        });
      }
      if (col && DN.app && DN.app.selectColony) DN.app.selectColony(col);
      if (DN.minimap && DN.minimap.refresh) DN.minimap.refresh();
      return col;
    }

	    function removeWalletColonyLocal(pubkey) {
	      if (!(DN.colony && DN.colony.list)) return;
	      const index = DN.colony.list.findIndex((col) => col.owner === pubkey);
	      if (index < 0) return;
	      const col = DN.colony.list[index];
	      if (DN.ants && DN.ants.removeColony) DN.ants.removeColony(col);
	      if (col.group && col.group.parent) col.group.parent.remove(col.group);
	      if (col.pickTarget && col.pickTarget.parent) col.pickTarget.parent.remove(col.pickTarget);
	      DN.colony.list.splice(index, 1);
	      if (DN.minimap && DN.minimap.refresh) DN.minimap.refresh();
	      if (DN.hud && DN.hud.clearInspector) DN.hud.clearInspector();
	    }

    function visualColonyForRun(pubkey) {
      let col = DN.app && DN.app.findMyColony ? DN.app.findMyColony() : null;
      if (!col && lastColonyPayload && lastColonyPayload.colony) {
        col = materializeWalletColony(lastColonyPayload.colony);
      }
      if (!col) return null;
      if (DN.ants && DN.ants.addColony && !col._antMesh) {
        DN.ants.addColony(col, null);
      }
      return col;
    }

    function visualRunAnts(col, limit) {
      if (!col || !(DN.ants && DN.ants.list)) return [];
      const ants = DN.ants.list.filter((ant) =>
        ant.col === col &&
        !ant.hero &&
        ant.state !== 'dead' &&
        !ant.permanentDead
      );
      return ants.slice(0, Math.min(limit || 28, ants.length));
    }

    function runAllVisualStart(pubkey, opts) {
      const previousTest = Boolean(opts && opts.previousTest);
      const col = visualColonyForRun(pubkey);
      if (!col) return null;
      const crystal = DN.crystal && DN.crystal.position ? DN.crystal.position() : new THREE.Vector3(0, 0, 0);
      if (DN.crystal) {
        if (DN.crystal.setAccent) DN.crystal.setAccent(Number(col.accent || 0x9EE9C4));
        if (DN.crystal.show) DN.crystal.show();
        for (let i = 0; i < 18; i++) if (DN.crystal.depositOne) DN.crystal.depositOne();
      }
      if (DN.camera && DN.camera.flyTo) DN.camera.flyTo(new THREE.Vector3(0, 0, 0), 190, 120, 2.0);
      if (DN.logTerm) {
        DN.logTerm.push('PHASE', previousTest ? '── Previous test: ants loading saved KG ──' : '── Run all: ants collecting KG crystal ──');
      }

      const ants = visualRunAnts(col, 28);
      ants.forEach((ant, index) => {
        ant.cargo = 0;
        ant._runAllVisual = true;
        ant._idleWritten = false;
        DN.ants.scriptWalk(
          ant,
          col.entrance.x,
          col.entrance.z,
          crystal.x,
          crystal.z,
          {
            speed: 0.12,
            curl: 0.1,
            curlSign: index % 2 === 0 ? 1 : -1,
            tStart: -(index / Math.max(1, ants.length - 1)) * 0.35,
            onArrive: (arrived) => {
              if (DN.crystal && DN.crystal.takeOne) DN.crystal.takeOne(0.08);
              arrived.cargo = 1;
              DN.ants.scriptWalk(
                arrived,
                arrived.x,
                arrived.z,
                col.entrance.x,
                col.entrance.z,
                {
                  speed: 0.16,
                  curl: 0.06,
                  onArrive: (home) => {
                    home.cargo = 0;
                    home._runAllVisual = false;
                    home.state = 'idle';
                    home._idleWritten = false;
                  },
                }
              );
            },
          }
        );
      });
      return col;
    }

    function runAllVisualColonyStep(pubkey) {
      const col = visualColonyForRun(pubkey);
      if (!col) return null;
      if (DN.logTerm) DN.logTerm.push('PHASE', '── Run all: ants entering colony rooms ──');
      setTimeout(() => {
        if (DN.crystal && DN.crystal.hide) DN.crystal.hide();
        if (DN.app && DN.app.enterColony) DN.app.enterColony(col);
        if (DN.underground && DN.underground.startDebate) DN.underground.startDebate();
      }, 1300);
      return col;
    }

    function runAllVisualFinish() {
      if (DN.logTerm) DN.logTerm.push('PHASE', '── Run all: decision ready ──');
      if (DN.crystal && DN.crystal.hide) DN.crystal.hide();
    }

    function refreshUserColony(silent) {
      const pubkey = currentPubkey();
      if (!pubkey) {
        renderColonySummary(null);
        return Promise.resolve(null);
      }
      if (!DN.databridge || !DN.databridge.fetchUserColony) {
        renderColonySummary(null);
        return Promise.resolve(null);
      }
      return DN.databridge.fetchUserColony(pubkey)
        .then((payload) => {
          renderColonySummary(payload);
          if (payload && payload.colony) {
            syncWalletColonyRosterStats(materializeWalletColony(payload.colony), payload);
          }
          return payload;
        })
        .catch((err) => {
          renderColonySummary(null);
          if (!silent) H.pushThought('Could not load colony: ' + (err.message || err), 'Colony', '#D96E54');
          return null;
        });
    }

    function loadKgPlugins() {
      if (!DN.databridge || !DN.databridge.fetchKgModules) {
        renderKgPlugins(null);
        return Promise.resolve(null);
      }
      return DN.databridge.fetchKgModules()
        .then((payload) => {
          renderKgPlugins(payload);
          return payload;
        })
        .catch((err) => {
          renderKgPlugins(null);
          if (kgPluginSummary) kgPluginSummary.textContent = 'local defaults';
          if (DN.logTerm) DN.logTerm.push('KG', 'Could not load KG plugin catalog: ' + (err.message || err));
          return null;
        });
    }

    function logForecastChainTrail(kind, result) {
      if (DN.lifecycle && DN.lifecycle.logForecastChainTrail) {
        DN.lifecycle.logForecastChainTrail(kind, result);
      } else if (DN.logTerm && result) {
        const receipt = result.receipt || {};
        const contract = result.contract || receipt.contract_address || receipt.contract || '';
        const tx = receipt.tx_hash || '';
        if (contract) DN.logTerm.push('CHAIN', kind + ' contract ' + contract);
        if (/^0x[a-fA-F0-9]{64}$/.test(String(tx))) DN.logTerm.push('CHAIN', kind + ' tx ' + tx);
      }
    }

    function configuredForecastContract() {
      const cfgNow = (window.DN_CONFIG && window.DN_CONFIG.FORECAST) || {};
      return forecastContract || cfgNow.CONTRACT || '';
    }

    function entityId(entity) {
      return entity && (entity.entity_id || entity.id);
    }

    function edgeSource(edge) {
      return edge && (edge.source_id || edge.source);
    }

    function edgeTarget(edge) {
      return edge && (edge.target_id || edge.target);
    }

    function norm(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function entityText(entity) {
      const attrs = (entity && entity.attributes) || {};
      return norm([
        entityId(entity),
        entity && entity.name,
        entity && entity.entity_type,
        attrs.team1,
        attrs.team2,
        attrs.team,
        attrs.player,
        attrs.group,
        attrs.round,
        attrs.ground,
      ].filter(Boolean).join(' '));
    }

    function isUsefulKgType(type) {
      return [
        'scout',
        'finding',
        'evidence_claim',
        'debate_claim',
        'prediction',
        'predictor',
        'source',
        'source_domain',
        'source_domain_profile',
        'source_kind',
        'source_quality',
        'source_recency',
        'metric',
        'player',
        'player_stat_line',
        'player_match_profile',
        'team_match_profile',
        'availability_event',
        'availability_status',
        'body_part',
        'formation',
        'position',
        'club',
        'scouting_topic',
        'team_scouting_topic',
        'scouting_gap',
        'claim_type',
        'claim_impact',
        'claim_quality',
      ].includes(type);
    }

    function selectedKgGraph(graph, game) {
      if (!graph || !game) return graph;
      const entities = graph.entities || [];
      const relationships = graph.relationships || [];
      const home = game.home_team || '';
      const away = game.away_team || '';
      const matchName = game.name || [home, away].filter(Boolean).join(' vs ');
      const homeNeedle = norm(home);
      const awayNeedle = norm(away);
      const matchNeedle = norm(matchName);
      const matchId = game.match_id || game.market_key;
      const byId = new Map();
      const selectedCoreIds = new Set();
      const keep = new Set();
      const selectedTeamNames = new Set([homeNeedle, awayNeedle].filter(Boolean));

      entities.forEach((entity) => {
        const id = entityId(entity);
        if (id) byId.set(id, entity);
      });

      function isSelectedTeamName(value) {
        return selectedTeamNames.has(norm(value));
      }

      function isSelectedPlayerData(entity) {
        const attrs = (entity && entity.attributes) || {};
        const type = entity && (entity.entity_type || entity.type);
        if (!['player', 'player_match_profile', 'player_stat_line', 'availability_event'].includes(type)) return false;
        return isSelectedTeamName(attrs.team);
      }

      function isSelectedTeamProfile(entity) {
        const attrs = (entity && entity.attributes) || {};
        const type = entity && (entity.entity_type || entity.type);
        if (type !== 'team_match_profile') return false;
        if (!isSelectedTeamName(attrs.team)) return false;
        return !attrs.match_id || attrs.match_id === matchId || norm(attrs.match_id) === norm(matchId);
      }

      function isSelectedEvidence(entity) {
        const type = entity && (entity.entity_type || entity.type);
        if (!['finding', 'evidence_claim', 'debate_claim', 'prediction'].includes(type)) return false;
        return false;
      }

      function canExpandTo(entity) {
        const type = entity && (entity.entity_type || entity.type);
        return [
          'player',
          'player_match_profile',
          'player_stat_line',
          'team_match_profile',
          'club',
          'position',
          'availability_event',
          'availability_status',
          'body_part',
          'formation',
        ].includes(type);
      }

      entities.forEach((entity) => {
        const id = entityId(entity);
        if (!id) return;
        const attrs = entity.attributes || {};
        const type = entity.entity_type || entity.type;
        const attrHome = norm(attrs.team1 || attrs.home_team);
        const attrAway = norm(attrs.team2 || attrs.away_team);
        const isSelectedMatch = id === matchId ||
          norm(entity.name) === matchNeedle ||
          (attrHome === homeNeedle && attrAway === awayNeedle) ||
          (attrHome === awayNeedle && attrAway === homeNeedle);
        const isSelectedTeam = type === 'team' && (norm(entity.name) === homeNeedle || norm(entity.name) === awayNeedle);
        if (isSelectedMatch || isSelectedTeam || isSelectedPlayerData(entity) || isSelectedTeamProfile(entity) || isSelectedEvidence(entity)) {
          keep.add(id);
          selectedCoreIds.add(id);
        }
      });

      for (let pass = 0; pass < 3; pass++) {
        const seeds = new Set(keep);
        relationships.forEach((edge) => {
          const source = edgeSource(edge);
          const target = edgeTarget(edge);
          if (!source || !target) return;
          const sourceEntity = byId.get(source);
          const targetEntity = byId.get(target);
          const sourceAllowed = selectedCoreIds.has(source) || canExpandTo(sourceEntity);
          const targetAllowed = selectedCoreIds.has(target) || canExpandTo(targetEntity);
          if (seeds.has(source) && targetAllowed) keep.add(target);
          if (seeds.has(target) && sourceAllowed) keep.add(source);
        });
      }

      const scopedEntities = entities.filter((entity) => keep.has(entityId(entity)));
      const scopedRelationships = relationships.filter((edge) => keep.has(edgeSource(edge)) && keep.has(edgeTarget(edge)));
      return Object.assign({}, graph, {
        entities: scopedEntities,
        relationships: scopedRelationships,
        entity_count: scopedEntities.length,
        relationship_count: scopedRelationships.length,
        scope: {
          home_team: home,
          away_team: away,
          match: matchName,
          match_id: matchId,
        },
      });
    }

    function updateWinnerOptions() {
      if (!forecastWinner) return;
      const drawOption = selectedGame.market_type === 'binary' ? '' : '<option value="Draw">Draw</option>';
      forecastWinner.innerHTML =
        '<option value="' + selectedGame.home_team + '">' + selectedGame.home_team + '</option>' +
        drawOption +
        '<option value="' + selectedGame.away_team + '">' + selectedGame.away_team + '</option>';
    }

	    function shortHash(value) {
	      if (!value || value.length < 12) return value || '';
	      return value.slice(0, 6) + '...' + value.slice(-4);
	    }

    function marketOutcomeLabels(source) {
      const match = (source && source.match) || {};
      const first = match.home_team || match.team1 || match.team_a || selectedGame.home_team || 'Team A';
      const second = match.away_team || match.team2 || match.team_b || selectedGame.away_team || 'Team B';
      return { home: first, draw: 'Draw', away: second };
    }

    function marketSideLabel(side, source) {
      const labels = marketOutcomeLabels(source);
      if (side === 'pass') return 'No stake';
      return labels[side] || String(side || 'unknown');
    }

    function qualitativeLean(homeProbability, source) {
      if (homeProbability == null) return '-';
      const value = Number(homeProbability);
      if (!Number.isFinite(value)) return '-';
      const labels = marketOutcomeLabels(source);
      if (value >= 0.62) return 'strong ' + labels.home;
      if (value >= 0.54) return 'soft ' + labels.home;
      if (value <= 0.38) return 'strong ' + labels.away;
      if (value <= 0.46) return 'soft ' + labels.away;
      return 'balanced';
    }

    function marketSideCountsText(values, source, opts) {
      const suffix = opts && opts.suffix ? opts.suffix : '';
      return ['home', 'draw', 'away'].map((side) => {
        const raw = values && values[side] != null ? values[side] : 0;
        return marketSideLabel(side, source) + '=' + raw + suffix;
      }).join(' · ');
    }

    function marketWeightedSupportText(values, source) {
      return ['home', 'draw', 'away'].map((side) => {
        const value = values && values[side] != null ? values[side] : 0;
        return marketSideLabel(side, source) + ' ' + Math.round(value * 100) + '%';
      }).join(' · ');
    }

    function marketMoneyText(values, source) {
      return ['home', 'draw', 'away'].map((side) => {
        const amount = values && values[side + '_usdc'] != null ? values[side + '_usdc'] : '0';
        return marketSideLabel(side, source) + ' ' + amount;
      }).join(' · ');
    }

    function forecastTx(result) {
      const receipt = result && result.receipt;
      if (receipt && /^0x[a-fA-F0-9]{64}$/.test(String(receipt.tx_hash || ''))) return receipt.tx_hash;
      const steps = result && result.steps;
      if (steps && steps.length) {
        for (let i = steps.length - 1; i >= 0; i--) {
          const r = steps[i].receipt || {};
          if (/^0x[a-fA-F0-9]{64}$/.test(String(r.tx_hash || ''))) return r.tx_hash;
          if (r.transactions && r.transactions.length) {
            const tx = r.transactions[r.transactions.length - 1].tx_hash;
            if (/^0x[a-fA-F0-9]{64}$/.test(String(tx || ''))) return tx;
          }
        }
      }
      return '';
    }

    function logColonyPredictionSummary(runId) {
      if (!runId || !DN.databridge || !DN.databridge.fetchRunPrediction) return Promise.resolve(null);
      return DN.databridge.fetchRunPrediction(runId)
        .then((payload) => {
          const prediction = payload.prediction || {};
          const vote = payload.vote_breakdown || {};
          const sides = vote.raw_forecast_sides || {};
          const score = prediction.scoreline && prediction.scoreline.label ? ' · score ' + prediction.scoreline.label : '';
          const decision = prediction.sentence || ('Prediction: ' + (prediction.winner || 'unknown'));
          if (DN.logTerm) {
            DN.logTerm.push('DECISION', decision + score);
            DN.logTerm.push('VOTE', (vote.ants || 0) + ' ants · market order: ' + marketSideCountsText(sides, payload));
            if (payload.artifacts && payload.artifacts.summary) {
              DN.logTerm.push('RUN', 'Summary artifact ready: ' + payload.artifacts.summary);
            }
          }
          H.pushThought(decision, 'Decision', '#3FA89F');
          return payload;
        })
        .catch((err) => {
          if (DN.logTerm) DN.logTerm.push('RUN', 'Could not load final prediction summary: ' + (err.message || err));
          return null;
        });
    }

    function logX402Trail(result) {
      if (!DN.logTerm || !result) return;
      const buyer = result.buyer || {};
      const seller = result.seller || {};
      const artifacts = result.artifacts || {};
      DN.logTerm.push('X402', 'rail ' + (result.rail || 'x402_circle_gateway') + ' · network ' + (result.network || 'Arc Testnet'));
      DN.logTerm.push('X402', 'flow ' + (result.money_flow || '') + ' · amount ' + (result.amount_usdc || '?') + ' credits');
      if (buyer.wallet) DN.logTerm.push('X402', 'buyer ' + (buyer.agent_id || '') + ' wallet ' + buyer.wallet);
      if (seller.wallet) DN.logTerm.push('X402', 'seller ' + (seller.agent_id || '') + ' wallet ' + seller.wallet);
      if (result.gateway_transfer_id) DN.logTerm.push('X402', 'gateway_transfer_id ' + result.gateway_transfer_id);
      if (artifacts.buyer_receipt) DN.logTerm.push('X402', 'buyer_receipt ' + artifacts.buyer_receipt);
      if (artifacts.service_receipts) DN.logTerm.push('X402', 'service_receipts ' + artifacts.service_receipts);
    }

    function setForecastBusy(busy) {
      [forecastDeployBtn, x402BuyBtn, forecastSetupBtn, forecastSettleBtn, forecastWinner, forecastGame].forEach((el) => {
        if (el) el.disabled = busy;
      });
    }

    function setScoutingBusy(busy) {
      [scoutBtn, btn, fastBtn, forecastGame].forEach((el) => {
        if (el) el.disabled = busy;
      });
      [kgRunMode, kgRunTimeout].forEach((el) => {
        if (el) el.disabled = busy;
      });
      if (kgPluginList) {
        kgPluginList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          input.disabled = busy || kgPluginCatalog.some((module) => module.id === input.value && module.configured === false);
        });
      }
      if (!busy) updateKgPluginSummary();
    }

    function ensureRunsPage() {
      let page = $('runs-page');
      if (page) return page;
      page = document.createElement('div');
      page.id = 'runs-page';
      page.className = 'panel';
      const hud = $('hud') || document.body;
      hud.appendChild(page);
      return page;
    }

    function formatRunDate(value) {
      if (!value) return 'pending';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
      return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function runSortTime(record) {
      const value = record && (record.created_at || record.started_at || record.completed_at || '');
      const time = Date.parse(value);
      return Number.isNaN(time) ? 0 : time;
    }

    function matchLabel(record) {
      const match = (record && record.match) || {};
      if (match.name) return match.name;
      if (match.home_team && match.away_team) return match.home_team + ' vs ' + match.away_team;
      return (record && record.run_id) || 'Run';
    }

    function scoreLabel(record) {
      const prediction = (record && record.prediction) || {};
      const score = prediction.scoreline || (((record && record.score_projection) || {}).most_likely_score || {});
      return score.label || 'score pending';
    }

    function supportLabel(record) {
      const votes = (record && record.vote_breakdown) || {};
      const weighted = votes.weighted_side_support || {};
      if (weighted.home != null || weighted.draw != null || weighted.away != null) {
        return marketWeightedSupportText(weighted, record);
      }
      const raw = votes.raw_forecast_sides || {};
      return marketSideCountsText(raw, record);
    }

    function scoutingLabel(record) {
      const scouting = (record && record.scouting) || {};
      if (scouting.scouting_complete === true) return 'scouting complete';
      if (scouting.status) return String(scouting.status).replace(/_/g, ' ');
      if (record && record.kind === 'scouting') return 'scouting pending';
      return 'run artifacts';
    }

    function fmtRunNumber(value, digits) {
      if (value == null || value === '') return '-';
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      return n.toFixed(digits == null ? 2 : digits);
    }

    function agentLabel(item, agent) {
      return (item && (item.ens_name || item.agent_id)) ||
        (agent && (agent.ens_name || agent.agent_id || agent.name)) ||
        'ant';
    }

    function agentPredictionRows(predictionPayload, agentsPayload) {
      const agentMap = {};
      ((agentsPayload && agentsPayload.agents) || []).forEach((agent) => {
        if (agent && agent.agent_id) agentMap[agent.agent_id] = agent;
      });
      const predictions = (predictionPayload && predictionPayload.agent_predictions) || [];
      if (predictions.length) {
        return predictions.slice().sort((a, b) => String(a.agent_id || '').localeCompare(String(b.agent_id || ''))).map((item) => {
          const agent = Object.assign({}, item.agent || {}, agentMap[item.agent_id] || {});
          return { item, agent, forecast: item.forecast || agent.latest_forecast || {} };
        });
      }
      return Object.keys(agentMap).sort().map((agentId) => {
        const agent = agentMap[agentId] || {};
        return {
          item: {
            agent_id: agentId,
            ens_name: agent.ens_name,
            model: agent.model,
            persona: agent.persona,
            risk_profile: agent.risk_profile,
            bet_intent: agent.latest_forecast || {},
            prediction: (agent.latest_forecast || {}).prediction || {},
          },
          agent,
          forecast: agent.latest_forecast || {},
        };
      });
    }

    function renderRunResultsDetail(predictionPayload, agentsPayload) {
      if (!predictionPayload) return '';
      const prediction = predictionPayload.prediction || {};
      const vote = predictionPayload.vote_breakdown || {};
      const counts = vote.raw_forecast_sides || {};
      const rows = agentPredictionRows(predictionPayload, agentsPayload);
      const support = marketSideCountsText(counts, predictionPayload);
      const score = prediction.scoreline && prediction.scoreline.label ? prediction.scoreline.label : scoreLabel(predictionPayload);
      const decision = prediction.sentence || (prediction.winner ? 'Prediction: ' + prediction.winner : 'Prediction pending');
      const tableRows = rows.map(({ item, agent, forecast }) => {
        const itemPrediction = item.prediction || forecast.prediction || {};
        const bet = item.bet_intent || {};
        const side = bet.side || forecast.side || itemPrediction.side || 'draw';
        const sideLabel = marketSideLabel(side, predictionPayload);
        const winner = itemPrediction.winner || bet.outcome || sideLabel;
        const line = itemPrediction.scoreline && itemPrediction.scoreline.label ? itemPrediction.scoreline.label : '-';
        const lean = qualitativeLean(forecast.home_probability, predictionPayload);
        const edge = forecast.edge != null ? fmtRunNumber(forecast.edge, 3) : '-';
        const stake = forecast.stake != null ? fmtRunNumber(forecast.stake, 2) : '-';
        const survival = item.survival_thesis || {};
        const stakeLevel = forecast.stake_level || survival.stake_level || '-';
        const riskRead = forecast.risk_read || survival.risk_read || '-';
        const thesis = forecast.thesis || survival.thesis || '';
        const creditsValue = forecast.credits_balance != null ? forecast.credits_balance : forecast.bankroll != null ? forecast.bankroll : agent.bankroll;
        const credits = creditsValue != null ? fmtRunNumber(creditsValue, 1) : '-';
        const model = item.model || agent.model || '-';
        const persona = item.persona || agent.persona || '-';
        const risk = item.risk_profile || agent.risk_profile || '-';
        return '<tr>' +
          '<td><b>' + esc(item.agent_id || agent.agent_id || 'ant') + '</b><span>' + esc(agentLabel(item, agent)) + '</span></td>' +
          '<td><i class="run-side run-side-' + esc(side) + '">' + esc(sideLabel) + '</i></td>' +
          '<td>' + esc(winner) + '</td>' +
          '<td>' + esc(line) + '</td>' +
          '<td>' + esc(lean) + '</td>' +
          '<td>' + esc(edge) + '</td>' +
          '<td>' + esc(stake) + '<span>' + esc(stakeLevel + ' · ' + riskRead) + '</span></td>' +
          '<td>' + esc(credits) + '</td>' +
          '<td><b>' + esc(model) + '</b><span>' + esc(persona) + ' · ' + esc(risk) + (thesis ? ' · ' + esc(thesis) : '') + '</span></td>' +
        '</tr>';
      }).join('');
      return '<div class="run-results-detail" id="run-results-detail">' +
        '<div class="run-results-head">' +
          '<div>' +
            '<div class="runs-k">Run results</div>' +
            '<div class="run-results-title">' + esc(matchLabel(predictionPayload)) + '</div>' +
            '<div class="run-results-decision">' + esc(decision) + '</div>' +
          '</div>' +
          '<div class="run-results-score">' + esc(score) + '</div>' +
        '</div>' +
        '<div class="run-results-summary">' + esc(rows.length) + ' ants · market order: ' + esc(support) + '</div>' +
        '<div class="run-results-table-wrap">' +
          '<table class="run-results-table">' +
            '<thead><tr><th>Ant</th><th>Vote</th><th>Prediction</th><th>Score</th><th>Lean</th><th>Edge read</th><th>Stake</th><th>Credits</th><th>Model</th></tr></thead>' +
            '<tbody>' + (tableRows || '<tr><td colspan="9">No ant predictions available for this run.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';
    }

    function setRunResultsDetail(predictionPayload, agentsPayload) {
      lastRunResults = { prediction: predictionPayload, agents: agentsPayload };
      const page = ensureRunsPage();
      const html = renderRunResultsDetail(predictionPayload, agentsPayload);
      let detail = $('run-results-detail');
      if (detail) {
        detail.outerHTML = html;
      } else {
        const summary = page.querySelector('.runs-summary');
        if (summary) summary.insertAdjacentHTML('afterend', html);
        else page.insertAdjacentHTML('afterbegin', html);
      }
      const list = page.querySelector('.runs-list');
      if (list) list.scrollTop = 0;
      page.classList.add('show');
    }

    function loadRunResults(runId, existingPrediction) {
      if (!runId || !DN.databridge || !DN.databridge.fetchRunPrediction) return Promise.resolve(null);
      status.textContent = 'Loading results...';
      const predictionPromise = existingPrediction ? Promise.resolve(existingPrediction) : DN.databridge.fetchRunPrediction(runId);
      const agentsPromise = DN.databridge.fetchRunAgents ? DN.databridge.fetchRunAgents(runId).catch(() => null) : Promise.resolve(null);
      return Promise.all([predictionPromise, agentsPromise])
        .then(([predictionPayload, agentsPayload]) => {
          setRunResultsDetail(predictionPayload, agentsPayload);
          const count = agentPredictionRows(predictionPayload, agentsPayload).length;
          status.textContent = 'Results · ' + count + ' ants';
          if (DN.logTerm) DN.logTerm.push('RUN', 'Results table loaded for ' + runId + ' · ' + count + ' ants.');
          return predictionPayload;
        })
        .catch((err) => {
          status.textContent = 'Results error';
          if (DN.logTerm) DN.logTerm.push('RUN', 'Could not load results table: ' + (err.message || err));
          return null;
        });
    }

    function benchmarkPredictionLabel(record) {
      const prediction = (record && record.prediction) || {};
      const recommendation = (record && record.recommendation) || {};
      return prediction.winner || recommendation.winner || recommendation.side || 'pending';
    }

    function benchmarkSettlementLabel(record) {
      if (!record || (!record.actual_result && !record.hit_miss)) return 'unsettled';
      return [record.actual_result || '', record.hit_miss || ''].filter(Boolean).join(' · ');
    }

    function benchmarkVoteCounts(record) {
      const votes = (record && record.vote_breakdown) || {};
      const raw = votes.raw_forecast_sides || votes.counts || votes.vote_counts || votes.side_counts || {};
      return {
        home: Number(raw.home || 0),
        draw: Number(raw.draw || 0),
        away: Number(raw.away || 0),
      };
    }

    function benchmarkVotesLabel(record) {
      const counts = benchmarkVoteCounts(record);
      const total = counts.home + counts.draw + counts.away;
      if (!total) return 'pending';
      return ['home', 'draw', 'away'].map((side) => {
        return marketSideLabel(side, record) + ' ' + counts[side];
      }).join(' · ');
    }

    function benchmarkWeightedVotesLabel(record) {
      const votes = (record && record.vote_breakdown) || {};
      const weighted = votes.weighted_side_support || {};
      if (weighted.home == null && weighted.draw == null && weighted.away == null) return '';
      return 'weighted ' + ['home', 'draw', 'away'].map((side) => {
        const value = weighted[side] == null ? 0 : Number(weighted[side]);
        return marketSideLabel(side, record) + ' ' + (Number.isFinite(value) ? Math.round(value * 100) : 0) + '%';
      }).join(' · ');
    }

    function renderBenchmarkRunsPage(payload, error) {
      const page = ensureRunsPage();
      const myPubkey = currentPubkey();
      const records = ((payload && payload.runs) || []).slice().sort((a, b) => runSortTime(b) - runSortTime(a));
      const snapshotId = (payload && payload.snapshot_id) || selectedPrematchSnapshotId();
      const detailRunId = lastRunResults && lastRunResults.prediction && lastRunResults.prediction.run_id;
      const detailHtml = detailRunId && records.some((record) => record.run_id === detailRunId)
        ? renderRunResultsDetail(lastRunResults.prediction, lastRunResults.agents)
        : '';
      const rows = records.map((record) => {
        const pubkey = String(record.pubkey || '');
        const mine = myPubkey && pubkey === myPubkey;
        const prediction = benchmarkPredictionLabel(record);
        const votes = benchmarkVotesLabel(record);
        const weightedVotes = benchmarkWeightedVotesLabel(record);
        const docs = Number(record.document_count || 0);
        const claims = Number(record.claim_count || 0);
        const agents = record.agent_count == null ? '-' : record.agent_count;
        const settlement = benchmarkSettlementLabel(record);
        const statusClass = 'status-' + String(record.status || 'unknown').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
        return '<tr class="' + (mine ? 'mine ' : '') + esc(statusClass) + '" data-run="' + esc(record.run_id || '') + '">' +
          '<td><b>' + esc(formatRunDate(record.completed_at || record.started_at || record.created_at)) + '</b><span>' + esc(record.status || 'unknown') + '</span></td>' +
          '<td><b>' + esc(matchLabel(record)) + '</b><span>' + esc(record.prematch_snapshot_id || snapshotId || 'snapshot') + '</span></td>' +
          '<td><button class="benchmark-wallet-copy" data-wallet="' + esc(pubkey) + '" title="' + esc(pubkey) + '">' + esc(shortPubkey(pubkey)) + '</button>' + (mine ? '<span class="benchmark-mine">mine</span>' : '') + '</td>' +
          '<td><b>' + esc(prediction) + '</b><span>' + esc(scoreLabel(record)) + '</span></td>' +
          '<td><b>' + esc(votes) + '</b>' + (weightedVotes ? '<span>' + esc(weightedVotes) + '</span>' : '') + '</td>' +
          '<td>' + esc(agents) + '</td>' +
          '<td><b>' + esc(docs) + '</b><span>' + esc(claims) + ' claims</span></td>' +
          '<td>' + esc(settlement) + '</td>' +
          '<td><button class="backend-btn secondary benchmark-run-results" ' + (record.run_id ? '' : 'disabled') + '>Results</button></td>' +
        '</tr>';
      }).join('');
      page.innerHTML =
        '<div class="runs-head">' +
          '<div><div class="runs-k">Benchmark</div><div class="runs-title">Previous test colony runs</div></div>' +
          '<div class="runs-actions">' +
            '<button class="backend-btn secondary" id="runs-refresh">Refresh</button>' +
            '<button class="backend-btn secondary" id="runs-close">Close</button>' +
          '</div>' +
        '</div>' +
        (error ? '<div class="runs-error">' + esc(error) + '</div>' : '') +
        '<div class="runs-summary">' + esc(records.length) + ' runs' + (snapshotId ? ' · ' + esc(snapshotId) : '') + '</div>' +
        detailHtml +
        '<div class="benchmark-table-wrap">' +
          '<table class="benchmark-table">' +
            '<thead><tr><th>Time</th><th>Match</th><th>Colony</th><th>Prediction</th><th>Votes</th><th>Agents</th><th>Data</th><th>Actual</th><th></th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="9">No benchmark runs yet for this saved match.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>';
      page.classList.add('show');
      const close = $('runs-close');
      const refresh = $('runs-refresh');
      if (close) close.addEventListener('click', () => page.classList.remove('show'));
      if (refresh) refresh.addEventListener('click', () => H.refreshBenchmarkRunsPage(true));
      page.querySelectorAll('.benchmark-wallet-copy').forEach((button) => {
        button.addEventListener('click', () => {
          const wallet = button.getAttribute('data-wallet') || '';
          if (wallet && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(wallet).catch(() => {});
        });
      });
      page.querySelectorAll('.benchmark-run-results').forEach((button) => {
        button.addEventListener('click', () => {
          const row = button.closest('tr');
          const runId = row && row.getAttribute('data-run');
          if (!runId) return;
          button.disabled = true;
          loadRunResults(runId).finally(() => { button.disabled = false; });
        });
      });
    }

    H.refreshBenchmarkRunsPage = function (showErrors) {
      if (!DN.databridge || !DN.databridge.fetchBenchmarkRuns) {
        renderBenchmarkRunsPage(null, 'Benchmark runs are not available from this backend.');
        return Promise.resolve(null);
      }
      const page = ensureRunsPage();
      page.innerHTML = '<div class="runs-loading">Loading benchmark results...</div>';
      page.classList.add('show');
      const opts = { limit: 80 };
      const snapshotId = selectedPrematchSnapshotId();
      if (snapshotId) opts.snapshot_id = snapshotId;
      return DN.databridge.fetchBenchmarkRuns(opts)
        .then((payload) => {
          renderBenchmarkRunsPage(payload);
          status.textContent = 'Benchmark results loaded';
          return payload;
        })
        .catch((err) => {
          const message = err.message || String(err);
          renderBenchmarkRunsPage(null, message);
          if (showErrors) H.pushThought('Could not load benchmark runs: ' + message, 'Backend', '#D96E54');
          return null;
        });
    };

    function renderRunsPage(payload, error) {
      const page = ensureRunsPage();
      const records = ((payload && payload.predictions) || []).slice().sort((a, b) => runSortTime(b) - runSortTime(a));
      const rows = records.map((record) => {
        const prediction = record.prediction || {};
        const recommendation = record.recommendation || {};
        const metrics = record.metrics || {};
        const scouting = record.scouting || {};
        const winner = prediction.winner || recommendation.winner || 'pending';
        const confidence = prediction.confidence || recommendation.confidence_label || 'pending';
        const edgeValue = metrics.prediction_value_signal != null ? metrics.prediction_value_signal : metrics.market_edge;
        const edge = edgeValue != null ? Number(edgeValue).toFixed(3) : 'n/a';
        const entities = scouting.entity_count != null ? scouting.entity_count : 0;
        const links = scouting.relationship_count != null ? scouting.relationship_count : 0;
        const canLoad = !!(record.artifacts && record.artifacts.events);
        const canKg = !!(record.artifacts && record.artifacts.kg);
        return '<div class="run-row" data-run="' + esc(record.run_id) + '">' +
          '<div class="run-row-main">' +
            '<div class="run-eyebrow"><span>' + esc(record.kind || 'run') + '</span><span>' + esc(record.status || 'unknown') + '</span><span>' + esc(formatRunDate(record.completed_at || record.created_at)) + '</span></div>' +
            '<div class="run-title">' + esc(matchLabel(record)) + '</div>' +
            '<div class="run-prediction">' + esc(winner) + ' · ' + esc(scoreLabel(record)) + ' · ' + esc(confidence) + '</div>' +
            '<div class="run-meta">' + esc(supportLabel(record)) + ' · value ' + esc(edge) + ' · ' + esc(scoutingLabel(record)) + '</div>' +
            '<div class="run-meta">' + esc(entities) + ' KG nodes · ' + esc(links) + ' links</div>' +
          '</div>' +
          '<div class="run-row-actions">' +
            '<button class="backend-btn secondary run-results">Results</button>' +
            '<button class="backend-btn secondary run-load" ' + (canLoad ? '' : 'disabled') + '>Load</button>' +
            '<button class="backend-btn secondary run-kg" ' + (canKg ? '' : 'disabled') + '>KG</button>' +
          '</div>' +
        '</div>';
      }).join('');
      page.innerHTML =
        '<div class="runs-head">' +
          '<div><div class="runs-k">History</div><div class="runs-title">Previous runs and predictions</div></div>' +
          '<div class="runs-actions">' +
            '<button class="backend-btn secondary" id="runs-refresh">Refresh</button>' +
            '<button class="backend-btn secondary" id="runs-close">Close</button>' +
          '</div>' +
        '</div>' +
        (error ? '<div class="runs-error">' + esc(error) + '</div>' : '') +
        '<div class="runs-summary">' + esc(records.length) + ' runs · scouting and forecast artifacts from the backend</div>' +
        (lastRunResults ? renderRunResultsDetail(lastRunResults.prediction, lastRunResults.agents) : '') +
        '<div class="runs-list">' + (rows || '<div class="runs-empty">No run predictions yet.</div>') + '</div>';
      page.classList.add('show');
      const close = $('runs-close');
      const refresh = $('runs-refresh');
      if (close) close.addEventListener('click', () => page.classList.remove('show'));
      if (refresh) refresh.addEventListener('click', () => H.refreshRunsPage(true));
      page.querySelectorAll('.run-results').forEach((button) => {
        button.addEventListener('click', () => {
          const row = button.closest('.run-row');
          const runId = row && row.getAttribute('data-run');
          if (!runId) return;
          button.disabled = true;
          loadRunResults(runId).finally(() => { button.disabled = false; });
        });
      });
      page.querySelectorAll('.run-load').forEach((button) => {
        button.addEventListener('click', () => {
          const row = button.closest('.run-row');
          const runId = row && row.getAttribute('data-run');
          if (!runId || !DN.databridge || !DN.databridge.loadRun) return;
          button.disabled = true;
          status.textContent = 'Loading run...';
          DN.databridge.loadRun(runId)
            .then(() => {
              if (DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(runId);
              if (DN.commsViz && DN.commsViz.reset) DN.commsViz.reset();
              if (H._pollComms) H._pollComms();
              status.textContent = 'Loaded ' + runId.slice(0, 18);
              if (DN.logTerm) DN.logTerm.push('RUN', 'Loaded historical run ' + runId + '.');
            })
            .catch((err) => {
              status.textContent = 'Run load error';
              if (DN.logTerm) DN.logTerm.push('RUN', 'Could not load run ' + runId + ': ' + (err.message || err));
            })
            .finally(() => { button.disabled = false; });
        });
      });
      page.querySelectorAll('.run-kg').forEach((button) => {
        button.addEventListener('click', () => {
          const row = button.closest('.run-row');
          const runId = row && row.getAttribute('data-run');
          if (!runId || !DN.databridge || !DN.databridge.fetchRunKg) return;
          button.disabled = true;
          status.textContent = 'Loading run KG...';
          DN.databridge.fetchRunKg(runId)
            .then((kg) => {
              if (DN.kgview) DN.kgview.showGraph(kg, 'Run KG ' + runId.slice(0, 18));
              status.textContent = 'Run KG loaded';
              if (DN.logTerm) DN.logTerm.push('KG', 'Loaded KG for historical run ' + runId + '.');
            })
            .catch((err) => {
              status.textContent = 'Run KG error';
              if (DN.logTerm) DN.logTerm.push('KG', 'Could not load run KG ' + runId + ': ' + (err.message || err));
            })
            .finally(() => { button.disabled = false; });
        });
      });
    }

    H.refreshRunsPage = function (showErrors) {
      if (!DN.databridge || !DN.databridge.fetchPredictions) {
        renderRunsPage(null, 'Prediction history is not available from this backend.');
        return Promise.resolve(null);
      }
      const page = ensureRunsPage();
      page.innerHTML = '<div class="runs-loading">Loading run history...</div>';
      page.classList.add('show');
      return DN.databridge.fetchPredictions({ limit: 60, include_incomplete: true })
        .then((payload) => {
          renderRunsPage(payload);
          status.textContent = 'Runs loaded';
          return payload;
        })
        .catch((err) => {
          const message = err.message || String(err);
          renderRunsPage(null, message);
          if (showErrors) H.pushThought('Could not load previous predictions: ' + message, 'Backend', '#D96E54');
          return null;
        });
    };

    function isUpcomingGroupStage(game) {
      return isGroupStageGame(game) && game.date >= todayIsoDate() && !game.score;
    }

    updateWinnerOptions();
    loadKgPlugins();
    if (DN.databridge && DN.databridge.fetchForecastConfig) {
      DN.databridge.fetchForecastConfig()
        .then((payload) => {
          forecastContract = forecastContract || payload.contract || '';
          if (forecastContract) status.textContent = 'Forecast ' + shortHash(forecastContract);
        })
        .catch(() => {});
    }
    if (DN.databridge && DN.databridge.fetchForecastGames && forecastGame) {
      DN.databridge.fetchForecastGames()
        .then((payload) => {
          forecastGamesHavePreviousTestData = Boolean(payload && payload.include_previous_test_data);
          const games = payload.games || [];
          const preferred = games.find((game) => /Brazil vs Morocco/i.test(game.name || '')) || games[0];
          if (!preferred) return;
          renderForecastGames(forecastGameScope ? forecastGameScope.value : 'upcoming', preferred);
        })
        .catch(() => {});
      if (forecastGameScope) {
        forecastGameScope.addEventListener('change', () => {
          const scope = forecastGameScope.value;
          if (scope === 'previous' && !forecastGamesHavePreviousTestData) {
            loadPreviousTestGames()
              .then(() => {
                renderForecastGames(selectedGameScope(), selectedGame);
                const suffix = selectedGameScope() === 'previous' ? ' · previous test' : '';
                status.textContent = hasBenchmarkSnapshotData(selectedGame) ? (selectedGame.name || 'Selected game') + suffix : 'No saved test data';
              })
              .catch((err) => {
                status.textContent = 'Saved tests unavailable';
                if (forecastGame) {
                  forecastGame.innerHTML = '<option value="">No saved test data</option>';
                  forecastGame.disabled = true;
                }
                updatePreviousModeChrome();
                H.pushThought('Could not load saved test data: ' + (err.message || err), 'Backend', '#D96E54');
              });
            return;
          }
          renderForecastGames(scope, selectedGame);
          updatePreviousModeChrome();
          const suffix = scope === 'previous' ? ' · previous test' : '';
          status.textContent = (selectedGame.name || 'Selected game') + suffix;
        });
      }
      forecastGame.addEventListener('change', () => {
        const optionText = forecastGame.options[forecastGame.selectedIndex] ? forecastGame.options[forecastGame.selectedIndex].textContent : 'Selected game';
        const cached = (DN.databridge.forecastGames || []).find((game) => gameKey(game) === forecastGame.value);
        selectedGame = {
          market_key: forecastGame.value,
          match_id: forecastGame.value,
          market_type: forecastGame.value.includes('group') ? 'three_way' : selectedGame.market_type,
          home_team: optionText.split(' vs ')[0] || selectedGame.home_team,
          away_team: optionText.split(' vs ')[1] || selectedGame.away_team,
          name: optionText,
        };
        if (cached) selectedGame = cached;
        forecastMarketKey = '';
        forecastStakes = [];
        updateWinnerOptions();
        updatePreviousModeChrome();
        status.textContent = selectedGame.name;
      });
    }

    function createColonyFromPanel() {
      const pubkey = currentPubkey();
      if (!pubkey) {
        H.pushThought('Connect your wallet before creating a colony.', 'Wallet', '#D96E54');
        return Promise.resolve(null);
      }
      if (!DN.databridge || !DN.databridge.createUserColony) {
        H.pushThought('Colony API is not available from the frontend.', 'Colony', '#D96E54');
        return Promise.resolve(null);
      }
      const placement = selectedColonyPlacement(pubkey);
      const payload = {
        pubkey,
        angle: placement.angle,
        dist: placement.dist,
        accent: placement.accent,
        name: placement.name,
        visibility: 'public',
        config: selectedColonyConfig(),
      };
      setColonyBusy(true);
      status.textContent = 'Creating colony...';
      return DN.databridge.createUserColony(payload)
        .then((result) => {
          renderColonySummary(result);
          if (result && result.colony) {
            syncWalletColonyRosterStats(materializeWalletColony(result.colony), result);
            try {
              localStorage.setItem('dn:my-colony:' + pubkey, JSON.stringify({
                angle: result.colony.angle,
                dist: result.colony.dist,
                accent: Number(result.colony.accent),
                name: result.colony.name,
              }));
            } catch (err) {}
          }
          if (!DN.databridge.ensureUserColonyAnts) {
            status.textContent = 'Colony ready';
            H.pushThought('Colony saved: ' + (result && result.colony && result.colony.name || shortPubkey(pubkey)) + '.', 'Colony', '#3FA89F');
            return result;
          }
          status.textContent = 'Creating ants...';
          return DN.databridge.ensureUserColonyAnts(pubkey, {
            target_count: Number(colonyAntCount && colonyAntCount.value || payload.config.ant_count || 50),
            replace: false,
            seed: 42,
          }).then((roster) => {
            const merged = Object.assign({}, result, { ant_summary: roster.ant_summary });
            renderColonySummary(merged);
            if (merged && merged.colony) {
              syncWalletColonyRosterStats(materializeWalletColony(merged.colony), merged);
            }
            renderColonyAntList(roster.ants || []);
            if (roster.ants && DN.ants && DN.ants.bindAgentRecords) DN.ants.bindAgentRecords(roster.ants);
            const total = roster.ant_summary && roster.ant_summary.total || 0;
            status.textContent = 'Colony ready · ' + total + ' ants';
            H.pushThought('Colony saved with ' + total + ' ants: ' + (result && result.colony && result.colony.name || shortPubkey(pubkey)) + '.', 'Colony', '#3FA89F');
            return merged;
          });
        })
        .catch((err) => {
          status.textContent = 'Colony error';
          H.pushThought('Could not create colony: ' + (err.message || err), 'Colony', '#D96E54');
          return null;
        })
        .finally(() => setColonyBusy(false));
    }

    function ensurePanelColony() {
      const pubkey = currentPubkey();
      if (!pubkey) return Promise.reject(new Error('Connect wallet first.'));
      if (lastColonyPayload && lastColonyPayload.colony) return Promise.resolve(lastColonyPayload);
      return refreshUserColony(true).then((payload) => {
        if (payload && payload.colony) return payload;
        return createColonyFromPanel();
      });
    }

    if (colonyCreateBtn) {
      colonyCreateBtn.addEventListener('click', () => {
        createColonyFromPanel();
      });
    }

    if (colonyAddAntsBtn) {
      colonyAddAntsBtn.addEventListener('click', () => {
        if (!DN.databridge || !DN.databridge.ensureUserColonyAnts) return;
        const pubkey = currentPubkey();
        if (!pubkey) {
          H.pushThought('Connect your wallet before adding ants.', 'Wallet', '#D96E54');
          return;
        }
        setColonyBusy(true);
        status.textContent = 'Adding ants...';
        ensurePanelColony()
          .then(() => DN.databridge.ensureUserColonyAnts(pubkey, {
            target_count: Number(colonyAntCount && colonyAntCount.value || 50),
            replace: false,
            seed: 42,
          }))
          .then((payload) => {
            const merged = { colony: (lastColonyPayload && lastColonyPayload.colony) || {}, ant_summary: payload.ant_summary };
            renderColonySummary(merged);
            const col = DN.app && DN.app.findMyColony ? DN.app.findMyColony() : null;
            syncWalletColonyRosterStats(col, merged);
            if (payload.ants && DN.ants && DN.ants.bindAgentRecords) DN.ants.bindAgentRecords(payload.ants);
            const statuses = (payload.ant_summary && payload.ant_summary.statuses) || {};
            status.textContent = (statuses.alive || 0) + ' ants alive';
            H.pushThought('Colony roster synced: ' + payload.ant_summary.total + ' ants.', 'Colony', '#3FA89F');
          })
          .catch((err) => {
            status.textContent = 'Ant sync error';
            H.pushThought('Could not add ants: ' + (err.message || err), 'Colony', '#D96E54');
          })
          .finally(() => setColonyBusy(false));
      });
    }

    if (colonyListAntsBtn) {
      colonyListAntsBtn.addEventListener('click', () => {
        if (!DN.databridge || !DN.databridge.fetchUserColonyAnts) return;
        const pubkey = currentPubkey();
        if (!pubkey) {
          H.pushThought('Connect your wallet before listing ants.', 'Wallet', '#D96E54');
          return;
        }
        setColonyBusy(true);
        status.textContent = 'Loading colony ants...';
        DN.databridge.fetchUserColonyAnts(pubkey, { status: 'all', limit: 200 })
          .then((payload) => {
            const ants = payload.ants || [];
            renderColonyAntList(ants);
            if (colonyPreview) colonyPreview.textContent = ants.length ? 'Showing ' + ants.length + ' ants. Click a row to edit status.' : 'No ants yet.';
            if (DN.ants && DN.ants.bindAgentRecords) DN.ants.bindAgentRecords(ants);
            status.textContent = ants.length + ' colony ants';
            H.pushThought('Loaded ' + ants.length + ' ants for this colony.', 'Colony', '#3FA89F');
          })
          .catch((err) => {
            status.textContent = 'Ant list error';
            H.pushThought('Could not list ants: ' + (err.message || err), 'Colony', '#D96E54');
          })
          .finally(() => setColonyBusy(false));
      });
    }

    if (colonyUpdateAntBtn) {
      colonyUpdateAntBtn.addEventListener('click', () => {
        if (!DN.databridge || !DN.databridge.setUserColonyAntStatus) return;
        const pubkey = currentPubkey();
        const agentId = String(colonyAntId && colonyAntId.value || '').trim();
        const nextStatus = (colonyAntStatus && colonyAntStatus.value) || 'alive';
        if (!pubkey) {
          H.pushThought('Connect your wallet before updating an ant.', 'Wallet', '#D96E54');
          return;
        }
        if (!agentId) {
          H.pushThought('Enter an ant id before updating status.', 'Colony', '#D96E54');
          return;
        }
        setColonyBusy(true);
        status.textContent = 'Updating ant...';
        DN.databridge.setUserColonyAntStatus(pubkey, agentId, nextStatus)
          .then((payload) => {
            const ant = payload.ants && payload.ants[0];
            const label = ant ? ant.agent_id + ' is ' + ant.status : agentId + ' updated';
            if (colonyPreview) colonyPreview.textContent = label;
            status.textContent = label;
            H.pushThought('Updated ' + label + '.', 'Colony', '#3FA89F');
            return refreshUserColony(true);
          })
          .catch((err) => {
            status.textContent = 'Ant update error';
            H.pushThought('Could not update ant: ' + (err.message || err), 'Colony', '#D96E54');
          })
          .finally(() => setColonyBusy(false));
      });
    }

    if (colonyRunBtn) {
      colonyRunBtn.addEventListener('click', () => {
        if (!DN.databridge || !DN.databridge.startUserColonyRun) return;
        const pubkey = currentPubkey();
        if (!pubkey) {
          H.pushThought('Connect your wallet before running all.', 'Wallet', '#D96E54');
          return;
        }
        const previousTest = isPreviousGameScope();
        if (previousTest && !hasBenchmarkSnapshotData(selectedGame)) {
          H.pushThought('No saved pre-match test data is available for this match.', 'Backend', '#D96E54');
          status.textContent = 'No saved test data';
          return;
        }
        const prematchSnapshotId = previousTest ? selectedPrematchSnapshotId() : '';
        if (previousTest && !prematchSnapshotId) {
          H.pushThought('This saved match has no Supabase snapshot id yet.', 'Backend', '#D96E54');
          status.textContent = 'Missing snapshot id';
          return;
        }
        setColonyBusy(true);
        setScoutingBusy(true);
        status.textContent = previousTest ? 'Run with colony...' : 'Run all...';
        ensurePanelColony()
          .then(() => {
            runAllVisualStart(pubkey, { previousTest });
            if (previousTest) {
              status.textContent = 'Run with colony...';
              H.pushThought('Using the saved pre-match KG for ' + selectedGame.name + '.', 'Backend', '#3FA89F');
              if (DN.logTerm) DN.logTerm.push('KG', 'Previous test selected; skipping automatic KG refresh for ' + selectedGame.name + '.');
              return null;
            }
            return startSelectedKgRun('all');
          })
          .then(() => {
            runAllVisualColonyStep(pubkey);
            status.textContent = previousTest ? 'Run with colony...' : 'Run all · colony...';
            if (DN.logTerm) {
              DN.logTerm.push('COLONY', (previousTest ? 'Benchmark colony step' : 'Run all colony step') + ' starting for ' + selectedGame.name + '.');
            }
            return DN.databridge.startUserColonyRun(pubkey, {
              match: selectedGame.name,
              match_id: selectedGame.match_id || selectedGame.market_key,
              data_mode: previousTest ? 'openfootball' : 'public',
              run_mode: previousTest ? 'previous_test' : 'live',
              prematch_snapshot_id: prematchSnapshotId || undefined,
              refresh_data: false,
              rooms: 5,
              voice_mode: 'template',
              seed: 42,
              debug: true,
              show_completed_graph: !previousTest,
            });
          })
          .then((result) => {
            const runId = (DN.databridge && DN.databridge.runId) || (result && result.id) || '';
            status.textContent = runId ? (previousTest ? 'Benchmark ' : 'Run all ') + shortHash(runId) : (previousTest ? 'Benchmark complete' : 'Run all complete');
            H.pushThought((previousTest ? 'Benchmark run finished for ' : 'Run all finished for ') + selectedGame.name + '.', 'Colony', '#3FA89F');
            return logColonyPredictionSummary(runId).then((summary) => {
              runAllVisualFinish();
              const refresh = previousTest ? H.refreshBenchmarkRunsPage(false) : H.refreshRunsPage(false);
              return refresh.then(() => loadRunResults(runId, summary));
            });
          })
          .catch((err) => {
            if (DN.crystal && DN.crystal.hide) DN.crystal.hide();
            status.textContent = previousTest ? 'Benchmark error' : 'Run all error';
            H.pushThought((previousTest ? 'Benchmark run failed: ' : 'Run all failed: ') + (err.message || err), 'Colony', '#D96E54');
          })
          .finally(() => {
            setScoutingBusy(false);
            setColonyBusy(false);
          });
      });
    }

    if (colonyRemoveBtn) {
      colonyRemoveBtn.addEventListener('click', () => {
        if (!DN.databridge || !DN.databridge.deleteUserColony) return;
        const pubkey = currentPubkey();
        if (!pubkey) {
          H.pushThought('Connect your wallet before removing a colony.', 'Wallet', '#D96E54');
          return;
        }
        if (!window.confirm(
          'Delete the colony linked to ' + shortPubkey(pubkey) + '?\n\n' +
          'Your wallet will stay connected and untouched. This only removes the colony record and its roster data.'
        )) return;
        setColonyBusy(true);
        status.textContent = 'Deleting colony...';
        DN.databridge.deleteUserColony(pubkey)
          .then(() => {
            removeWalletColonyLocal(pubkey);
            try { localStorage.removeItem('dn:my-colony:' + pubkey); } catch (err) {}
            renderColonySummary(null);
            status.textContent = 'Colony deleted';
            H.pushThought('Colony deleted. Wallet unchanged.', 'Colony', '#8C7E60');
          })
          .catch((err) => {
            status.textContent = 'Remove error';
            H.pushThought('Could not remove colony: ' + (err.message || err), 'Colony', '#D96E54');
          })
          .finally(() => setColonyBusy(false));
      });
    }

    refreshUserColony(true);
    if (DN.wallet && typeof DN.wallet.onChange === 'function') {
      DN.wallet.onChange(() => {
        lastColonyPayload = null;
        setTimeout(() => refreshUserColony(true), 150);
      });
    }

    // Manual debug fetch only. Product colony rosters should come from
    // /colonies/{wallet}/ants, otherwise a user with no colony still sees
    // fallback global agents in the UI.
    function pollAgents(showErrors) {
      if (!DN.databridge || !DN.databridge.fetchAgents) return Promise.resolve(null);
      return DN.databridge.fetchAgents()
        .then((payload) => {
          const records = payload.agents || [];
          status.textContent = records.length + ' ants · live';
          if (DN.ants && DN.ants.bindAgentRecords) DN.ants.bindAgentRecords(records);
          return records;
        })
        .catch((err) => {
          if (showErrors) {
            status.textContent = 'Ant fetch error';
            H.pushThought('Could not fetch ants: ' + (err.message || err), 'Backend', '#D96E54');
          }
          return null;
        });
    }
    // Communication events: poll faster (5s) so debate arcs feel live.
    // Hands events to commsViz; logTerm rows are emitted by commsViz so
    // we don't double-log. Errors are surfaced to the log once each.
    let _commsLastErr = null;
    let _commsLastRun = null;
    function pollComms() {
      if (!DN.databridge || !DN.databridge.fetchCommunications) {
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'databridge.fetchCommunications not loaded — stale cache? Hard refresh (Cmd+Shift+R).');
        return;
      }
      DN.databridge.fetchCommunications()
        .then((payload) => {
          const events = payload.events || [];
          const rid = payload.run_id;
          if (DN.logTerm && rid && rid !== _commsLastRun) {
            DN.logTerm.push('SYSTEM', 'Connected to backend run ' + rid + '.');
            _commsLastRun = rid;
          }
          const phase = DN.lifecycle && DN.lifecycle.getPhase ? DN.lifecycle.getPhase() : '';
          const lifecycleOwnsComms = phase && phase !== 'idle' && phase !== 'egress_roam';
          if (!lifecycleOwnsComms && DN.commsViz && DN.commsViz.ingest) DN.commsViz.ingest(events);
          _commsLastErr = null;
        })
        .catch((err) => {
          const msg = (err && err.message) || String(err);
          if (msg !== _commsLastErr && DN.logTerm) {
            _commsLastErr = msg;
            DN.logTerm.push('SYSTEM', 'Comms poll error: ' + msg);
          }
        });
    }
    pollComms();
    setInterval(pollComms, 5000);
    H._pollComms = pollComms; // exposed so Run LLM can kick a fresh poll

    antsBtn.addEventListener('click', () => {
      antsBtn.disabled = true;
      status.textContent = 'Getting ants...';
      pollAgents(true)
        .then((records) => {
          if (records) H.pushThought('Frontend fetched ' + records.length + ' ants from the Railway API.', 'Backend', '#3FA89F');
        })
        .finally(() => { antsBtn.disabled = false; });
    });
    kgBtn.addEventListener('click', () => {
      if (!DN.databridge || !DN.databridge.fetchWorldCupKg) return;
      kgBtn.disabled = true;
      status.textContent = 'Looking for scout KG...';

      function renderKg(payload, sourceLabel) {
        const entities = payload.entity_count != null ? payload.entity_count : (payload.entities || []).length;
        const links = payload.relationship_count != null ? payload.relationship_count : (payload.relationships || []).length;
        const scoped = selectedKgGraph(payload, selectedGame);
        const scopedEntities = scoped.entity_count != null ? scoped.entity_count : (scoped.entities || []).length;
        const scopedLinks = scoped.relationship_count != null ? scoped.relationship_count : (scoped.relationships || []).length;
        const title = (selectedGame && selectedGame.name ? selectedGame.name : 'Selected fixture') + ' KG';
        if (DN.kgview) DN.kgview.showGraph(scoped, title);
        status.textContent = scopedEntities + ' ' + sourceLabel + ' KG entities · ' + scopedLinks + ' links';
        H.pushThought('Frontend loaded ' + sourceLabel + ' KG for ' + selectedGame.name + ': ' + scopedEntities + ' of ' + entities + ' entities, ' + scopedLinks + ' of ' + links + ' links.', 'Backend', '#3FA89F');
      }

      const scoutKg = DN.databridge.fetchScoutingKgForMatch
        ? DN.databridge.fetchScoutingKgForMatch({
            match: selectedGame.name,
            match_id: selectedGame.match_id || selectedGame.market_key,
            market_key: selectedGame.market_key,
          })
        : Promise.resolve(null);

      scoutKg
        .then((payload) => {
          if (payload) {
            if (DN.logTerm) DN.logTerm.push('KG', 'Loaded stored scout KG ' + (payload.source_run_id || '') + ' for ' + selectedGame.name + '.');
            renderKg(payload, 'scout');
            return null;
          }
          status.textContent = 'No scout KG yet · loading fixture KG...';
          if (DN.logTerm) DN.logTerm.push('KG', 'No stored scout KG found for ' + selectedGame.name + '; loading static fixture KG.');
          return DN.databridge.fetchWorldCupKg()
            .then((fallback) => renderKg(fallback, 'fixture'));
        })
        .catch((err) => {
          if (!DN.databridge.fetchWorldCupKg) throw err;
          status.textContent = 'Scout KG lookup failed · loading fixture KG...';
          return DN.databridge.fetchWorldCupKg()
            .then((fallback) => renderKg(fallback, 'fixture'));
        })
        .catch((err) => {
          status.textContent = 'KG fetch error';
          H.pushThought('Could not fetch KG: ' + (err.message || err), 'Backend', '#D96E54');
        })
        .finally(() => { kgBtn.disabled = false; });
    });

    if (runsBtn) {
      runsBtn.addEventListener('click', () => {
        const page = ensureRunsPage();
        if (page.classList.contains('show')) {
          page.classList.remove('show');
          return;
        }
        if (isPreviousGameScope()) H.refreshBenchmarkRunsPage(true);
        else H.refreshRunsPage(true);
      });
    }

    scoutBtn.addEventListener('click', () => {
      if (!DN.databridge || !(DN.databridge.startKgRun || DN.databridge.startScoutingRun)) return;
      setScoutingBusy(true);
      startSelectedKgRun('kg')
        .catch((err) => {
          if (/select at least one kg plugin/i.test(err.message || '')) status.textContent = 'Choose KG plugins';
          else status.textContent = 'KG run error';
          H.pushThought('KG run failed: ' + (err.message || err), 'Backend', '#D96E54');
        })
        .finally(() => {
          setScoutingBusy(false);
        });
    });
    function setRunButtonsDisabled(disabled) {
      if (btn) btn.disabled = disabled;
      if (fastBtn) fastBtn.disabled = disabled;
      if (scoutBtn) scoutBtn.disabled = disabled;
      if (forecastGame) forecastGame.disabled = disabled;
    }

    function runLifecycle(opts) {
      // The primary Run button drives the full lifecycle controller:
      // scout -> KG crystal -> recruit -> debate -> stake/settle.
      if (DN.lifecycle && DN.lifecycle.start) {
        const withScout = !(opts && opts.scout === false);
        const scoutMode = (opts && opts.scoutMode) || 'openfootball';
        setRunButtonsDisabled(true);
        status.textContent = withScout ? 'Full pipe · OpenFootball scout…' : 'Agent run · no scout…';
        H.pushThought(
          (withScout ? 'Full pipe with OpenFootball scout kicked off — ' : 'Agent run without scouting kicked off — ') + selectedGame.name + '.',
          'Lifecycle',
          '#3FA89F'
        );
        DN.lifecycle.start({ scout: withScout, scoutMode, staticMode: false });
        const timer = setInterval(() => {
          const phase = DN.lifecycle && DN.lifecycle.getPhase ? DN.lifecycle.getPhase() : '';
          if (phase === 'egress_roam' || phase === 'idle') {
            clearInterval(timer);
            setRunButtonsDisabled(false);
            status.textContent = phase === 'egress_roam' ? 'Roaming · click Run to loop' : 'Run ready';
          }
        }, 1000);
      } else if (DN.databridge && DN.databridge.startDemoRun) {
        // Fallback if lifecycle module didn't load: behave as before.
        setRunButtonsDisabled(true);
        status.textContent = 'Starting run...';
        DN.databridge.startDemoRun()
          .then(() => { setRunButtonsDisabled(false); status.textContent = 'Run complete'; })
          .catch(err => { setRunButtonsDisabled(false); status.textContent = 'Run error: ' + (err && err.message || err); });
      }
    }

    // Primary Run skips the KG-only builder. Use Run KG when you want to
    // regenerate and inspect the real match KG before the agent pipeline.
    btn.addEventListener('click', () => runLifecycle({ scout: false }));
    if (fastBtn) fastBtn.addEventListener('click', () => runLifecycle({ scout: false }));
    const resetBtn = $('backend-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (DN.lifecycle && DN.lifecycle.reset) DN.lifecycle.reset();
        setRunButtonsDisabled(false);
        status.textContent = 'Reset · click Run';
      });
    }

    forecastDeployBtn.addEventListener('click', () => {
      if (!DN.databridge || !DN.databridge.deployForecastContract) return;
      setForecastBusy(true);
      status.textContent = 'Deploying contract...';
      H.pushThought('Deploying the Arc forecast market contract.', 'Arc', '#E8A23D');
      DN.databridge.deployForecastContract()
        .then((result) => {
          const receipt = result.receipt || {};
          forecastContract = result.contract || receipt.contract_address || forecastContract;
          logForecastChainTrail('DEPLOY', result);
          status.textContent = 'Contract ' + shortHash(forecastContract);
          H.pushThought('Forecast contract deployed: ' + shortHash(forecastContract) + ' · tx ' + shortHash(receipt.tx_hash || ''), 'Arc', '#3FA89F');
        })
        .catch((err) => {
          status.textContent = 'Deploy error';
          H.pushThought('Deploy failed: ' + (err.message || err), 'Arc', '#D96E54');
        })
        .finally(() => setForecastBusy(false));
    });

    x402BuyBtn.addEventListener('click', () => {
      if (!DN.databridge || !DN.databridge.runX402DemoPayment) return;
      setForecastBusy(true);
      status.textContent = 'Buying KG...';
      H.pushThought('ant-0001 is buying a private KG signal for ' + selectedGame.name + ' from ant-0002 through x402.', 'x402', '#E8A23D');
      DN.databridge.runX402DemoPayment({
        topic: selectedGame.name,
        resource_id: 'kg:' + selectedGame.market_key + ':private-scout-signal',
      })
        .then((result) => {
          const tx = result.gateway_transfer_id || '';
          const amount = result.amount_usdc || '0';
          logX402Trail(result);
          status.textContent = 'x402 paid ' + amount + ' credits';
          H.pushThought('x402 payment complete: ' + result.money_flow + ' for ' + result.resource_id + (tx ? ' · transfer ' + shortHash(tx) : '') + '.', 'x402', '#3FA89F');
        })
        .catch((err) => {
          status.textContent = 'x402 error';
          H.pushThought('x402 payment failed: ' + (err.message || err), 'x402', '#D96E54');
        })
        .finally(() => setForecastBusy(false));
    });

    forecastSetupBtn.addEventListener('click', () => {
      if (!DN.databridge || !DN.databridge.setupForecastDemo) return;
      forecastMarketKey = selectedGame.market_key + ':market-' + Date.now();
      setForecastBusy(true);
      status.textContent = 'Staking...';
      if (DN.logTerm && configuredForecastContract()) {
        DN.logTerm.push('CONTRACT', 'Using Arc forecast contract ' + configuredForecastContract());
      }
      H.pushThought('Creating a fresh Arc market for ' + selectedGame.name + ' and staking ant votes.', 'Arc', '#E8A23D');
      DN.databridge.setupForecastDemo({
        contract: configuredForecastContract() || undefined,
        market_key: forecastMarketKey,
        market_type: selectedGame.market_type || 'three_way',
        metadata_uri: selectedGame.market_key,
        run_id: DN.databridge.runId || undefined,
        wait_for_run_forecasts: true,
        run_forecast_timeout_seconds: 240,
        allow_fallback_stakes: false,
      })
        .then((result) => {
          forecastContract = result.contract || forecastContract;
          forecastStakes = result.stakes || [];
          const totals = result.totals || {};
          logForecastChainTrail('STAKE', result);
          status.textContent = 'Staked ' + (totals.total_usdc || '0') + ' credits';
	          H.pushThought('Arc market funded from real backend forecasts: ' + marketMoneyText(totals, { match: selectedGame }) + '.', 'Arc', '#3FA89F');
        })
        .catch((err) => {
          status.textContent = 'Stake error';
          H.pushThought('Stake failed: ' + (err.message || err), 'Arc', '#D96E54');
        })
        .finally(() => setForecastBusy(false));
    });

    forecastSettleBtn.addEventListener('click', () => {
      if (!DN.databridge || !DN.databridge.settleForecastDemo) return;
      if (!forecastMarketKey) {
        status.textContent = 'Stake first';
        H.pushThought('Create and stake a market before settlement.', 'Arc', '#D96E54');
        return;
      }
      const winner = forecastWinner ? forecastWinner.value : selectedGame.home_team;
      setForecastBusy(true);
      status.textContent = 'Settling ' + winner + '...';
      H.pushThought('Settling the Arc market with winner: ' + winner + '.', 'Arc', '#E8A23D');
      DN.databridge.settleForecastDemo({
        contract: configuredForecastContract() || undefined,
        market_key: forecastMarketKey,
        winner,
        home_team: selectedGame.home_team,
        away_team: selectedGame.away_team,
        winning_agents: forecastStakes
          .filter((stake) => stake.outcome === (winner === selectedGame.home_team ? 'home' : winner === selectedGame.away_team ? 'away' : 'draw'))
          .map((stake) => stake.agent),
      })
        .then((result) => {
          const tx = forecastTx(result);
          const claimed = (result.claimed_agents || []).join(', ') || 'none';
          logForecastChainTrail('SETTLE', result);
          status.textContent = 'Settled · ' + result.result;
          H.pushThought('Settlement complete: winners claimed by ' + claimed + (tx ? ' · tx ' + shortHash(tx) : '') + '.', 'Arc', '#3FA89F');
        })
        .catch((err) => {
          status.textContent = 'Settle error';
          H.pushThought('Settle failed: ' + (err.message || err), 'Arc', '#D96E54');
        })
        .finally(() => setForecastBusy(false));
    });
  }

  function initWalletControl() {
    const root = $('wallet');
    if (!root) return;
    const w = DN.wallet;
    if (!w) {
      root.style.display = 'none';
      return;
    }

    function render() {
      if (!w.installed) {
        root.innerHTML =
          '<div class="wallet-copy"><div class="wallet-k">Wallet</div>' +
          '<div class="wallet-s">Phantom not detected</div></div>' +
          '<a class="wallet-btn" id="wallet-install" href="https://phantom.app/" target="_blank" rel="noopener noreferrer">Get Phantom</a>';
        return;
      }
      if (!w.connected) {
        root.innerHTML =
          '<div class="wallet-copy"><div class="wallet-k">Wallet</div>' +
          '<div class="wallet-s">Phantom ready</div></div>' +
          '<button class="wallet-btn" id="wallet-connect" type="button">Connect Wallet</button>';
        const btn = $('wallet-connect');
        if (btn) btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Connecting…';
          try {
            await w.connect();
            H.pushThought('Wallet connected: ' + w.shortAddress(), 'Wallet', '#3FA89F');
          } catch (err) {
            const msg = (err && err.message) || String(err);
            H.pushThought('Wallet connect failed: ' + msg, 'Wallet', '#D96E54');
            btn.disabled = false;
            btn.textContent = 'Connect Wallet';
          }
        });
        return;
      }
      // connected
      const addr = esc(w.shortAddress());
      root.innerHTML =
        '<div class="wallet-copy"><div class="wallet-k">Wallet</div>' +
        '<div class="wallet-connected">' +
          '<button class="wallet-addr" id="wallet-addr" type="button" title="Copy full address">' + addr + '</button>' +
          '<span class="wallet-badge">Testnet</span>' +
        '</div></div>' +
        '<button class="wallet-btn secondary" id="wallet-disconnect" type="button" title="Disconnect wallet">Disconnect</button>';
      const addrBtn = $('wallet-addr');
      if (addrBtn) addrBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(w.pubkey);
          }
          H.pushThought('Address copied: ' + w.shortAddress(), 'Wallet', '#3FA89F');
        } catch (err) {
          H.pushThought('Copy failed: ' + ((err && err.message) || err), 'Wallet', '#D96E54');
        }
      });
      const offBtn = $('wallet-disconnect');
      if (offBtn) offBtn.addEventListener('click', async () => {
        offBtn.disabled = true;
        try {
          await w.disconnect();
          H.pushThought('Wallet disconnected.', 'Wallet', '#8C7E60');
        } catch (err) {
          H.pushThought('Disconnect failed: ' + ((err && err.message) || err), 'Wallet', '#D96E54');
          offBtn.disabled = false;
        }
      });
    }

    render();
    w.onChange(render);
  }

  H.setActiveBiome = function (i) {
    $('regions').querySelectorAll('.reg').forEach(el => el.classList.toggle('active', parseInt(el.dataset.i) === i));
  };

  H.setActiveSlot = function (idx) {
    $('hotbar').querySelectorAll('.slot').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx) === idx));
  };

  // ---------- top stats ----------
  H.setStats = function (s) {
    $('stats').innerHTML = [
      ['Colonies', s.colonies],
      ['Active Ants', s.ants.toLocaleString()],
      ['Resources', s.resources],
      ['Credits Staked', '<b>' + Math.round(s.staked).toLocaleString() + '</b>'],
      ['Forecast Acc', s.accuracy + '%'],
      ['Round', '#' + s.round]
    ].map(r => `<div class="stat"><div class="sk">${r[0]}</div><div class="sv">${r[1]}</div></div>`).join('');
  };

  // ---------- inspector ----------
  H.clearInspector = function () {
    H._open = null;
    $('inspector').innerHTML = '';
    $('inspector').classList.remove('has-content');
  };

  H.showColony = function (col) {
    $('inspector').classList.add('has-content');
    H._open = { type: 'colony', col };
    const c = hex(col.accent);
    const roster = DN.ants.heroes.filter(a => a.col === col);
    if (col.owner) {
      const config = col._colonyConfig || {};
      const summary = col._antSummary || {};
      const models = summary.models || {};
      const modelRows = Object.keys(models).sort().map(key =>
        `<div class="roster-row"><div class="roster-dot" style="background:${c}"></div><div class="roster-name">${esc(key)}</div><div class="roster-caste">${esc(models[key])}</div></div>`
      ).join('') || '<div class="roster-row"><div class="roster-name">No model summary</div><div class="roster-caste">—</div></div>';
      const target = Number.isFinite(Number(col._rosterTarget))
        ? Number(col._rosterTarget)
        : (Number.isFinite(Number(config.ant_count)) ? Number(config.ant_count) : null);
      $('inspector').innerHTML =
        `<div class="insp-head"><div class="insp-icon" style="background:${c}22;box-shadow:inset 0 0 0 1px ${c}66">
          <div style="width:14px;height:14px;border-radius:50%;background:${c};box-shadow:0 0 12px ${c}"></div></div>
          <div><div class="insp-kicker">Wallet colony</div><div class="insp-name">${esc(col.name)}</div></div></div>
        <div class="metrics">
          <div class="metric"><div class="mk">Alive ants</div><div class="mv" id="m-pop">—</div></div>
          <div class="metric"><div class="mk">Target</div><div class="mv">${target == null ? '—' : esc(target)}</div></div>
          <div class="metric"><div class="mk">Preset</div><div class="mv">${esc(config.preset || '—')}</div></div>
          <div class="metric"><div class="mk">Risk</div><div class="mv">${esc(config.risk_profile || '—')}</div></div>
        </div>
        <div class="vital-bar"><div class="vlabel"><span>Wallet</span><span title="${esc(col.owner)}">${esc(shortPubkey(col.owner))}</span></div></div>
        <div class="section-label">Roster models</div>
        <div class="roster">${modelRows}</div>
        <button class="btn-primary" id="enter-col"><svg viewBox="0 0 24 24"><path d="M12 3l9 6-9 6-9-6z" opacity=".5"/><path d="M3 13l9 6 9-6"/></svg>Enter Colony</button>`;
      $('enter-col').addEventListener('click', () => DN.app.enterColony(col));
      H._updateColony(col);
      return;
    }
    $('inspector').innerHTML =
      `<div class="insp-head"><div class="insp-icon" style="background:${c}22;box-shadow:inset 0 0 0 1px ${c}66">
        <div style="width:14px;height:14px;border-radius:50%;background:${c};box-shadow:0 0 12px ${c}"></div></div>
        <div><div class="insp-kicker">Colony</div><div class="insp-name">${col.name}</div></div></div>
      <div class="metrics">
        <div class="metric"><div class="mk">Population</div><div class="mv" id="m-pop">0</div></div>
        <div class="metric"><div class="mk">Forecast Acc</div><div class="mv" id="m-acc">0<small>%</small></div></div>
        <div class="metric"><div class="mk">Credits Staked</div><div class="mv" id="m-stk">0</div></div>
        <div class="metric"><div class="mk">Reputation</div><div class="mv" id="m-rep">0</div></div>
      </div>
      <div class="vital-bar"><div class="vlabel"><span>Colony health</span><span id="v-health">—</span></div><div class="bar"><i id="b-health" style="background:#5FB84A"></i></div></div>
      <div class="vital-bar" style="margin-top:11px"><div class="vlabel"><span>Food stores</span><span id="v-food">—</span></div><div class="bar"><i id="b-food" style="background:${c}"></i></div></div>
      <div class="section-label">Directive</div>
      <div class="directives">${['forage', 'defend', 'expand'].map(d => `<div class="dir-btn${col.directive === d ? ' active' : ''}" data-dir="${d}">${ICON[d]}${cap(d)}</div>`).join('')}</div>
      <div class="section-label">Field agents · ${roster.length}</div>
      <div class="roster">${roster.map(s => `<div class="roster-row" data-ant="${s.id}"><div class="roster-dot" style="background:${c}"></div><div class="roster-name">${s.name}</div><div class="roster-caste">${s.role}</div></div>`).join('')}</div>
      <button class="btn-primary" id="enter-col"><svg viewBox="0 0 24 24"><path d="M12 3l9 6-9 6-9-6z" opacity=".5"/><path d="M3 13l9 6 9-6"/></svg>Enter Colony</button>`;
    $('inspector').querySelectorAll('.dir-btn').forEach(b => b.addEventListener('click', () => DN.app.setDirective(col, b.dataset.dir)));
    $('inspector').querySelectorAll('.roster-row').forEach(r => r.addEventListener('click', () => {
      const a = DN.ants.heroes.find(x => x.id === r.dataset.ant); if (a) DN.app.selectAnt(a);
    }));
    $('enter-col').addEventListener('click', () => DN.app.enterColony(col));
    H._updateColony(col);
  };

  H._updateColony = function (col) {
    if (!H._open || H._open.type !== 'colony' || H._open.col !== col) return;
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    const setW = (id, v) => { const e = $(id); if (e) e.style.width = v + '%'; };
    if (col.owner) {
      const aliveKnown = Number.isFinite(Number(col._rosterAlive));
      const totalKnown = Number.isFinite(Number(col._rosterTotal));
      let rosterText = '—';
      if (aliveKnown && totalKnown) rosterText = Math.round(Number(col._rosterAlive)) + '/' + Math.round(Number(col._rosterTotal));
      else if (aliveKnown) rosterText = String(Math.round(Number(col._rosterAlive)));
      else if (totalKnown) rosterText = String(Math.round(Number(col._rosterTotal)));
      set('m-pop', rosterText);
      return;
    }
    const displayPopulation = col._rosterLockedPopulation && Number.isFinite(Number(col._rosterPopulation))
      ? Number(col._rosterPopulation)
      : col.stats.population;
    set('m-pop', Math.round(displayPopulation));
    set('m-acc', Math.round(col.stats.accuracy)); set('m-rep', Math.round(col.stats.rep));
    const e = $('m-stk'); if (e) e.innerHTML = '<small>$</small>' + (col.stats.staked / 1000).toFixed(1) + '<small>k</small>';
    set('v-health', Math.round(col.stats.health) + '%'); set('v-food', Math.round(col.stats.food) + '%');
    setW('b-health', col.stats.health); setW('b-food', col.stats.food);
  };

  // Render the Forecast / Outcome / Settled-tx rows for the ant inspector.
  // Pulled from a.forecast (set by lifecycle.deriveOutcomes), a.outcome,
  // and DN.lifecycle.settleTxHash. Returns '' when no forecast data exists.
  function renderForecastOutcome(a) {
    const fc = a && a.forecast;
    const outcome = a && a.outcome;
    if (!fc && !outcome) return '';
    let html = '';
    if (fc) {
      const sideRaw = fc.side || 'draw';
      const selectedGame = currentSelectedGame();
      const context = { match: selectedGame };
      const sideLabel = inspectorMarketSideLabel(sideRaw, context);
      const lean = inspectorQualitativeLean(fc.home_probability, context);
      const stake = fc.stake != null ? Math.round(fc.stake) + ' credits' : '—';
      html += `<div class="vital-bar" style="margin-top:9px"><div class="vlabel">
        <span>Forecast</span>
        <span style="font-family:var(--mono)">${esc(sideLabel)} · ${esc(lean)} · stake ${esc(stake)}</span>
      </div></div>`;
    }
    if (outcome) {
      const tone = outcome === 'correct' ? '#5FB84A' :
                   outcome === 'wrong'   ? '#D96E54' :
                   outcome === 'culled'  ? '#8C7E60' : '#8C7E60';
      const label = outcome === 'correct' ? '✓ correct' :
                    outcome === 'wrong'   ? '✗ wrong' :
                    outcome === 'culled'  ? '☠ culled' : 'pending';
      html += `<div class="vital-bar" style="margin-top:9px"><div class="vlabel">
        <span>Outcome</span>
        <span style="color:${tone};font-weight:600">${label}</span>
      </div></div>`;
    }
    const tx = DN.lifecycle && DN.lifecycle.settleTxHash;
    if (tx) {
      const short = tx.slice(0, 6) + '…' + tx.slice(-4);
      html += `<div class="vital-bar" style="margin-top:9px"><div class="vlabel">
        <span>Settled tx</span>
        <span style="font-family:var(--mono);font-size:11px">${short}</span>
      </div></div>`;
    }
    return html;
  }

  H.showAnt = function (a, following) {
    H._open = { type: 'ant', ant: a };
    $('inspector').classList.add('has-content');
    const c = hex(a.col.accent);
    const rec = a.agentRecord || null;
    const displayName = (rec && (rec.ens_name || rec.name)) || a.name || ('Worker ' + a.id.split('-').slice(-1));
    const wallet = rec && rec.wallet_address;
    const walletShort = wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : null;
    const ens = rec && rec.ens_name;
    const avatar = rec && rec.avatar;
    const status = String((rec && rec.status) || (a.outcome === 'culled' ? 'dead' : 'alive'));
    const isDead = status === 'dead' || status === 'killed' || a.outcome === 'culled';
    const persona = rec && rec.personality && rec.personality.persona;
    const avatarTrait = rec && rec.avatar_trait;
    const parentEns = rec && (rec.parent_ens_name || (rec.parent && rec.parent.ens_name));
    const lineageEns = rec && (rec.lineage_ens_name || (rec.lineage && (rec.lineage.root_name || rec.lineage.ens_name)));
    const identityRows = (ens || wallet) ? `
      ${ens ? `<div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>ENS</span><span style="color:${c};font-family:var(--mono)">${esc(ens)}</span></div></div>` : ''}
      ${parentEns ? `<div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Parent</span><span style="color:${c};font-family:var(--mono)">${esc(parentEns)}</span></div></div>` : ''}
      ${lineageEns && lineageEns !== parentEns ? `<div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Lineage</span><span style="color:${c};font-family:var(--mono)">${esc(lineageEns)}</span></div></div>` : ''}
      ${wallet ? `<div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Wallet</span><span style="font-family:var(--mono);cursor:pointer" title="${esc(wallet)}" data-copy="${esc(wallet)}">${esc(walletShort)}</span></div></div>` : ''}
    ` : '';
    const canReproduce = !!(rec && rec.agent_id && !isDead && DN.databridge && DN.databridge.reproduceAnt);
    const canKill = !!(rec && rec.agent_id && !isDead && DN.databridge && DN.databridge.killAnt);
    $('inspector').innerHTML =
      `<div class="ant-card${isDead ? ' is-dead' : ''}">
        <div class="ant-portrait" style="--ant-accent:${c}">
          ${avatar ? `<img src="${esc(avatar)}" alt="${esc(displayName)} avatar" loading="lazy">` : `<div class="ant-portrait-fallback" style="background:${c};box-shadow:0 0 18px ${c}"></div>`}
          <span class="ant-status">${isDead ? 'Killed' : 'Alive'}</span>
        </div>
        <div class="insp-head ant-card-head">
          <div class="insp-icon" style="background:${c}22;box-shadow:inset 0 0 0 1px ${c}66">
            <div style="width:13px;height:13px;border-radius:3px;background:${c};box-shadow:0 0 10px ${c}"></div>
          </div>
          <div>
            <div class="insp-kicker">${esc(a.role)}${a.hero ? ' · Gen ' + esc(a.gen) : ''}</div>
            <div class="insp-name">${esc(displayName)}</div>
            ${(persona || avatarTrait) ? `<div class="ant-traits">${persona ? esc(persona) : ''}${persona && avatarTrait ? ' · ' : ''}${avatarTrait ? esc(avatarTrait).replace(/-/g, ' ') : ''}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="mk">Forecast Acc</div><div class="mv">${(rec && rec.forecast_accuracy != null) ? Math.round(rec.forecast_accuracy * 100) : (a.accuracy || (52 + (a.inst % 30)))}<small>%</small></div></div>
        <div class="metric"><div class="mk">Bankroll</div><div class="mv">${rec && rec.bankroll != null ? Math.round(rec.bankroll) : (a.reputation || (30 + (a.inst % 50)))}<small>cr</small></div></div>
        <div class="metric"><div class="mk">Credits Staked</div><div class="mv">${rec && rec.staked != null ? Math.round(rec.staked) : (a.staked || (10 + a.inst % 60) + '.0')}<small>cr</small></div></div>
        <div class="metric"><div class="mk">Generation</div><div class="mv">${rec && rec.generation != null ? rec.generation : (a.gen || (1 + a.inst % 8))}</div></div>
      </div>
      <div class="vital-bar"><div class="vlabel"><span>Home colony</span><span style="color:${c}">${a.col.name}</span></div></div>
      <div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Status</span><span style="color:${isDead ? '#D96E54' : '#5FB84A'}">${esc(status)}</span></div></div>
      ${identityRows}
      <div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Current task</span><span id="a-task">—</span></div></div>
      <div class="vital-bar" style="margin-top:9px"><div class="vlabel"><span>Carrying</span><span id="a-cargo">—</span></div></div>
      ${renderForecastOutcome(a)}
      <div class="section-label">Recent activity</div>
      <div class="insp-empty" style="font-size:12px">${antBlurb(a)}</div>
      <div class="ant-actions">
        ${canReproduce ? `<button class="btn-primary ant-action reproduce" id="reproduce-ant" title="Create new ant">
          <svg viewBox="0 0 24 24" style="fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="19" r="2"/><path d="M12 7v5M12 12l-5 5M12 12l5 5"/></svg>
          <span>New ant</span>
        </button>` : ''}
        ${canKill ? `<button class="btn-primary ant-action danger" id="kill-ant" title="Kill ant">
          <svg viewBox="0 0 24 24" style="fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M6 6l12 12M18 6L6 18"/><circle cx="12" cy="12" r="9"/></svg>
          <span>Kill</span>
        </button>` : ''}
      </div>`;
    const followBtn = $('follow-ant');
    if (followBtn) followBtn.addEventListener('click', () => DN.app.toggleFollow(a));
    const reproduceBtn = $('reproduce-ant');
    if (reproduceBtn) {
      const normalHtml = reproduceBtn.innerHTML;
      reproduceBtn.addEventListener('click', () => {
        const parentId = rec.agent_id;
        reproduceBtn.disabled = true;
        reproduceBtn.textContent = 'Creating ant...';
        H.pushThought('Creating a new ant from ' + (ens || parentId) + ': wallet, treasury funding, ENS, and profile image.', 'Lineage', '#5FB84A');
        if (DN.logTerm) DN.logTerm.push('LINEAGE', 'New ant pipeline started from ' + (ens || parentId) + '.');
        DN.databridge.reproduceAnt({ parent_agent_id: parentId })
          .then((payload) => {
            const child = payload.child || {};
            const childName = child.ens_name || child.agent_id || 'child ant';
            const funding = child.funding || {};
            const ensPublication = child.ens_publication || {};
            const fundStatus = funding.status ? ' · funding ' + funding.status : '';
            const ensStatus = ensPublication.status ? ' · ENS ' + ensPublication.status : '';
            const walletLine = child.wallet_address ? ' destination_wallet=' + child.wallet_address : '';
            const profileLine = child.profile_url || (child.agent_id && DN.databridge && DN.databridge.apiUrl ? DN.databridge.apiUrl + '/ants/' + child.agent_id + '.json' : '');
            if (DN.logTerm) {
              DN.logTerm.push('LINEAGE', 'Created new ant ' + childName + ' agent_id=' + (child.agent_id || '?') + walletLine + fundStatus + ensStatus + '.');
              DN.logTerm.push('LINEAGE', 'Funding source: ARC treasury/project ENS wallet; child wallet is the destination.');
              if (funding.explorer_url) DN.logTerm.push('LINEAGE', 'Funding tx ' + funding.explorer_url);
              if (ensPublication.returncode && ensPublication.status === 'failed') DN.logTerm.push('LINEAGE', 'ENS publish failed: ' + (ensPublication.stderr || ensPublication.stdout || 'unknown error'));
              if (profileLine) DN.logTerm.push('LINEAGE', 'Profile JSON ' + profileLine);
              if (payload.source) DN.logTerm.push('LINEAGE', 'Persisted child record at ' + payload.source);
            }
            if (DN.ants && DN.ants.bindAgentRecords && DN.databridge.getAgents) DN.ants.bindAgentRecords(DN.databridge.getAgents());
            const target = DN.ants && DN.ants.attachChildRecord ? DN.ants.attachChildRecord(a, child) : null;
            if (target && DN.app && DN.app.selectAnt) DN.app.selectAnt(target);
            H.pushThought(childName + ' created from parent ' + (child.parent_ens_name || ens || parentId) + fundStatus + ensStatus + '.', 'Lineage', '#5FB84A');
            const afterAvatar = (child.agent_id && DN.databridge && DN.databridge.randomizeAntAvatar)
              ? DN.databridge.randomizeAntAvatar(child.agent_id)
                  .then((avatarPayload) => {
                    const updated = avatarPayload.ant || {};
                    if (updated.agent_id && target) {
                      target.agentRecord = Object.assign({}, child, updated);
                      if (updated.ens_name) target.name = updated.ens_name;
                    }
                    if (DN.logTerm) DN.logTerm.push('LINEAGE', (updated.ens_name || childName) + ' assigned random profile image ' + (avatarPayload.variant || updated.avatar_trait || 'avatar') + '.');
                    return updated;
                  })
                  .catch((err) => {
                    if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Random avatar failed: ' + (err.message || err));
                    return child;
                  })
              : Promise.resolve(child);
            return afterAvatar.then(() => {
              if (!(DN.databridge && DN.databridge.fetchAgents)) return null;
              DN.databridge.fetchAgents().then((fresh) => {
                const agents = (fresh && fresh.agents) || [];
                if (DN.ants && DN.ants.bindAgentRecords) DN.ants.bindAgentRecords(agents);
                const confirmed = agents.some((agent) => agent.agent_id === child.agent_id);
                if (DN.logTerm) {
                  DN.logTerm.push(
                    'LINEAGE',
                    confirmed
                      ? childName + ' confirmed by backend /ants (' + agents.length + ' ants total).'
                      : childName + ' was returned by reproduce but is not visible in /ants yet.',
                  );
                }
              }).catch((err) => {
                if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Could not confirm child via /ants: ' + (err.message || err));
              });
              return null;
            });
          })
          .catch((err) => {
            H.pushThought('Child ant creation failed: ' + (err.message || err), 'Lineage', '#D96E54');
            if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Child ant creation failed: ' + (err.message || err));
          })
          .finally(() => {
            reproduceBtn.disabled = false;
            reproduceBtn.innerHTML = normalHtml;
          });
      });
    }
    const killBtn = $('kill-ant');
    if (killBtn) {
      const normalHtml = killBtn.innerHTML;
      killBtn.addEventListener('click', () => {
        const agentId = rec.agent_id;
        killBtn.disabled = true;
        killBtn.textContent = 'Killing...';
        H.pushThought('Killing ' + (ens || agentId) + ' and removing it from the active colony.', 'Lineage', '#D96E54');
        if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Killing ' + (ens || agentId) + ' from the ant card.');
        DN.databridge.killAnt(agentId, { reason: 'manual_card' })
          .then((payload) => {
            const killed = payload.ant || {};
            const ensPublication = payload.ens_publication || {};
            a.agentRecord = killed;
            a.outcome = 'culled';
            a.state = 'dead';
            a.deadTimer = 0;
            a.dead = true;
            a.permanentDead = true;
            if (DN.ants && DN.ants.showOutcomeGlow) DN.ants.showOutcomeGlow();
            const ensStatus = ensPublication.status ? ' · ENS ' + ensPublication.status : '';
            H.pushThought((killed.ens_name || killed.agent_id || agentId) + ' marked dead' + ensStatus + '.', 'Lineage', '#D96E54');
            if (DN.logTerm) {
              DN.logTerm.push('LINEAGE', (killed.ens_name || killed.agent_id || agentId) + ' marked dead and removed from the active map' + ensStatus + '.');
              if (ensPublication.identity_path) DN.logTerm.push('LINEAGE', 'Kill ENS identity JSON ' + ensPublication.identity_path);
              if (ensPublication.returncode && ensPublication.status === 'failed') DN.logTerm.push('LINEAGE', 'Kill ENS publish failed: ' + (ensPublication.stderr || ensPublication.stdout || 'unknown error'));
            }
            H.showAnt(a, following);
          })
          .catch((err) => {
            H.pushThought('Kill failed: ' + (err.message || err), 'Lineage', '#D96E54');
            if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Kill failed: ' + (err.message || err));
            killBtn.disabled = false;
            killBtn.innerHTML = normalHtml;
          });
      });
    }
    // copy-on-click for the truncated wallet
    $('inspector').querySelectorAll('[data-copy]').forEach(el => {
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-copy');
        if (v && navigator.clipboard) {
          navigator.clipboard.writeText(v).then(() => {
            const orig = el.textContent;
            el.textContent = 'copied';
            setTimeout(() => { el.textContent = orig; }, 900);
          }).catch(() => {});
        }
      });
    });
    H._updateAnt(a);
  };

  function antBlurb(a) {
    const lines = {
      Forecaster: 'Submitted a forecast on Round outcome — confidence rising as peers corroborate evidence.',
      Scout: 'Mapping fresh terrain and tagging resource caches for the foraging columns.',
      Debater: 'Challenging a low-evidence claim in the Debate Hall; staking reputation on the rebuttal.',
      Treasurer: 'Rebalancing the colony vault and settling credit stakes from the last round.',
      Archivist: 'Writing verified outcomes into the Memory Archive for future lineages.'
    };
    return lines[a.role] || 'Foraging along an active pheromone trail and relaying cache positions home.';
  }

  H._updateAnt = function (a) {
    if (!H._open || H._open.type !== 'ant' || H._open.ant !== a) return;
    const t = $('a-task'); if (t) t.textContent = a.state === 'out' ? 'Outbound · scouting' : 'Returning to nest';
    const cg = $('a-cargo'); if (cg) cg.textContent = a.cargo ? 'Data crystal' : 'Empty';
  };

  H.showRoom = function (room, col) {
    H._open = { type: 'room' };
    $('inspector').classList.add('has-content');
    const c = hex(col.accent);
    const blurbs = {
      queen: 'The queen seeds new forecasting agents. Genetics weight toward the round\'s best-performing lineages.',
      nursery: 'Young agents incubate here, inheriting priors from their lineage before their first forecast.',
      forecast: 'Agents analyse live events, defend a pick, and size a survival stake.',
      debate: 'Agents contest each other\'s claims, exchanging evidence. Reputation is won and lost here.',
      storage: 'Verified data crystals and forage are stockpiled and rationed to active agents.',
      economy: 'The colony treasury. Resource flows and inter-colony trades are settled here.',
      memory: 'Outcomes of resolved rounds are archived as immutable memory for future agents.',
      dorm: 'Agents rest and recover energy between forecasting rounds.',
      knowledge: 'Cross-colony knowledge exchange — evidence and models traded between civilizations.',
      lineage: 'The family tree of every agent. High performers found long, decorated lineages.',
      stake: 'Agents stake credits on their forecasts. Accurate calls compound; poor ones are slashed.'
    };
    // live activity rows: count of ants currently in this room + last event
    let active = 0;
    if (DN.underground && DN.underground.agents) {
      for (const a of DN.underground.agents) {
        if (a.roomId === room.id) active++;
      }
      if (room.id === 'queen') active += 1; // queen herself
      if (room.id === 'nursery' && DN.underground.larvae) active += DN.underground.larvae.length;
    }
    const activity = ({
      queen: 'Seeding new lineage',
      nursery: 'Incubating larvae',
      forecast: 'Submitting survival picks',
      debate: 'Exchanging evidence',
      storage: 'Rationing data crystals',
      economy: 'Settling treasury flows',
      memory: 'Archiving outcomes',
      dorm: 'Resting between rounds',
      knowledge: 'Trading cross-colony models',
      lineage: 'Promoting top performers',
      stake: 'Posting credit stakes'
    })[room.prop] || 'Active';
    const events = ({
      queen: 'Brood batch #' + (1200 + Math.floor(Math.random() * 99)) + ' seeded',
      nursery: 'Larva #' + (800 + Math.floor(Math.random() * 199)) + ' graduated',
      forecast: 'Edge +' + (Math.random() * 4 + 1).toFixed(2) + '% on round',
      debate: 'Reputation +' + Math.floor(Math.random() * 8 + 1),
      storage: '+' + Math.floor(Math.random() * 30 + 5) + ' crystals received',
      economy: '+' + (Math.random() * 1200 + 200).toFixed(0) + ' credits settled',
      memory: 'Round #' + Math.floor(Math.random() * 99 + 1) + ' archived',
      dorm: '14 agents resting',
      knowledge: 'Trade w/ Amber Canyon',
      lineage: 'New branch · gen ' + Math.floor(Math.random() * 8 + 4),
      stake: 'Stake ' + (Math.random() * 60 + 10).toFixed(1) + ' credits'
    })[room.prop] || '—';
    $('inspector').innerHTML =
      `<div class="insp-head"><div class="insp-icon" style="background:${c}22;box-shadow:inset 0 0 0 1px ${c}66">
        <div style="width:13px;height:13px;border-radius:3px;background:${c}"></div></div>
        <div><div class="insp-kicker">${col.name} · Chamber</div><div class="insp-name">${room.name}</div></div></div>
      <div class="insp-empty" style="margin-top:14px">${blurbs[room.prop] || ''}</div>
      <div class="insp-rows" style="margin-top:14px">
        <div class="tt-row"><span>Active ants</span><span>${active}</span></div>
        <div class="tt-row"><span>Activity</span><span>${activity}</span></div>
        <div class="tt-row"><span>Latest event</span><span style="color:${c}">${events}</span></div>
      </div>`;
  };

  // ---------- thoughts ----------
  let curLine = null;
  H.pushThought = function (text, tag, color) {
    const stream = $('think-stream'); if (!stream) return;
    const line = document.createElement('div');
    line.className = 'think-line';
    line.innerHTML = `<span class="tag" style="background:${color}26;color:${color}">${tag}</span><span class="ttext">${text}</span>`;
    stream.appendChild(line);
    const prev = curLine; curLine = line;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      line.classList.add('show');
      if (prev) { prev.classList.remove('show'); setTimeout(() => prev.remove(), 600); }
    }));
  };

  // ---------- transport ----------
  H.setTransport = function (t) {
    $('play-icon').innerHTML = t.playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
    $('tl-gen').textContent = 'Generation ' + t.gen;
    $('tl-clock').textContent = t.clock;
    $('tl-fill').style.width = (t.progress * 100) + '%';
    $('tl-knob').style.left = (t.progress * 100) + '%';
    document.querySelectorAll('#speeds .speed').forEach(s => s.classList.toggle('active', parseFloat(s.dataset.s) === t.speed));
  };

  // ---------- modes & banners ----------
  H.setCameraMode = function (m) {
    document.querySelectorAll('#cammode .cm').forEach(el => el.classList.toggle('active', el.dataset.mode === m));
  };
  H.setExploreLocked = function () {};
  H.showEnterBanner = function (col) {
    const b = $('enterbanner');
    b.innerHTML = `<span class="ek">ENTER</span> Descend into ${col.name}`;
    b.classList.add('show');
    b.onclick = () => DN.app.enterColony(col);
  };
  H.hideEnterBanner = function () { $('enterbanner').classList.remove('show'); };
  H.setUnderground = function (on) {
    document.body.classList.toggle('underground', on);
    $('exitbtn').classList.toggle('show', on);
    // Only `backend` (the Run button) is allowed to come back on surface;
    // everything else stays hidden per the MVP minimal-chrome policy.
    const back = $('backend'); if (back) back.style.display = on ? 'none' : '';
    // Belt-and-braces: ensure the rest stays hidden in both modes.
    // Inspector is excluded — its visibility is class-driven.
    ['stats', 'hotbar', 'transport', 'thoughts', 'cammode', 'brand', 'regions', 'enterbanner', 'keys'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
    if (H._ugRoot) H._ugRoot.style.display = 'none';
    if (on) {
      H._open = null;
    } else {
      H.clearInspector();
    }
  };

  // ---------------------------------------------------------------------
  // Underground game UI (Phase 3) — full dashboard overlay matching the
  // amber/gold "Ant Colony" mockup. Built once via DOM injection and
  // toggled visible on enter/exit. Numbers update at ~4Hz from a
  // lightweight tick loop so the panels feel alive.
  // ---------------------------------------------------------------------
  H._ensureUgGameUi = function () {
    if (H._ugRoot) return;
    // ---- inject css once ----
    const css = `
      #ug-game * { box-sizing: border-box; }
      #ug-game {
        position: fixed; inset: 0; z-index: 4; pointer-events: none;
        font-family: var(--font), "Inter", system-ui, sans-serif;
        color: #F1D8A8;
      }
      #ug-game .ug-panel {
        background: linear-gradient(180deg, rgba(34,20,10,0.92), rgba(22,12,6,0.95));
        border: 1px solid rgba(196,142,68,0.35);
        border-radius: 12px;
        box-shadow: 0 6px 22px -10px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,200,130,0.06);
        pointer-events: auto;
        backdrop-filter: blur(8px) saturate(1.05);
        -webkit-backdrop-filter: blur(8px) saturate(1.05);
      }
      #ug-game .ug-section { padding: 14px 16px; }
      #ug-game .ug-section + .ug-section { border-top: 1px solid rgba(196,142,68,0.18); }
      #ug-game .ug-kicker {
        font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase;
        color: rgba(241,216,168,0.55); font-weight: 600; margin-bottom: 12px;
      }

      /* ---- TOP BAR ---- */
      #ug-topbar { position: fixed; top: 14px; left: 14px; right: 14px; display: flex; gap: 10px; align-items: stretch; pointer-events: none; }
      #ug-brand { display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-width: 220px; }
      #ug-brand .hex {
        width: 36px; height: 36px; background: linear-gradient(140deg,#3a2210,#1c0e06);
        border: 1px solid rgba(196,142,68,0.6); border-radius: 9px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: inset 0 1px 0 rgba(255,200,130,0.18);
      }
      #ug-brand .hex svg { width: 22px; height: 22px; fill: #E8B85A; }
      #ug-brand .brand-text h1 {
        font-family: "Press Start 2P", var(--display); font-size: 14px;
        letter-spacing: 2px; color: #F4DCA0; margin: 0; line-height: 1.1;
      }
      #ug-brand .brand-text p { font-size: 10px; color: rgba(241,216,168,0.45); margin: 4px 0 0; letter-spacing: 1px; text-transform: uppercase; }

      #ug-resources { display: flex; gap: 10px; flex: 1; }
      .ug-res { display: flex; align-items: center; gap: 12px; padding: 10px 16px; flex: 1; min-width: 0; }
      .ug-res .ico { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex-shrink: 0;
        background: rgba(50,30,14,0.7); border: 1px solid rgba(196,142,68,0.25); }
      .ug-res .ico svg { width: 18px; height: 18px; }
      .ug-res .label { font-size: 10px; color: rgba(241,216,168,0.5); letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 2px; }
      .ug-res .val { font-size: 16px; font-weight: 700; color: #F4DCA0; font-family: var(--mono), ui-monospace, monospace; }
      .ug-res .rate { font-size: 11px; color: #6DD68A; margin-left: 6px; font-family: var(--mono); }

      .ug-strength { display: flex; align-items: center; gap: 12px; padding: 10px 18px; }
      .ug-strength .ico { background: linear-gradient(135deg,#4a2a14,#2a1408); border: 1px solid rgba(196,142,68,0.45); border-radius: 8px; width: 32px; height: 32px; display: grid; place-items: center; }
      .ug-strength .ico svg { width: 18px; height: 18px; fill: #E8B85A; }
      .ug-strength .label { font-size: 10px; color: rgba(241,216,168,0.55); letter-spacing: 1.5px; text-transform: uppercase; }
      .ug-strength .val { font-size: 18px; font-weight: 700; color: #F4DCA0; font-family: var(--mono); }

      .ug-iconbtn { width: 44px; height: 44px; display: grid; place-items: center; padding: 0; cursor: pointer; }
      .ug-iconbtn svg { width: 18px; height: 18px; fill: #E8B85A; opacity: 0.85; }
      .ug-iconbtn:hover svg { opacity: 1; }

      /* ---- LEFT SIDEBAR ---- */
      #ug-leftbar { position: fixed; left: 14px; top: 82px; bottom: 64px; width: 250px; display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
      #ug-overview, #ug-status { pointer-events: auto; }
      #ug-nav { display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; }
      .ug-nav-row {
        display: flex; align-items: center; gap: 12px;
        padding: 9px 12px; border-radius: 9px; cursor: pointer;
        color: rgba(241,216,168,0.7); font-size: 13px; font-weight: 500;
        transition: background 120ms ease, color 120ms ease;
      }
      .ug-nav-row svg { width: 16px; height: 16px; fill: currentColor; opacity: 0.9; }
      .ug-nav-row:hover { background: rgba(196,142,68,0.08); color: #F4DCA0; }
      .ug-nav-row.active {
        background: linear-gradient(90deg, rgba(232,184,90,0.18), rgba(232,184,90,0.04));
        color: #FFD988; border: 1px solid rgba(232,184,90,0.35);
      }

      .ug-stat-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 12px; }
      .ug-stat-row .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; margin-right: 8px; }
      .ug-stat-row .name { color: rgba(241,216,168,0.78); display: flex; align-items: center; }
      .ug-stat-row .num { color: #F4DCA0; font-family: var(--mono); font-weight: 600; }

      .ug-buff { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
      .ug-buff .b-ico { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; flex-shrink: 0;
        background: rgba(50,30,14,0.7); border: 1px solid rgba(196,142,68,0.3); }
      .ug-buff .b-ico svg { width: 14px; height: 14px; }
      .ug-buff .b-name { font-size: 12px; color: #F4DCA0; font-weight: 600; }
      .ug-buff .b-sub { font-size: 10px; color: rgba(241,216,168,0.5); margin-top: 2px; letter-spacing: 0.5px; }
      .ug-buff .b-time { margin-left: auto; font-size: 10px; color: rgba(241,216,168,0.65); font-family: var(--mono); }

      #ug-log-btn {
        pointer-events: auto; display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 12px 16px; cursor: pointer; font-size: 11px;
        letter-spacing: 2px; text-transform: uppercase; color: #F4DCA0;
      }
      #ug-log-btn svg { width: 14px; height: 14px; fill: currentColor; opacity: 0.7; }
      #ug-log-btn:hover svg { opacity: 1; }

      #ug-zoom { pointer-events: auto; display: flex; align-items: center; gap: 4px; padding: 6px 8px; align-self: flex-start; }
      #ug-zoom button { width: 30px; height: 30px; display: grid; place-items: center; cursor: pointer; color: #F4DCA0; }
      #ug-zoom .pct { padding: 0 10px; font-family: var(--mono); font-size: 12px; color: #F4DCA0; }

      /* ---- RIGHT SIDEBAR ---- */
      #ug-rightbar { position: fixed; right: 14px; top: 82px; bottom: 14px; width: 260px; display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
      #ug-blurb, #ug-objective, #ug-events, #ug-actions { pointer-events: auto; }
      #ug-blurb h3 { font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase; color: rgba(241,216,168,0.55); margin: 0 0 10px; font-weight: 600; }
      #ug-blurb p { font-size: 12px; line-height: 1.6; color: rgba(241,216,168,0.78); margin: 0 0 8px; }

      .ug-obj-card { display: flex; align-items: flex-start; gap: 12px; }
      .ug-obj-card .ic { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; flex-shrink: 0;
        background: linear-gradient(135deg, rgba(160,90,200,0.32), rgba(80,40,110,0.42));
        border: 1px solid rgba(180,110,220,0.4); }
      .ug-obj-card .ic svg { width: 18px; height: 18px; fill: #E6C8FA; }
      .ug-obj-card .title { font-size: 13px; color: #F4DCA0; font-weight: 600; margin-bottom: 3px; }
      .ug-obj-card .sub { font-size: 11px; color: rgba(241,216,168,0.6); line-height: 1.45; }
      .ug-progress { margin-top: 12px; position: relative; height: 8px; background: rgba(50,30,14,0.7); border-radius: 999px; overflow: hidden; }
      .ug-progress .fill { position: absolute; inset: 0; width: 67%;
        background: linear-gradient(90deg,#E8B85A,#FFD988);
        box-shadow: 0 0 10px rgba(232,184,90,0.4); border-radius: 999px;
      }
      .ug-progress .pct { position: absolute; right: 6px; top: -2px;
        font-size: 9px; font-family: var(--mono); color: #2A1A08;
        background: #FFD988; padding: 1px 6px; border-radius: 999px;
        line-height: 12px; transform: translateY(-3px);
      }

      .ug-event { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 12px; }
      .ug-event .ic { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex-shrink: 0;
        background: rgba(50,30,14,0.7); border: 1px solid rgba(196,142,68,0.3); }
      .ug-event .ic svg { width: 12px; height: 12px; }
      .ug-event .name { flex: 1; color: rgba(241,216,168,0.85); }
      .ug-event .when { font-family: var(--mono); font-size: 10px; color: rgba(241,216,168,0.55); }

      #ug-viewall { display: block; margin-top: 12px; width: 100%; padding: 9px;
        background: rgba(196,142,68,0.10); border: 1px solid rgba(196,142,68,0.35);
        border-radius: 8px; color: #FFD988; text-align: center; cursor: pointer;
        font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;
      }
      #ug-viewall:hover { background: rgba(196,142,68,0.18); }

      .ug-action { display: flex; align-items: center; gap: 12px; width: 100%;
        padding: 10px 12px; margin-top: 8px;
        background: rgba(50,30,14,0.5); border: 1px solid rgba(196,142,68,0.25);
        border-radius: 9px; cursor: pointer; color: #F4DCA0; font-size: 12px; text-align: left;
        font-family: inherit;
      }
      .ug-action:first-of-type { margin-top: 0; }
      .ug-action:hover { background: rgba(196,142,68,0.12); border-color: rgba(196,142,68,0.45); }
      .ug-action .ic { width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; flex-shrink: 0;
        background: rgba(80,46,18,0.85); }
      .ug-action .ic svg { width: 14px; height: 14px; fill: #E8B85A; }

      /* ---- LEGEND ---- */
      #ug-legend { position: fixed; bottom: 14px; left: 280px; right: 290px;
        display: flex; justify-content: center; gap: 28px; pointer-events: none; padding: 10px 16px; }
      .ug-legend-item { display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: 1px;
        color: rgba(241,216,168,0.7); text-transform: uppercase; pointer-events: auto;
      }
      .ug-legend-item .swatch { width: 9px; height: 9px; border-radius: 999px; }

      /* ---- DEBUG TOGGLE (bottom-left, repositioned) ---- */
      #ug-debug-btn { pointer-events: auto; padding: 6px 12px; cursor: pointer;
        font-family: var(--mono); font-size: 10px; letter-spacing: 1.5px;
        text-transform: uppercase; color: rgba(241,216,168,0.7);
      }
      #ug-debug-btn.on { color: #66E0FF; }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'ug-game-css';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    // ---- icon library (inline SVG) ----
    const svgs = {
      hex: '<svg viewBox="0 0 24 24"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm-6 6.5l6-3.7 6 3.7v7l-6 3.7-6-3.7v-7z"/></svg>',
      leaf: '<svg viewBox="0 0 24 24"><path fill="#6DD68A" d="M17 5C9 5 5 9 5 17c0 2 .3 3 .3 3s4-1 7-4c2.8-2.7 5-7 5-9-1 .5-3 2-4 4 .5-2 2-4 4-5-1 .2-4 1.5-5 3 .5-1.5 1-2.5 2-3-1 0-4 1-6 4 0-1.8 0-3 1-5z"/></svg>',
      rock: '<svg viewBox="0 0 24 24"><path fill="#B5A892" d="M6 16l2-7 5-3 5 2 3 5-3 5-7 1-5-3z"/></svg>',
      drop: '<svg viewBox="0 0 24 24"><path fill="#E8B85A" d="M12 3c-1 2-6 7-6 11a6 6 0 0 0 12 0c0-4-5-9-6-11z"/></svg>',
      shield: '<svg viewBox="0 0 24 24"><path d="M12 2L4 5v7c0 5 4 9 8 10 4-1 8-5 8-10V5l-8-3z"/></svg>',
      bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
      book: '<svg viewBox="0 0 24 24"><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4zm16 0h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7V4z"/></svg>',
      gear: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4a9 9 0 0 0-.2-1.8l2-1.6-2-3.4-2.4.8a8.9 8.9 0 0 0-3.1-1.8L15 2h-4l-.4 2.2a8.9 8.9 0 0 0-3 1.8L5.2 5.2 3.2 8.6l2 1.6a9 9 0 0 0 0 3.6l-2 1.6 2 3.4 2.4-.8a8.9 8.9 0 0 0 3 1.8L11 22h4l.4-2.2a8.9 8.9 0 0 0 3.1-1.8l2.3.8 2-3.4-2-1.6a9 9 0 0 0 .2-1.8z"/></svg>',
      map: '<svg viewBox="0 0 24 24"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 2.2L13.8 8v9.8L9 16v-9.8zM5 7.4l2 .6v9.8l-2 .6V7.4zm12 0v9.8l-2 .6V8l2-.6z"/></svg>',
      worker: '<svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM4 19v-1a6 6 0 0 1 16 0v1H4z"/></svg>',
      upgrade: '<svg viewBox="0 0 24 24"><path d="M12 3l8 8h-4v10h-8V11H4z"/></svg>',
      flask: '<svg viewBox="0 0 24 24"><path d="M9 3h6v3l5 11a3 3 0 0 1-3 4H7a3 3 0 0 1-3-4l5-11V3z"/></svg>',
      quest: '<svg viewBox="0 0 24 24"><path d="M6 2h10l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm2 7h8v2H8V9zm0 4h8v2H8v-2z"/></svg>',
      chart: '<svg viewBox="0 0 24 24"><path d="M4 20h16v2H2V2h2v18zm4-3h2V9H8v8zm4 0h2V5h-2v12zm4 0h2v-6h-2v6z"/></svg>',
      log: '<svg viewBox="0 0 24 24"><path d="M5 5h14v2H5V5zm0 4h14v2H5V9zm0 4h14v2H5v-2zm0 4h8v2H5v-2z"/></svg>',
      chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
      minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.4" fill="none"/></svg>',
      plus: '<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="2.4" fill="none"/></svg>',
      target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
      boostFood: '<svg viewBox="0 0 24 24"><path fill="#6DD68A" d="M6 18l4-12 4 8 4-4 2 8H6z"/></svg>',
      boostSpd: '<svg viewBox="0 0 24 24"><path fill="#66E0FF" d="M4 12h10l-4-4 1.5-1.5L18 12l-6.5 6.5L10 17l4-4H4z"/></svg>',
      boostDef: '<svg viewBox="0 0 24 24"><path fill="#E8B85A" d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6l8-3z"/></svg>',
      eventBoost: '<svg viewBox="0 0 24 24"><path fill="#E8869A" d="M12 4l2.5 5 5.5.8-4 4 1 5.5L12 16.8 7 19.3l1-5.5-4-4 5.5-.8z"/></svg>',
      eventLarva: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="6" ry="9" fill="#FFD988"/></svg>',
      eventBuild: '<svg viewBox="0 0 24 24"><path fill="#C68A56" d="M4 10l8-6 8 6v10H4V10z"/></svg>',
      train: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3" fill="#E8B85A"/><path fill="#E8B85A" d="M6 20v-2a6 6 0 0 1 12 0v2H6z"/></svg>',
      gather: '<svg viewBox="0 0 24 24"><path fill="#6DD68A" d="M17 5C9 5 5 9 5 17c2 0 8-2 11-5 2-2 3-5 3-7-2 1-4 3-5 5 1-2 2-4 4-5-2 1-5 2-6 4z"/></svg>',
      build: '<svg viewBox="0 0 24 24"><path fill="#E8B85A" d="M12 3l8 8h-4v10h-8V11H4z"/></svg>'
    };

    // ---- build dom ----
    const root = document.createElement('div');
    root.id = 'ug-game';
    root.style.display = 'none';

    // TOP BAR
    const topbar = el('div', { id: 'ug-topbar' });
    const brand = el('div', { id: 'ug-brand', className: 'ug-panel' });
    brand.innerHTML = `<div class="hex">${svgs.hex}</div>
      <div class="brand-text"><h1>ANT COLONY</h1><p>Living Cross-Chain Civ</p></div>`;
    topbar.appendChild(brand);

    const resources = el('div', { id: 'ug-resources' });
    const resDefs = [
      { id: 'food', label: 'Food', icon: svgs.leaf, val: '12.4K', rate: '+320 /h' },
      { id: 'leaves', label: 'Leaves', icon: svgs.leaf, val: '8.7K', rate: '+210 /h' },
      { id: 'minerals', label: 'Minerals', icon: svgs.rock, val: '6.2K', rate: '+180 /h' },
      { id: 'larvae', label: 'Larvae', icon: svgs.drop, val: '3.1K', rate: '+90 /h' }
    ];
    resDefs.forEach(r => {
      const pill = el('div', { className: 'ug-panel ug-res' });
      pill.innerHTML = `<div class="ico">${r.icon}</div>
        <div><div class="label">${r.label}</div>
          <div><span class="val" data-res="${r.id}">${r.val}</span><span class="rate">${r.rate}</span></div>
        </div>`;
      resources.appendChild(pill);
    });
    topbar.appendChild(resources);

    const strength = el('div', { className: 'ug-panel ug-strength' });
    strength.innerHTML = `<div class="ico">${svgs.shield}</div>
      <div><div class="label">Colony Strength</div><div class="val" id="ug-strength-val">8,450</div></div>`;
    topbar.appendChild(strength);

    ['bell', 'book', 'gear'].forEach(k => {
      const b = el('div', { className: 'ug-panel ug-iconbtn' });
      b.innerHTML = svgs[k];
      topbar.appendChild(b);
    });
    root.appendChild(topbar);

    // LEFT SIDEBAR
    const leftbar = el('div', { id: 'ug-leftbar' });
    const overview = el('div', { id: 'ug-overview', className: 'ug-panel' });
    const overTitle = el('div', { className: 'ug-section' });
    overTitle.innerHTML = `<div class="ug-kicker">Overview</div>`;
    const navWrap = el('div', { className: 'ug-section', id: 'ug-nav' });
    [
      { id: 'map', label: 'Colony Map', ic: svgs.map, active: true },
      { id: 'workers', label: 'Workers', ic: svgs.worker },
      { id: 'upgrades', label: 'Upgrades', ic: svgs.upgrade },
      { id: 'research', label: 'Research', ic: svgs.flask },
      { id: 'quests', label: 'Quests', ic: svgs.quest },
      { id: 'stats', label: 'Statistics', ic: svgs.chart }
    ].forEach(n => {
      const row = el('div', { className: 'ug-nav-row' + (n.active ? ' active' : '') });
      row.innerHTML = `${n.ic}<span>${n.label}</span>`;
      navWrap.appendChild(row);
    });
    overview.appendChild(overTitle);
    overview.appendChild(navWrap);
    leftbar.appendChild(overview);

    // status panel
    const status = el('div', { id: 'ug-status', className: 'ug-panel' });
    const statSec = el('div', { className: 'ug-section' });
    statSec.innerHTML = `<div class="ug-kicker">Colony Status</div>
      <div class="ug-stat-row"><span class="name"><span class="dot" style="background:#E8B85A"></span>Population</span><span class="num" id="ug-pop">2,340</span></div>
      <div class="ug-stat-row"><span class="name"><span class="dot" style="background:#E8B85A"></span>Workers</span><span class="num" id="ug-workers">1,890</span></div>
      <div class="ug-stat-row"><span class="name"><span class="dot" style="background:#66E0FF"></span>Soldiers</span><span class="num" id="ug-soldiers">280</span></div>
      <div class="ug-stat-row"><span class="name"><span class="dot" style="background:#B47EE0"></span>Larvae</span><span class="num" id="ug-larvae">170</span></div>`;
    status.appendChild(statSec);
    const buffSec = el('div', { className: 'ug-section' });
    buffSec.innerHTML = `<div class="ug-kicker">Active Buffs</div>
      <div class="ug-buff"><div class="b-ico">${svgs.boostFood}</div>
        <div><div class="b-name">Food Gathering I</div><div class="b-sub">+10% Food</div></div>
        <div class="b-time" data-buff="food">12:45</div></div>
      <div class="ug-buff"><div class="b-ico">${svgs.boostSpd}</div>
        <div><div class="b-name">Movement Boost</div><div class="b-sub">+15% Speed</div></div>
        <div class="b-time" data-buff="spd">08:30</div></div>
      <div class="ug-buff"><div class="b-ico">${svgs.boostDef}</div>
        <div><div class="b-name">Defense Up I</div><div class="b-sub">+10% Defense</div></div>
        <div class="b-time" data-buff="def">15:20</div></div>`;
    status.appendChild(buffSec);
    leftbar.appendChild(status);

    const logBtn = el('div', { id: 'ug-log-btn', className: 'ug-panel' });
    logBtn.innerHTML = `${svgs.log} <span style="flex:1">Colony Log</span> ${svgs.chev}`;
    leftbar.appendChild(logBtn);

    const zoom = el('div', { id: 'ug-zoom', className: 'ug-panel' });
    zoom.innerHTML = `<button title="Zoom out">${svgs.minus}</button>
      <span class="pct">100%</span>
      <button title="Zoom in">${svgs.plus}</button>
      <button id="ug-debug-btn" title="Toggle debug graph">${svgs.target}</button>`;
    leftbar.appendChild(zoom);
    root.appendChild(leftbar);

    // RIGHT SIDEBAR
    const rightbar = el('div', { id: 'ug-rightbar' });

    const blurb = el('div', { id: 'ug-blurb', className: 'ug-panel ug-section' });
    blurb.innerHTML = `<h3>Inside the Colony</h3>
      <p>A living cross-chain colony.</p>
      <p>Click any chamber to command your agents and manage resources.</p>`;
    rightbar.appendChild(blurb);

    const obj = el('div', { id: 'ug-objective', className: 'ug-panel ug-section' });
    obj.innerHTML = `<div class="ug-kicker">Current Objective</div>
      <div class="ug-obj-card">
        <div class="ic">${svgs.quest}</div>
        <div><div class="title">Expand the Nursery</div><div class="sub">Upgrade Nursery to level 3</div></div>
      </div>
      <div class="ug-progress"><div class="fill"></div><div class="pct">2 / 3</div></div>`;
    rightbar.appendChild(obj);

    const events = el('div', { id: 'ug-events', className: 'ug-panel ug-section' });
    events.innerHTML = `<div class="ug-kicker">Events</div>
      <div class="ug-event"><div class="ic">${svgs.eventBoost}</div><span class="name">Resource boost</span><span class="when">07:45</span></div>
      <div class="ug-event"><div class="ic">${svgs.eventLarva}</div><span class="name">New larvae ready</span><span class="when">12:30</span></div>
      <div class="ug-event"><div class="ic">${svgs.eventBuild}</div><span class="name">Chamber complete</span><span class="when">18:20</span></div>
      <button id="ug-viewall">View all</button>`;
    rightbar.appendChild(events);

    const actions = el('div', { id: 'ug-actions', className: 'ug-panel ug-section' });
    actions.innerHTML = `<div class="ug-kicker">Quick Actions</div>
      <button class="ug-action"><div class="ic">${svgs.train}</div>Train Workers</button>
      <button class="ug-action"><div class="ic">${svgs.gather}</div>Gather Resources</button>
      <button class="ug-action"><div class="ic">${svgs.build}</div>Upgrade Chamber</button>`;
    rightbar.appendChild(actions);
    root.appendChild(rightbar);

    // LEGEND
    const legend = el('div', { id: 'ug-legend', className: 'ug-panel ug-section' });
    legend.style.padding = '8px 24px';
    [['#6DD68A', 'Resource'], ['#E8B85A', 'Production'], ['#66E0FF', 'Storage'], ['#B47EE0', 'Special']].forEach(([c, l]) => {
      const item = el('div', { className: 'ug-legend-item' });
      item.innerHTML = `<span class="swatch" style="background:${c};box-shadow:0 0 8px ${c}55"></span>${l}`;
      legend.appendChild(item);
    });
    root.appendChild(legend);

    document.body.appendChild(root);
    H._ugRoot = root;

    // ---- wire interactivity ----
    const debugBtn = root.querySelector('#ug-debug-btn');
    if (debugBtn) debugBtn.addEventListener('click', () => {
      const on = DN.underground.toggleDebug();
      debugBtn.classList.toggle('on', on);
    });
    // nav rows just switch active styling — no actual routing yet
    navWrap.querySelectorAll('.ug-nav-row').forEach(row => {
      row.addEventListener('click', () => {
        navWrap.querySelectorAll('.ug-nav-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
      });
    });

    // ---- live tick (~4Hz) ----
    H._ugTickStart = Date.now();
    setInterval(() => H._ugTick(), 250);
  };

  // little DOM helper
  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'className') e.className = props[k];
      else if (k === 'id') e.id = props[k];
      else if (k === 'style') e.style.cssText = props[k];
      else e.setAttribute(k, props[k]);
    }
    return e;
  }

  H._applyUgAccent = function (hex) {
    if (!H._ugRoot) return;
    const c = '#' + hex.toString(16).padStart(6, '0');
    // currently only the progress fill uses the accent; the rest stays warm gold
    const fill = H._ugRoot.querySelector('.ug-progress .fill');
    if (fill) fill.style.background = `linear-gradient(90deg, ${c}, ${c}AA)`;
  };

  // ~4Hz updater for resource numbers, buff timers, population.
  H._ugTick = function () {
    if (!H._ugRoot || H._ugRoot.style.display === 'none') return;
    const t = (Date.now() - H._ugTickStart) / 1000;
    const $$ = sel => H._ugRoot.querySelector(sel);

    // live ant counts from the underground sim
    const u = DN.underground;
    if (u && u.agents) {
      const workerCount = u.agents.length;
      const larvaeCount = u.larvae ? u.larvae.length : 0;
      const pop = workerCount + larvaeCount + 1; // +queen
      // smooth-up display numbers
      const popEl = $$('#ug-pop'); if (popEl) popEl.textContent = String(2300 + pop).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const wEl = $$('#ug-workers'); if (wEl) wEl.textContent = String(1850 + workerCount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const lEl = $$('#ug-larvae'); if (lEl) lEl.textContent = String(170 + larvaeCount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    // resource drift — gentle increments tied to t for liveness
    const drift = i => (12.4 + i * 0.4 + t * 0.001).toFixed(1) + 'K';
    H._ugRoot.querySelectorAll('[data-res]').forEach((node, i) => { node.textContent = drift(i); });

    // buff timers count down
    const fmt = sec => {
      const m = Math.max(0, Math.floor(sec / 60));
      const s = Math.max(0, Math.floor(sec % 60));
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    H._ugRoot.querySelectorAll('[data-buff]').forEach((node, i) => {
      const baselines = [12 * 60 + 45, 8 * 60 + 30, 15 * 60 + 20];
      node.textContent = fmt(baselines[i] - t);
    });
  };

  return H;
})();
