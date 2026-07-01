// WorldColony — data bridge: seeds the colonies' stats and the thoughts ticker
// from the REAL harness output. Non-invasive: main.js
// prefers DN.databridge.nextThought() when ready, and we seed DN.colony.list
// stats once the colonies exist. Everything degrades gracefully if the file
// is missing (the app falls back to its synthetic content).
window.DN = window.DN || {};

DN.databridge = (function () {
  const cfg = window.DN_CONFIG || {};
  const apiOverride = (function () {
    try {
      return new URLSearchParams(window.location.search).get('api') || '';
    } catch (err) {
      return '';
    }
  })();
  const apiUrl = (apiOverride || cfg.API_URL || '').replace(/\/$/, '');
  const B = { ready: false, source: null, apiUrl, runId: null };
  let thoughts = [];
  let ti = 0;
  let records = [], forecasts = [], rooms = [], summary = null;
  let runEvents = [];
  let activeMarketMatch = null;
  const COL = { debate: '#8E79C4', forecast: '#3FA89F', economy: '#E8A23D', lineage: '#D96E54' };

  const r1 = (n) => Math.round((n || 0) * 10) / 10;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function marketOutcomeLabels(source) {
    const match = (source && (source.match || source.market || source.metadata)) || activeMarketMatch || {};
    const first = match.home_team || match.team1 || match.team_a ||
      (source && (source.home_team || source.team1 || source.team_a)) || 'Team A';
    const second = match.away_team || match.team2 || match.team_b ||
      (source && (source.away_team || source.team2 || source.team_b)) || 'Team B';
    return { home: first, draw: 'Draw', away: second };
  }

  function marketSideLabel(side, source) {
    const labels = marketOutcomeLabels(source);
    if (side === 'pass') return 'No stake';
    return labels[side] || String(side || 'unknown');
  }

  function qualitativeLean(homeProbability, source) {
    if (homeProbability == null) return '';
    const value = Number(homeProbability);
    if (!Number.isFinite(value)) return '';
    const labels = marketOutcomeLabels(source);
    if (value >= 0.62) return ' · strong ' + labels.home + ' lean';
    if (value >= 0.54) return ' · soft ' + labels.home + ' lean';
    if (value <= 0.38) return ' · strong ' + labels.away + ' lean';
    if (value <= 0.46) return ' · soft ' + labels.away + ' lean';
    return ' · balanced lean';
  }

  function marketSideCountsText(values, source) {
    return ['home', 'draw', 'away'].map((side) => {
      const raw = values && values[side] != null ? values[side] : 0;
      return marketSideLabel(side, source) + '=' + raw;
    }).join(' · ');
  }

  B.marketOutcomeLabels = marketOutcomeLabels;
  B.marketSideLabel = marketSideLabel;

  function rememberMarketMatch(body) {
    body = body || {};
    if (body.home_team && body.away_team) {
      activeMarketMatch = { home_team: body.home_team, away_team: body.away_team };
      return;
    }
    const label = String(body.match || '');
    const parts = label.split(/\s+v(?:s\.?)?\s+/i);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      activeMarketMatch = { home_team: parts[0].trim(), away_team: parts.slice(1).join(' vs ').trim() };
    }
  }

  function build(events) {
    const marketEvent = events.find((e) => e && e.match && e.match.home_team && e.match.away_team);
    if (marketEvent) rememberMarketMatch(marketEvent.match);
    records = events.filter((e) => e.event_type === 'agent_record');
    forecasts = events.filter((e) => e.event_type === 'forecast');
    rooms = events.filter((e) => e.event_type === 'debate_room');
    const debates = events.filter((e) => e.event_type === 'debate_claim');
    summary = events.find((e) => e.event_type === 'round_summary') || null;
    B.agents = records;
    B.forecasts = forecasts;
    B.rooms = rooms;
    B.summary = summary;

    const q = [];
    if (summary) {
      const lean = qualitativeLean(summary.market_home_probability, summary).replace(/^ · /, '');
      q.push([
        'Round resolved — ' + lean +
          ', ' + r1(summary.total_staked) + ' credits committed across ' + summary.population +
          ' agents (' + marketSideCountsText({ home: summary.home_bets, draw: summary.draw_bets, away: summary.away_bets }, summary) + ').',
        'Forecast', COL.economy,
      ]);
    }
    // real debate transcript lines (already human-readable)
    debates.forEach((d) => {
      if (d.message) q.push([d.message, 'Debate', COL.debate]);
    });
    // strongest real bets
    forecasts
      .filter((f) => f.side && f.stake > 0)
      .sort((a, b) => b.stake - a.stake)
      .slice(0, 8)
      .forEach((f) => {
        const agent = records.find((r) => r.agent_id === f.agent_id);
        const nm = (agent && (agent.ens_name || agent.name)) || (f.agent_id || 'agent').replace('_', '-');
        const lean = qualitativeLean(f.home_probability, summary || f).replace(/^ · /, '');
        q.push([
          nm + ' commits ' + r1(f.stake) + ' credits on ' + marketSideLabel(f.side, summary || f) +
            ' · ' + lean + ' · edge read ' + r1(f.edge),
          'Forecast', COL.forecast,
        ]);
      });
    // lineage leader
    const top = records.slice().sort((a, b) => b.bankroll - a.bankroll)[0];
    if (top) {
      q.push([
        (top.ens_name || top.name || top.agent_id) + ' leads the gene pool — ' +
          Math.round(top.accuracy * 100) + '% accuracy, ' + r1(top.bankroll) + ' credits bankroll.',
        'Lineage', COL.lineage,
      ]);
      if (top.wallet_address) {
        q.push([
          (top.ens_name || top.agent_id) + ' resolves to wallet ' + top.wallet_address.slice(0, 6) + '...' + top.wallet_address.slice(-4) + '.',
          'Identity', COL.lineage,
        ]);
      }
    }
    if (q.length) thoughts = q;
    B.ready = thoughts.length > 0;
  }

  // seed colony stats from the real agents, split across the factions
  function applyStats() {
    if (!DN.colony || !DN.colony.list || !DN.colony.list.length || !records.length) return false;
    const stakeByAgent = {};
    forecasts.forEach((f) => { stakeByAgent[f.agent_id] = f.stake || 0; });
    const n = DN.colony.list.length;
    DN.colony.list.forEach((c, i) => {
      const grp = records.filter((_, idx) => idx % n === i);
      if (!grp.length) return;
      const accAvg = grp.reduce((s, r) => s + r.accuracy, 0) / grp.length;
      const bankAvg = grp.reduce((s, r) => s + r.bankroll, 0) / grp.length;
      const treasury = grp.reduce((s, r) => s + r.bankroll, 0); // internal credits held
      const stakedNow = grp.reduce((s, r) => s + (stakeByAgent[r.agent_id] || 0), 0);
      c.stats.population = grp.length;
      c.stats.accuracy = Math.round(accAvg * 100);
      c.stats.rep = clamp(Math.round(accAvg * 100), 5, 99);
      c.stats.staked = treasury + stakedNow * 50; // displayed as $/1000 → ~1.0k
      c.stats.food = clamp(Math.round((bankAvg - 80) * 3.2), 12, 100);
      c.stats.health = clamp(Math.round(40 + (accAvg - 0.4) * 200), 25, 99);
      c.stats.gen = (records[0] && records[0].generation != null ? records[0].generation : 0) + 1;
    });
    return true;
  }

  B.nextThought = function () {
    if (!thoughts.length) return null;
    const t = thoughts[ti % thoughts.length];
    ti++;
    return t;
  };

  B.getAgents = function () { return records.slice(); };
  B.getRooms = function () { return rooms.slice(); };
  B.getForecasts = function () { return forecasts.slice(); };
  B.getSummary = function () { return summary; };
  B.getAgent = function (agentId) { return records.find((r) => r.agent_id === agentId) || null; };

  function apiJson(path, options) {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    return fetch(apiUrl + path, options || {})
      .then((r) => {
        if (r.ok) return r.json();
        return r.text().then((t) => {
          let message = t || String(r.status);
          try {
            const parsed = JSON.parse(t);
            message = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail || parsed);
          } catch (err) {}
          throw new Error(message);
        });
      });
  }

  B.fetchForecastConfig = function () {
    return apiJson('/forecast/config');
  };

  B.fetchForecastGames = function (opts) {
    opts = opts || {};
    const params = new URLSearchParams();
    if (opts.include_previous_test_data || opts.includePreviousTestData) params.set('include_previous_test_data', 'true');
    const query = params.toString();
    return apiJson('/forecast/games' + (query ? '?' + query : ''))
      .then((payload) => {
        B.forecastGames = payload.games || [];
        return payload;
      });
  };

  B.deployForecastContract = function (opts) {
    return apiJson('/forecast/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    });
  };

  B.setupForecastDemo = function (opts) {
    const body = Object.assign(
      {
        market_type: 'three_way',
        fee_bps: 1000,
      },
      opts || {},
    );
    return apiJson('/forecast/demo-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  B.settleForecastDemo = function (opts) {
    return apiJson('/forecast/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    });
  };

  B.fetchForecastTotals = function (opts) {
    const params = new URLSearchParams();
    if (opts && opts.contract) params.set('contract', opts.contract);
    if (opts && opts.market_key) params.set('market_key', opts.market_key);
    return apiJson('/forecast/totals' + (params.toString() ? '?' + params.toString() : ''));
  };

  B.fetchX402Config = function () {
    return apiJson('/x402/config');
  };

  B.runX402DemoPayment = function (opts) {
    const body = Object.assign(
      {
        buyer: 'ant_0001',
        seller: 'ant_0002',
        service: 'finding_private',
        round_id: 'worldcup:2026:brazil-morocco:x402-demo',
        resource_id: 'kg:worldcup:brazil-morocco:private-scout-signal',
        topic: 'Brazil vs Morocco',
      },
      opts || {},
    );
    return apiJson('/x402/demo-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  B.fetchAgents = function () {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    return fetch(apiUrl + '/ants')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((payload) => {
        records = payload.agents || [];
        B.agents = records;
        return payload;
      });
  };

  B.reproduceAnt = function (opts) {
    const body = Object.assign(
      {
        mutation_rate: 0.08,
        fund_wallet: true,
        fund_amount: '0.05',
        broadcast_funding: true,
        publish_ens: true,
        broadcast_ens: true,
      },
      opts || {},
    );
    return apiJson('/ants/reproduce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((payload) => {
      const child = payload.child || null;
      if (child) {
        records = records.filter((r) => r.agent_id !== child.agent_id).concat([child]);
        B.agents = records;
      }
      return payload;
    });
  };

  B.killAnt = function (agentId, opts) {
    if (!agentId) return Promise.reject(new Error('Missing agent id.'));
    const body = Object.assign(
      {
        reason: 'manual',
        publish_ens: true,
        broadcast_ens: true,
      },
      opts || {},
    );
    return apiJson('/ants/' + encodeURIComponent(agentId) + '/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((payload) => {
      const ant = payload.ant || null;
      if (ant) {
        records = records.map((r) => (r.agent_id === ant.agent_id ? ant : r));
        if (!records.some((r) => r.agent_id === ant.agent_id)) records.push(ant);
        B.agents = records;
      }
      return payload;
    });
  };

  B.randomizeAntAvatar = function (agentId, opts) {
    if (!agentId) return Promise.reject(new Error('Missing agent id.'));
    return apiJson('/ants/' + encodeURIComponent(agentId) + '/avatar/random', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    }).then((payload) => {
      const ant = payload.ant || null;
      if (ant) {
        records = records.map((r) => (r.agent_id === ant.agent_id ? Object.assign({}, r, ant) : r));
        if (!records.some((r) => r.agent_id === ant.agent_id)) records.push(ant);
        B.agents = records;
      }
      return payload;
    });
  };

  B.fetchWorldCupKg = function () {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    return fetch(apiUrl + '/kg/world-cup')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((payload) => {
        B.worldCupKg = payload;
        return payload;
      });
  };

  function kgMatchKey(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function runMatchesScoutingTarget(run, opts) {
    if (!run || !['scouting', 'kg'].includes(run.kind) || run.status !== 'succeeded') return false;
    opts = opts || {};
    const wantedId = opts.match_id || opts.market_key || '';
    const wantedName = kgMatchKey(opts.match || opts.name || '');
    const runId = run.match_id || '';
    const runName = kgMatchKey(run.match || '');
    if (wantedId && runId && wantedId === runId) return true;
    if (wantedName && runName && wantedName === runName) return true;
    const command = Array.isArray(run.command) ? run.command.map(String) : [];
    return Boolean(
      (wantedId && command.includes(wantedId)) ||
      (wantedName && command.some((part) => kgMatchKey(part) === wantedName))
    );
  }

  B.fetchRuns = function () {
    return apiJson('/runs')
      .then((payload) => {
        B.runs = payload.runs || [];
        return payload;
      });
  };

  B.fetchPredictions = function (opts) {
    const params = new URLSearchParams();
    opts = opts || {};
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.include_incomplete != null) params.set('include_incomplete', opts.include_incomplete ? 'true' : 'false');
    return apiJson('/predictions' + (params.toString() ? '?' + params.toString() : ''))
      .then((payload) => {
        B.predictions = payload.predictions || [];
        return payload;
      });
  };

  B.fetchBenchmarkRuns = function (opts) {
    const params = new URLSearchParams();
    opts = opts || {};
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.snapshot_id || opts.snapshotId) params.set('snapshot_id', opts.snapshot_id || opts.snapshotId);
    if (opts.pubkey) params.set('pubkey', opts.pubkey);
    return apiJson('/benchmark/runs' + (params.toString() ? '?' + params.toString() : ''))
      .then((payload) => {
        B.benchmarkRuns = payload.runs || [];
        return payload;
      });
  };

  B.fetchRunPrediction = function (runId) {
    if (!runId) return Promise.reject(new Error('run id required'));
    return apiJson('/runs/' + encodeURIComponent(runId) + '/prediction');
  };

  B.fetchRunAgents = function (runId) {
    if (!runId) return Promise.reject(new Error('run id required'));
    return apiJson('/runs/' + encodeURIComponent(runId) + '/agents');
  };

  B.fetchRunKg = function (runId) {
    if (!runId) return Promise.reject(new Error('run id required'));
    return apiJson('/runs/' + encodeURIComponent(runId) + '/kg')
      .then((payload) => {
        payload.source_run_id = runId;
        return payload;
      });
  };

  B.fetchKgModules = function () {
    return apiJson('/kg/modules')
      .then((payload) => {
        B.kgModules = payload.modules || [];
        B.kgModuleDefaults = (payload.defaults && payload.defaults.modules) || [];
        B.kgRunDefaults = payload.defaults || {};
        return payload;
      });
  };

  B.fetchUserColony = function (pubkey) {
    if (!pubkey) return Promise.reject(new Error('Wallet public key required.'));
    return apiJson('/colonies/' + encodeURIComponent(pubkey));
  };

  B.createUserColony = function (payload) {
    if (!payload || !payload.pubkey) return Promise.reject(new Error('Wallet public key required.'));
    return apiJson('/colonies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  B.deleteUserColony = function (pubkey) {
    if (!pubkey) return Promise.reject(new Error('Wallet public key required.'));
    return apiJson('/colonies/' + encodeURIComponent(pubkey), { method: 'DELETE' });
  };

  B.fetchUserColonyAnts = function (pubkey, opts) {
    if (!pubkey) return Promise.reject(new Error('Wallet public key required.'));
    opts = opts || {};
    const params = new URLSearchParams();
    params.set('status', opts.status || 'all');
    params.set('limit', String(opts.limit || 200));
    return apiJson('/colonies/' + encodeURIComponent(pubkey) + '/ants?' + params.toString());
  };

  B.ensureUserColonyAnts = function (pubkey, opts) {
    if (!pubkey) return Promise.reject(new Error('Wallet public key required.'));
    return apiJson('/colonies/' + encodeURIComponent(pubkey) + '/ants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    });
  };

  B.setUserColonyAntStatus = function (pubkey, agentId, status) {
    if (!pubkey || !agentId) return Promise.reject(new Error('Wallet public key and agent id required.'));
    return apiJson(
      '/colonies/' + encodeURIComponent(pubkey) + '/ants/' + encodeURIComponent(agentId) + '/status',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
  };

  B.fetchScoutingKgForMatch = function (opts) {
    return B.fetchRuns()
      .then((payload) => {
        const runs = (payload.runs || []).filter((run) => runMatchesScoutingTarget(run, opts));
        function tryRun(index) {
          const run = runs[index];
          if (!run) return null;
          return B.fetchRunKg(run.id)
            .then((kg) => {
              kg.source_run = run;
              kg.source_run_id = run.id;
              return kg;
            })
            .catch(() => tryRun(index + 1));
        }
        return tryRun(0);
      });
  };

  function compactScoutingLabel(value, max) {
    const label = String(value || '').replace(/_/g, ' ');
    return label.length > max ? label.slice(0, max - 3) + '...' : label;
  }

  function scoutingEventLog(event, graphChange) {
    if (!event || !event.event_type) return null;
    if (event.event_type === 'run_log') {
      return {
        level: event.stream === 'stderr' ? 'STDERR' : 'RUN',
        message: event.message || '',
      };
    }
    if (event.event_type === 'kg_stage') {
      if (event.stage === 'market_anchor_loaded' && event.market_override) {
        const override = event.market_override || {};
        const probs = override.side_probabilities || {};
        const labels = marketOutcomeLabels({
          home_team: override.home_team,
          away_team: override.away_team,
          match: event.match,
        });
        const rawMarket = ['home', 'draw', 'away'].filter((side) => probs[side] != null).map((side) =>
          labels[side] + ' ' + Math.round(Number(probs[side] || 0) * 100) + '%'
        ).join(' · ');
        const anchor = override.home_anchor == null ? '' : ' · binary ' + labels.home + ' ' + Math.round(Number(override.home_anchor || 0) * 100) + '%';
        return { level: 'MARKET', message: (rawMarket || 'Market anchor loaded') + anchor };
      }
      const stage = compactScoutingLabel(event.stage || 'kg_stage', 44);
      const match = event.match ? ' · ' + event.match : '';
      return { level: 'SCOUT', message: 'Stage: ' + stage + match };
    }
    if (event.event_type === 'kg_entity') {
      const action = graphChange && graphChange.action === 'updated' ? 'Updated node' : 'New node';
      const type = graphChange && graphChange.type ? ' · ' + compactScoutingLabel(graphChange.type, 24) : '';
      const label = graphChange && graphChange.label ? graphChange.label : 'KG entity';
      return { level: 'KG', message: action + ': ' + compactScoutingLabel(label, 72) + type };
    }
    if (event.event_type === 'kg_relationship') {
      const rel = graphChange && graphChange.relation ? compactScoutingLabel(graphChange.relation, 36) : 'related_to';
      const source = graphChange && graphChange.source ? compactScoutingLabel(graphChange.source, 28) : 'source';
      const target = graphChange && graphChange.target ? compactScoutingLabel(graphChange.target, 28) : 'target';
      return { level: 'KG', message: 'Linked nodes: ' + source + ' -> ' + target + ' · ' + rel };
    }
    if (event.event_type === 'kg_manifest') {
      const manifest = event.manifest || {};
      return {
        level: 'KG',
        message: 'Manifest ready: ' + (manifest.entity_count || 0) + ' entities · ' + (manifest.relationship_count || 0) + ' links',
      };
    }
    if (event.event_type === 'scouting_audit') {
      const backlog = event.backlog_count == null ? 'n/a' : event.backlog_count;
      return { level: 'SCOUT', message: 'Audit complete · backlog ' + backlog };
    }
    if (event.event_type === 'round_summary') {
      return {
        level: 'RUN',
        message: 'Colony round: ' + (event.population || 0) + ' ants · ' +
          (event.room_count || 0) + ' rooms · ' +
          'market order: ' + marketSideCountsText({ home: event.home_bets, draw: event.draw_bets, away: event.away_bets }, event),
      };
    }
    if (event.event_type === 'debate_room') {
      const claims = event.claims || [];
      const room = event.room_id || event.room || 'room';
      return {
        level: 'DEBATE',
        message: compactScoutingLabel(room, 32) + ' · ' + claims.length + ' claims',
      };
    }
    if (event.event_type === 'debate_claim') {
      return {
        level: 'DEBATE',
        message: compactScoutingLabel(event.message || event.claim_type || 'debate claim', 120),
      };
    }
    if (event.event_type === 'forecast') {
      const side = event.side || 'pass';
      const stake = event.stake == null ? '' : ' · stake ' + Number(event.stake || 0).toFixed(2);
      const lean = qualitativeLean(event.home_probability, event);
      return {
        level: 'VOTE',
        message: (event.agent_id || 'ant') + ' votes ' + marketSideLabel(side, event) + stake + lean,
      };
    }
    if (event.event_type === 'collective_decision') {
      const prediction = event.prediction || {};
      const vote = event.vote_breakdown || {};
      const sides = vote.raw_forecast_sides || {};
      const sentence = prediction.sentence ||
        ('Decision: ' + (prediction.winner || event.decision_winner || 'unknown'));
      return {
        level: 'DECISION',
        message: compactScoutingLabel(sentence, 120) +
          ' · market order: ' + marketSideCountsText(sides, event),
      };
    }
    if (event.event_type === 'settlement_summary') {
      return {
        level: 'SETTLE',
        message: 'Settlement ' + (event.status || 'pending') + ' · staked ' + Number(event.staked_total || 0).toFixed(2),
      };
    }
    if (/scout|scouting/i.test(event.event_type)) {
      return { level: 'SCOUT', message: compactScoutingLabel(event.event_type, 48) };
    }
    return null;
  }

  function pushScoutingLog(event, graphChange) {
    if (!DN.logTerm) return;
    const row = scoutingEventLog(event, graphChange);
    if (row) DN.logTerm.push(row.level, row.message);
  }

  function showCompletedScoutingGraph(kg, opts) {
    if (!DN.kgview || !kg) return;
    opts = opts || {};
    const title = opts.title || 'Completed scouting KG';
    if (DN.kgview.replayGraph) {
      DN.kgview.replayGraph(kg, title, {
        entityChunk: 10,
        relationshipChunk: 80,
        delayMs: 220,
        onComplete: opts.onComplete,
      });
    } else {
      DN.kgview.showGraph(kg, title);
      if (typeof opts.onComplete === 'function') opts.onComplete();
    }
  }

  B.startKgRun = function (opts) {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    const body = Object.assign(
      {
        match: 'Brazil vs Morocco',
        mode: 'fast',
        modules: ['fixture', 'public_x', 'polymarket_market_context', 'wikidata_profiles', 'txline_full'],
        timeout: 120,
        camel_agents: 4,
      },
      opts || {},
    );
    const showGraphOnComplete = body.show_completed_graph !== false;
    delete body.show_completed_graph;
    rememberMarketMatch(body);
    if (DN.logTerm) DN.logTerm.push('KG', 'Submitting KG run for ' + body.match + '...');
    return fetch(apiUrl + '/kg/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.status)))))
      .then((run) => {
        B.runId = run.id;
        if (B.resetCommsRun) B.resetCommsRun(run.id);
        if (DN.kgview && DN.kgview.showScoutingProgress) {
          DN.kgview.showScoutingProgress({
            match: body.match,
            matchId: body.match_id,
          });
        } else if (DN.kgview) {
          DN.kgview.reset('Live KG run');
        }
        if (DN.logTerm) DN.logTerm.push('KG', 'Run ' + run.id + ' queued · modules ' + (body.modules || []).join(', ') + '.');
        if (!window.EventSource) return pollScoutingRun(run.id, { showGraphOnComplete, title: 'Completed KG run' });
        return streamScoutingRun(run.id, { showGraphOnComplete, title: 'Completed KG run' });
      });
  };

  B.startScoutingRun = function (opts) {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    const body = Object.assign(
      {
        match: 'Brazil vs Morocco',
        data_mode: 'openfootball',
        include_deepseek_scout: false,
        agents: 20,
        rooms: 4,
        seed: 12,
        voice_mode: 'template',
      },
      opts || {},
    );
    const showGraphOnComplete = body.show_completed_graph !== false;
    delete body.show_completed_graph;
    rememberMarketMatch(body);
    if (DN.logTerm) DN.logTerm.push('SCOUT', 'Submitting scouting run for ' + body.match + '...');
    return fetch(apiUrl + '/scouting/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.status)))))
      .then((run) => {
        B.runId = run.id;
        if (B.resetCommsRun) B.resetCommsRun(run.id);
        if (DN.kgview && DN.kgview.showScoutingProgress) {
          DN.kgview.showScoutingProgress({
            match: body.match,
            matchId: body.match_id,
          });
        } else if (DN.kgview) {
          DN.kgview.reset('Live scouting KG');
        }
        if (DN.logTerm) DN.logTerm.push('SCOUT', 'Run ' + run.id + ' queued · opening event stream.');
        if (!window.EventSource) return pollScoutingRun(run.id, { showGraphOnComplete });
        return streamScoutingRun(run.id, { showGraphOnComplete });
      });
  };

  B.startUserColonyRun = function (pubkey, opts) {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    if (!pubkey) return Promise.reject(new Error('Wallet public key required.'));
    const body = Object.assign(
      {
        match: 'Brazil vs Morocco',
        data_mode: 'public',
        rooms: 5,
        seed: 42,
        voice_mode: 'template',
        debug: true,
      },
      opts || {},
    );
    const showGraphOnComplete = body.show_completed_graph !== false;
    delete body.show_completed_graph;
    rememberMarketMatch(body);
    if (DN.logTerm) DN.logTerm.push('COLONY', 'Submitting colony run for ' + body.match + '...');
    return fetch(apiUrl + '/colonies/' + encodeURIComponent(pubkey) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.status)))))
      .then((run) => {
        B.runId = run.id;
        if (B.resetCommsRun) B.resetCommsRun(run.id);
        if (DN.kgview && DN.kgview.showScoutingProgress) {
          DN.kgview.showScoutingProgress({
            match: body.match,
            matchId: body.match_id,
          });
        } else if (DN.kgview) {
          DN.kgview.reset('Live colony run');
        }
        if (DN.logTerm) DN.logTerm.push('COLONY', 'Run ' + run.id + ' queued from selected colony.');
        if (!window.EventSource) return pollScoutingRun(run.id, { showGraphOnComplete, title: 'Completed colony run' });
        return streamScoutingRun(run.id, { showGraphOnComplete, title: 'Completed colony run' });
      });
  };

  // Recent ant-to-ant communication events (social_action, debate_claim,
  // forecast) from the latest backend run. The deployed Railway API only
  // exposes /runs and /runs/{run_id}/events (no /recent_communications
  // shortcut), so this method: 1) caches the latest run_id from /runs,
  // 2) downloads the run's events.jsonl, 3) filters client-side.
  let _commsRunId = null;
  let _commsRunId_at = 0;
  let _commsRunPinned = false;
  function pickLatestRunId() {
    return fetch(apiUrl + '/runs')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(payload => {
        const runs = payload.runs || [];
        if (!runs.length) return null;
        const isScout = (r) => r && (r.kind === 'scouting' || String(r.id || '').startsWith('scout_'));
        for (const r of runs) {
          if (r.events_path && !isScout(r)) return r.id;
        }
        for (const r of runs) {
          if (r.events_path) return r.id;
        }
        return runs[0].id;
      });
  }
  B.fetchCommunications = function () {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    // Only fetch events for the run the lifecycle EXPLICITLY pinned
    // via resetCommsRun(id). Without an active run we return empty —
    // otherwise the page-load poll would auto-pick the most recent run
    // on the server (often a stale scout run from a previous demo) and
    // start replaying its DISPUTE/SPEAK rows the moment you load the
    // app, before the user has clicked Run.
    if (!_commsRunId) return Promise.resolve({ events: [] });
    const runId = _commsRunId;
    B.runId = runId;
    return fetch(apiUrl + '/runs/' + encodeURIComponent(runId) + '/events')
      .then(r => r.ok ? r.text() : Promise.reject(r.status))
      .then(txt => {
        const events = parseJsonl(txt).filter(ev => {
          const t = ev && ev.event_type;
          return t === 'social_action' || t === 'debate_claim' || t === 'forecast';
        });
        B._commsEvents = events;
        return { run_id: runId, events };
      });
  };
  B.getCommunications = function () { return B._commsEvents || []; };
  B.getCommsRunId = function () { return _commsRunId; };
  // Bust the cached run id so the next fetchCommunications() re-queries
  // /runs. Called after Run-LLM / scouting completes so we pick up the
  // freshly-created run instead of sticking with the previous one.
  B.resetCommsRun = function (newId) {
    if (newId) {
      _commsRunId = newId;
      _commsRunId_at = Date.now();
      _commsRunPinned = true;
      B.runId = newId;
    } else {
      _commsRunId = null;
      _commsRunId_at = 0;
      _commsRunPinned = false;
    }
    B._commsEvents = [];
  };

  function parseJsonl(txt) {
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }

  function seedStats() {
    let tries = 0;
    const seed = setInterval(() => {
      if (applyStats() || ++tries > 60) clearInterval(seed);
    }, 250);
  }

  function loadEvents(source) {
    return fetch(source)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((txt) => {
        const events = parseJsonl(txt);
        build(events);
        seedStats();
      });
  }

  function loadLatestRailwayRun() {
    if (!apiUrl) return Promise.reject(new Error('no api url configured'));
    return latestSuccessfulRunId()
      .then((runId) => {
        B.runId = runId;
        B.source = apiUrl + '/runs/' + runId + '/events';
        return loadEvents(B.source);
      });
  }

  function latestSuccessfulRunId() {
    if (!apiUrl) return Promise.reject(new Error('no api url configured'));
    if (B.runId) return Promise.resolve(B.runId);
    return fetch(apiUrl + '/runs')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((payload) => {
        const runs = (payload.runs || []).filter((run) => run.status === 'succeeded');
        if (!runs.length) throw new Error('no successful runs yet');
        return runs[0].id;
      });
  }

  B.loadRun = function (runId) {
    if (!apiUrl || !runId) return Promise.reject(new Error('api url and run id required'));
    B.runId = runId;
    B.source = apiUrl + '/runs/' + runId + '/events';
    return loadEvents(B.source);
  };

  B.startDemoRun = function (opts) {
    if (!apiUrl) return Promise.reject(new Error('No backend API configured.'));
    const body = Object.assign(
      { agents: 20, rooms: 4, seed: Math.floor(Math.random() * 10000), voice_mode: 'llm' },
      cfg.RUN || {},
      opts || {},
    );
    if (!body.agent_wallets) delete body.wallet_provider;
    if (!body.agent_wallets) delete body.wallet_store;
    runEvents = [];
    B.ready = false;
    return fetch(apiUrl + '/runs/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.status)))))
      .then((run) => {
        B.runId = run.id;
        B.source = apiUrl + '/runs/' + run.id + '/events';
        if (!window.EventSource) return pollRun(run.id);
        return streamRun(run.id);
      });
  };

  function pollRun(runId) {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        fetch(apiUrl + '/runs/' + runId)
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          .then((run) => {
            if (run.status === 'succeeded') {
              clearInterval(timer);
              B.loadRun(runId).then(resolve, reject);
            } else if (run.status === 'failed') {
              clearInterval(timer);
              reject(new Error('Backend run failed.'));
            }
          })
          .catch((err) => {
            clearInterval(timer);
            reject(err);
          });
      }, 1000);
    });
  }

  function pollScoutingRun(runId, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        fetch(apiUrl + '/runs/' + runId)
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          .then((run) => {
            if (run.status === 'succeeded') {
              clearInterval(timer);
              Promise.all([
                fetch(apiUrl + '/runs/' + runId + '/kg').then((r) => (r.ok ? r.json() : null)).catch(() => null),
                fetch(apiUrl + '/runs/' + runId + '/kg/manifest').then((r) => (r.ok ? r.json() : null)).catch(() => null),
                fetch(apiUrl + '/runs/' + runId + '/scouting-audit').then((r) => (r.ok ? r.json() : null)).catch(() => null),
              ]).then(([kg, manifest, audit]) => {
                if (opts.showGraphOnComplete !== false) showCompletedScoutingGraph(kg, opts);
                resolve({ id: runId, run, kg, manifest, audit });
              });
            } else if (run.status === 'failed') {
              clearInterval(timer);
              reject(new Error('Scouting run failed.'));
            }
          })
          .catch((err) => {
            clearInterval(timer);
            reject(err);
          });
      }, 1000);
    });
  }

  function streamScoutingRun(runId, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const source = new EventSource(apiUrl + '/runs/' + runId + '/stream');
      let latestStatus = null;
      source.addEventListener('status', (e) => {
        try {
          latestStatus = JSON.parse(e.data);
          if (DN.kgview && latestStatus.status === 'running') DN.kgview.status('Scouting run is running...');
          if (DN.logTerm && latestStatus.status) DN.logTerm.push('SCOUT', 'Run status: ' + latestStatus.status);
        } catch (err) {}
      });
      source.addEventListener('colony_event', (e) => {
        try {
          const event = JSON.parse(e.data);
          const graphChange = DN.kgview && /^kg_|^scouting_/.test(event.event_type || '') ? DN.kgview.ingest(event) : null;
          pushScoutingLog(event, graphChange);
        } catch (err) {}
      });
      source.addEventListener('done', () => {
        source.close();
        if (latestStatus && latestStatus.status === 'failed') {
          reject(new Error('Scouting run failed.'));
          return;
        }
        Promise.all([
          fetch(apiUrl + '/runs/' + runId + '/kg').then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(apiUrl + '/runs/' + runId + '/kg/manifest').then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(apiUrl + '/runs/' + runId + '/scouting-audit').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]).then(([kg, manifest, audit]) => {
          if (opts.showGraphOnComplete !== false) showCompletedScoutingGraph(kg, opts);
          resolve({ id: runId, run: latestStatus, kg, manifest, audit });
        }, reject);
      });
      source.onerror = () => {
        source.close();
        pollScoutingRun(runId, opts).then(resolve, reject);
      };
    });
  }

  function streamRun(runId) {
    return new Promise((resolve, reject) => {
      const source = new EventSource(apiUrl + '/runs/' + runId + '/stream');
      source.addEventListener('colony_event', (e) => {
        try {
          const event = JSON.parse(e.data);
          runEvents.push(event);
          pushScoutingLog(event);
        } catch (err) {}
      });
      source.addEventListener('done', () => {
        source.close();
        if (runEvents.length) {
          build(runEvents);
          seedStats();
          resolve({ id: runId, events: runEvents.length });
        } else {
          B.loadRun(runId).then(resolve, reject);
        }
      });
      source.onerror = () => {
        source.close();
        pollRun(runId).then(resolve, reject);
      };
    });
  }

  function load() {
    if (!apiUrl) return;
    loadLatestRailwayRun()
      .catch(() => {
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'No completed backend run loaded yet.');
      });
  }

  load();
  return B;
})();
