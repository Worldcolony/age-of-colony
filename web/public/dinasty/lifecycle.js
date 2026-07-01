// WorldColony — lifecycle controller. State machine for the demo arc:
//   0 idle → 1 kickoff → 2 scouting → 3 kg_forming → 4 recruitment →
//   5 converge → 6 ingress → 7 debate → 8 resolution → 9 egress_roam
// Backend-paced lifecycle. Visual phases keep tiny minimum beats, but critical
// transitions wait for the selected backend run, KG replay, and on-chain
// economy to finish.
// Resolution wires the run's forecast decisions into the Arc forecast
// contract and claims payouts for winning ants.
window.DN = window.DN || {};

DN.lifecycle = (function () {
  const L = {
    phase: 'idle',
    phaseT: 0,
    winner: null,
    settleTxHash: null,
    forecastContract: null,
    runId: null,
    phaseHold: false,
    scoutingDone: false,
    scoutingResult: null,
    scoutingError: null,
    kgReplayDone: false,
    convergeTarget: 0,
    convergeReturned: 0,
    ingressDone: false,
    debateDone: false,
    skipScouting: false,
    scoutMode: 'openfootball',
    staticMode: true,
  };

  // Minimum visual dwell per phase. These values never advance a backend
  // phase by themselves; phaseReady() below decides when work is complete.
  const MIN_DURATIONS = {
    idle:        Infinity,
    kickoff:      2.5,
    scouting:     2.0,
    kg_forming:   0.5,
    recruitment:  0.5,
    converge:     0.5,
    ingress:      0.5,
    debate:       0.5,
    resolution:   0.5,
    egress_roam: Infinity
  };
  const STATIC_MIN_DURATIONS = {
    idle:        Infinity,
    kickoff:      0.1,
    scouting:     0.1,
    kg_forming:   0.8,
    recruitment:  0.9,
    converge:     0.9,
    ingress:      0.8,
    debate:       1.0,
    resolution:   0.1,
    egress_roam: Infinity
  };
  const NEXT = {
    idle:        null,
    kickoff:    'scouting',
    scouting:   'kg_forming',
    kg_forming: 'recruitment',
    recruitment:'converge',
    converge:   'ingress',
    ingress:    'debate',
    debate:     'resolution',
    resolution: 'egress_roam',
    egress_roam: null
  };
  const LABEL = {
    idle:        'Idle',
    kickoff:     'Kickoff',
    scouting:    'Scouting',
    kg_forming:  'Knowledge crystal forming',
    recruitment: 'Recruitment',
    converge:    'Converge on crystal',
    ingress:     'Ingress',
    debate:      'Debate',
    resolution:  'Resolution',
    egress_roam: 'Egress & roam'
  };

  // ---- helpers ----------------------------------------------------------
  function logPhase(phase) {
    if (!DN.logTerm) return;
    DN.logTerm.push('PHASE', '── ' + LABEL[phase] + ' ──');
  }

  function scoutCountPerColony() { return L.scoutMode === 'openfootball' ? 1 : 6; }

  function pickScoutAnts(col, n) {
    const out = [];
    for (const a of DN.ants.list) {
      if (a.col !== col) continue;
      if (a.state !== 'idle') continue;
      if (a.hero) continue;
      out.push(a);
      if (out.length >= n) break;
    }
    return out;
  }

  function selectedMatch() {
    const el = document.getElementById('forecast-game');
    return el && el.value ? el.value : 'match:world_cup_2026:013:2026_06_13_brazil_morocco';
  }

  function selectedWinner() {
    const el = document.getElementById('forecast-winner');
    return el && el.value ? el.value : 'Brazil';
  }

  function configuredContract() {
    return (window.DN_CONFIG && window.DN_CONFIG.FORECAST && window.DN_CONFIG.FORECAST.CONTRACT) || '';
  }

  function configuredRun() {
    return (window.DN_CONFIG && window.DN_CONFIG.RUN) || {};
  }

  function boundedInt(value, fallback, lo, hi) {
    const n = Number(value);
    const picked = Number.isFinite(n) ? Math.round(n) : fallback;
    return Math.max(lo, Math.min(hi, picked));
  }

  function fastAgentCount(runCfg) {
    return boundedInt(runCfg.fast_agents || runCfg.fastAgents || runCfg.demo_agents || runCfg.demoAgents, 24, 1, 60);
  }

  function fastRoomCount(runCfg) {
    return boundedInt(runCfg.fast_rooms || runCfg.fastRooms || runCfg.demo_rooms || runCfg.demoRooms, 4, 1, 12);
  }

  function configuredForecastWalletStore() {
    const forecast = (window.DN_CONFIG && window.DN_CONFIG.FORECAST) || {};
    return forecast.WALLET_STORE || forecast.wallet_store || '';
  }

  // Look up the currently selected game's cached metadata (home/away
  // team etc.) so settleForecastDemo has the right `home_team` /
  // `away_team` for the API.
  function selectedGameMeta() {
    const games = (DN.databridge && DN.databridge.forecastGames) || [];
    const key = selectedMatch();
    const found = games.find((g) => g.market_key === key);
    if (found) return found;
    return {
      market_key: key,
      match_id: key,
      market_type: 'three_way',
      home_team: 'Brazil',
      away_team: 'Morocco',
      name: 'Brazil vs Morocco'
    };
  }

  function winnerSideFor(winner, meta) {
    const norm = (v) => String(v || '').toLowerCase().trim();
    if (norm(winner) === norm(meta.home_team) || norm(winner) === 'home') return 'home';
    if (norm(winner) === norm(meta.away_team) || norm(winner) === 'away') return 'away';
    if (norm(winner) === 'draw') return 'draw';
    return 'home';
  }

  function winnerNameForSide(side, meta) {
    if (side === 'away') return meta.away_team || 'away';
    if (side === 'draw') return 'Draw';
    return meta.home_team || 'home';
  }

  function sideWithLargestStake(stakes) {
    const totals = { home: 0, draw: 0, away: 0 };
    (stakes || []).forEach((stake) => {
      if (totals[stake.outcome] == null) return;
      totals[stake.outcome] += Number(stake.amount || 0);
    });
    return Object.keys(totals).sort((a, b) => totals[b] - totals[a])[0];
  }

  function runMarketKey(meta, runId) {
    return [
      meta.market_key || selectedMatch(),
      'run',
      runId || Date.now()
    ].join(':');
  }

  function shortHash(value) {
    const text = String(value || '');
    if (text.length < 14) return text;
    return text.slice(0, 8) + '...' + text.slice(-6);
  }

  function explorerTxUrl(hash, fallbackExplorer) {
    if (!hash) return '';
    const explorer = String(fallbackExplorer || 'https://explorer.testnet.arc.network').replace(/\/$/, '');
    return explorer + '/tx/' + hash;
  }

  function isTxHash(value) {
    return /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));
  }

  function receiptTransactions(step) {
    const receipt = (step && step.receipt) || {};
    const chain = receipt.chain || {};
    const explorer = chain.explorer || '';
    const out = [];
    (receipt.transactions || []).forEach((tx) => {
      if (!tx || !isTxHash(tx.tx_hash)) return;
      out.push({
        action: tx.type || receipt.action || step.action || 'tx',
        hash: tx.tx_hash,
        explorer_url: tx.explorer_url || explorerTxUrl(tx.tx_hash, explorer),
        agent_id: receipt.agent_id || '',
        wallet: receipt.wallet || '',
        outcome: receipt.outcome || '',
        amount_usdc: receipt.amount_usdc || '',
      });
    });
    (receipt.receipts || []).forEach((tx) => {
      if (!tx || !isTxHash(tx.tx_hash)) return;
      out.push({
        action: receipt.action || step.action || tx.transfer_id || 'fund',
        hash: tx.tx_hash,
        explorer_url: tx.explorer_url || explorerTxUrl(tx.tx_hash, explorer),
        agent_id: tx.agent_id || '',
        wallet: tx.to || '',
        outcome: '',
        amount_usdc: tx.amount_usdc || '',
      });
    });
    if (isTxHash(receipt.tx_hash)) {
      out.push({
        action: receipt.action || step.action || 'tx',
        hash: receipt.tx_hash,
        explorer_url: receipt.explorer_url || explorerTxUrl(receipt.tx_hash, explorer),
        agent_id: receipt.agent_id || '',
        wallet: receipt.wallet || '',
        outcome: receipt.outcome || receipt.result || '',
        amount_usdc: receipt.amount_usdc || '',
      });
    }
    return out;
  }

  function firstTransactionForAction(result, actionName) {
    const steps = (result && result.steps) || [];
    for (const step of steps) {
      const receipt = (step && step.receipt) || {};
      if (receipt.action !== actionName && step.action !== actionName) continue;
      const tx = receiptTransactions(step)[0];
      if (tx && tx.hash) return tx;
    }
    return null;
  }

  function firstReceiptWith(result, key) {
    const rootReceipt = (result && result.receipt) || {};
    if (rootReceipt[key]) return rootReceipt;
    const steps = (result && result.steps) || [];
    for (const step of steps) {
      const receipt = (step && step.receipt) || {};
      if (receipt[key]) return receipt;
    }
    return {};
  }

  function logForecastChainTrail(kind, result) {
    if (!DN.logTerm || !result) return;
    const rootReceipt = result.receipt || {};
    const contract = result.contract || rootReceipt.contract_address || rootReceipt.contract || '';
    const marketKey = result.market_key || '';
    const marketReceipt = firstReceiptWith(result, 'market_id');
    const marketId = marketReceipt.market_id || '';
    const contractLabel = kind === 'STAKE' ? 'forecast contract' :
                          kind === 'SETTLE' ? 'settlement contract' :
                          'contract';
    if (contract) DN.logTerm.push('CONTRACT', kind + ' ' + contractLabel + ' ' + contract);
    if (marketKey) DN.logTerm.push('CHAIN', kind + ' market_key ' + marketKey);
    if (marketId) DN.logTerm.push('CHAIN', kind + ' market_id ' + marketId);

    const steps = (result.steps && result.steps.length) ? result.steps : [{ action: result.action || kind.toLowerCase(), receipt: rootReceipt }];
    let count = 0;
    steps.forEach((step) => {
      receiptTransactions(step).forEach((tx) => {
        count++;
        const who = tx.agent_id ? ' ' + tx.agent_id : '';
        const detail = [
          tx.amount_usdc ? tx.amount_usdc + ' USDC' : '',
          tx.outcome || '',
          tx.wallet ? 'wallet ' + shortHash(tx.wallet) : '',
        ].filter(Boolean).join(' · ');
        const action = tx.action === 'settle' ? 'settlement' : tx.action;
        DN.logTerm.push(
          'TX',
          kind + ' real ' + action + who +
            (detail ? ' · ' + detail : '') +
            ' · tx ' + tx.hash +
            (tx.explorer_url ? ' · ' + tx.explorer_url : '')
        );
        if (DN.txTable && DN.txTable.push) {
          DN.txTable.push({
            action: tx.action,
            hash: tx.hash,
            explorer_url: tx.explorer_url,
            agent_id: tx.agent_id,
            wallet: tx.wallet,
            outcome: tx.outcome,
            amount_usdc: tx.amount_usdc,
          });
        }
      });
    });
    if (!count) {
      DN.logTerm.push('CHAIN', kind + ' returned no tx hashes. This usually means the API failed before signing or the response shape changed.');
    }
  }

  function startAgentRun() {
    if (!DN.databridge || !DN.databridge.startDemoRun) {
      L.scoutingDone = true;
      L.runError = new Error('Backend run API unavailable.');
      if (DN.logTerm) DN.logTerm.push('SYSTEM', L.runError.message);
      L.runPromise = Promise.resolve(null);
      return L.runPromise;
    }
    const runCfg = configuredRun();
    const meta = selectedGameMeta();
    L.scoutingDone = true;
    L.scoutingResult = null;
    L.scoutingError = null;
    if (DN.logTerm) {
      DN.logTerm.push('RUN', 'Backend agent run kicked off with no scout step.');
    }
    L.runPromise = DN.databridge.startDemoRun({
      agents: fastAgentCount(runCfg),
      rooms: fastRoomCount(runCfg),
      seed: Number.isFinite(Number(runCfg.seed)) ? Number(runCfg.seed) : Math.floor(Math.random() * 10000),
      match: meta.name || ((meta.home_team || 'Home') + ' vs ' + (meta.away_team || 'Away')),
      match_id: meta.match_id || meta.market_key,
      voice_mode: runCfg.agent_voice_mode || runCfg.fast_voice_mode || runCfg.voice_mode || 'template',
      agent_wallets: runCfg.agent_wallets !== false,
      wallet_provider: runCfg.wallet_provider,
      wallet_store: runCfg.wallet_store,
    })
      .then((res) => {
        L.scoutingDone = true;
        L.scoutingResult = res || null;
        if (res && res.id) {
          L.runId = res.id;
          L.runResult = res;
          L.backendDone = true;
          if (DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(res.id);
          if (DN.hud && DN.hud._pollComms) DN.hud._pollComms();
          if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Backend agent run ' + res.id + ' complete.');
        }
        return res || null;
      })
      .catch((err) => {
        L.scoutingDone = true;
        L.scoutingError = err;
        L.runError = err;
        L.backendDone = false;
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Backend agent run failed: ' + (err && err.message || err));
        return null;
      });
    return L.runPromise;
  }

  function startBackendRun() {
    if (L.runPromise) return L.runPromise;
    if (L.skipScouting) return startAgentRun();
    if (!DN.databridge || !DN.databridge.startDemoRun) {
      L.scoutingDone = true;
      L.runError = new Error('Backend run API unavailable.');
      if (DN.logTerm) DN.logTerm.push('SYSTEM', L.runError.message);
      L.runPromise = Promise.resolve(null);
      return L.runPromise;
    }
    // We hit /runs/demo (startDemoRun) directly — that's the endpoint
    // that runs the LLM-driven debate room and emits debate_claim +
    // social_action events. /scouting/run with data_mode=openfootball
    // only emits forecast events (no DISPUTE/SPEAK), which is why the
    // log was missing chamber-debate text before.
    L.scoutingDone = true;
    L.scoutingResult = null;
    L.scoutingError = null;
    const runCfg = configuredRun();
    const meta = selectedGameMeta();
    if (DN.logTerm) {
      DN.logTerm.push('SYSTEM', 'Backend LLM debate run kicked off — chambers will populate with real claims.');
    }
    L.runPromise = DN.databridge.startDemoRun({
      agents: Math.min(Number(runCfg.agents || 60), 200),
      rooms: Math.min(Number(runCfg.rooms || 5), 12),
      seed: Number.isFinite(Number(runCfg.seed)) ? Number(runCfg.seed) : Math.floor(Math.random() * 10000),
      match: meta.name || ((meta.home_team || 'Home') + ' vs ' + (meta.away_team || 'Away')),
      voice_mode: runCfg.voice_mode || 'llm',
      // Bind the run to the selected fixture so /forecast/settle's
      // match_id check passes (otherwise settle errors with
      // "run is for match_id unknown").
      match_id: meta.match_id || meta.market_key,
      home_team: meta.home_team,
      away_team: meta.away_team,
    })
      .then((res) => {
        L.scoutingDone = true;
        L.scoutingResult = res || null;
        if (res && res.id) {
          L.runId = res.id;
          L.runResult = res;
          L.backendDone = true;
          if (DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(res.id);
          if (DN.hud && DN.hud._pollComms) DN.hud._pollComms();
          if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Run ' + res.id + ' complete — debate transcript ready.');
        }
        return res || null;
      })
      .catch((err) => {
        L.scoutingDone = true;
        L.scoutingError = err;
        L.runError = err;
        L.backendDone = false;
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Backend run failed: ' + (err && err.message || err));
        return null;
      });
    return L.runPromise;
  }

  // ---- onArrive callbacks for the scripted Bezier walks --------------
  // When a scout reaches its forest target, it walks to the crystal and
  // deposits one finding. When a converger reaches the crystal, it
  // walks home and disappears into the colony.
  function scoutArrivedAtForest(a) {
    // Don't log per-scout — when 40+ scouts arrive in the same second the
    // terminal floods.
    const crystal = DN.crystal ? DN.crystal.position() : new THREE.Vector3(0, 0, 0);
    DN.ants.scriptWalk(
      a, a.x, a.z, crystal.x, crystal.z,
      { speed: 0.14, curl: 0.1, onArrive: scoutArrivedAtCrystal }
    );
  }
  function scoutArrivedAtCrystal(a) {
    if (DN.crystal && DN.crystal.depositOne) DN.crystal.depositOne();
    DN.ants.scriptWalk(
      a, a.x, a.z, a.col.entrance.x, a.col.entrance.z,
      { speed: 0.14, curl: 0.08, onArrive: hideAnt }
    );
  }
  function convergerArrivedAtCrystal(a) {
    a.hasShard = true;
    a._homing = true;
    // Crystal shrinks as ants pick up data — by the time the last
    // converger arrives the crystal is almost depleted.
    if (DN.crystal && DN.crystal.takeOne) DN.crystal.takeOne(0.12);
    DN.ants.scriptWalk(
      a, a.x, a.z, a.col.entrance.x, a.col.entrance.z,
      { speed: 0.12, curl: 0.06, onArrive: hideAnt }
    );
  }
  function hideAnt(a) {
    if (a._phaseTrip === 'converge') {
      L.convergeReturned++;
    }
    a.state = 'idle';
    a._idleWritten = false;
    a.scout = false;
    a.hasShard = false;
    a._homing = false;
    a._phaseTrip = null;
  }
  // After egress, ants hop between random nearby roam points so the
  // surface looks alive while the user inspects them.
  function roamHop(a) {
    const ang = Math.random() * Math.PI * 2;
    const r = 18 + Math.random() * 18;
    const tx = a.col.entrance.x + Math.cos(ang) * r;
    const tz = a.col.entrance.z + Math.sin(ang) * r;
    DN.ants.scriptWalk(
      a, a.x, a.z, tx, tz,
      { speed: 0.08, curl: 0.16, onArrive: roamHop }
    );
  }

  // ---- phase enter hooks (visual; on-chain hooks wired in later steps) --
  const ENTER = {
    idle: () => {
      if (DN.ants && DN.ants.allIdle) DN.ants.allIdle();
      if (DN.ants && DN.ants.hideOutcomeGlow) DN.ants.hideOutcomeGlow();
      if (DN.crystal) DN.crystal.hide();
    },
    kickoff: () => {
      // ONE flyTo for the entire surface lifecycle. Subsequent phases
      // (scouting → ingress) deliberately do NOT touch the camera, so
      // every action plays out in one continuous shot — no bouncing
      // between phases, no recompute-direction-from-current-position.
      if (DN.camera && DN.camera.flyTo) {
        // 14% closer than the previous (220, 140) pass — tighter shot.
        DN.camera.flyTo(new THREE.Vector3(0, 0, 0), 190, 120, 3.0);
      }
      if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Match: ' + selectedMatch());
      startBackendRun();
    },
    scouting: () => {
      if (L.skipScouting) {
        if (DN.logTerm) DN.logTerm.push('RUN', 'Scout step skipped; backend agent run is the source of truth.');
        return;
      }
      if (L.staticMode) {
        if (DN.logTerm) DN.logTerm.push('SCOUT', 'Static scout view active — waiting for backend OpenFootball run.');
        return;
      }
      // Previously kicked startScoutingRun() here which streamed SSE
      // events from Railway and hammered kgview's SVG rebuild path
      // while the 3D scene was already busy with scout animations —
      // that was the source of the heavy lag. The cached KG is
      // streamed in via replayGraph during kg_forming instead.
      // Wake a small scout party per colony, send each on a dedicated
      // Bezier walk to a forest target.
      let total = 0;
      (DN.colony.list || []).forEach(col => {
        const n = scoutCountPerColony();
        const arr = pickScoutAnts(col, n);
        arr.forEach((a, idx) => {
          a.scout = true;
          // Spread scouts radially around the colony, pointing into the
          // forest (outside the play area) so they're visible from the
          // overhead camera.
          const ang = (idx / Math.max(1, arr.length)) * Math.PI * 2 + Math.random() * 0.3;
          const dist = 38 + Math.random() * 18;
          const tx = col.pos.x + Math.cos(ang) * dist;
          const tz = col.pos.z + Math.sin(ang) * dist;
          a.scoutTarget = { x: tx, z: tz };
          DN.ants.scriptWalk(
            a, col.entrance.x, col.entrance.z, tx, tz,
            {
              speed: 0.12, curl: 0.12,
              // Stagger scout emergence so they leave one-by-one over
              // the first ~2.5 seconds of the scouting phase instead of
              // all spawning at the mouth simultaneously.
              tStart: -(idx / Math.max(1, arr.length - 1)) * 0.3,
              onArrive: scoutArrivedAtForest
            }
          );
        });
        total += arr.length;
      });
      if (DN.logTerm) DN.logTerm.push('SCOUT', total + ' scouts dispatched from ' + DN.colony.list.length + ' colonies.');
      // No follow() call — the static kickoff framing already shows
      // every colony + the surrounding forest, so scouts walk out
      // within frame without any camera motion at all.
    },
    kg_forming: () => {
      L.kgReplayDone = false;
      if (DN.crystal) DN.crystal.show();
      const renderKg = (payload, title) => {
        if (!payload) {
          L.kgReplayDone = true;
          return;
        }
        const finish = () => { L.kgReplayDone = true; };
        if (L.staticMode && DN.kgview && DN.kgview.showGraph) {
          DN.kgview.showGraph(payload, title || 'Selected-match KG');
          finish();
        } else if (DN.kgview && DN.kgview.replayGraph) {
          DN.kgview.replayGraph(payload, title || 'Selected-match KG', { onComplete: finish });
        } else if (DN.kgview && DN.kgview.showGraph) {
          DN.kgview.showGraph(payload, title || 'Selected-match KG');
          finish();
        } else {
          finish();
        }
      };
      if (L.scoutingResult && L.scoutingResult.kg) {
        renderKg(L.scoutingResult.kg, 'Completed scouting KG');
      } else if (L.skipScouting && DN.databridge && DN.databridge.fetchWorldCupKg) {
        DN.databridge.fetchWorldCupKg().then((payload) => {
          renderKg(payload, 'World Cup KG');
        }).catch(() => { L.kgReplayDone = true; });
      } else {
        L.kgReplayDone = true;
      }
      L._depositTimer = 0;
    },
    recruitment: () => {
      if (L.staticMode) {
        if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'info', mode: 'Ants getting info' });
        return;
      }
      // IMPORTANT: don't wake the idle workers here. If we A.activate()
      // them now they all snap to their entrance position on the next
      // frame — that's the "mass pop out of nowhere" the user reported.
      // The converge phase wakes + walks them in one step using a
      // negative-staggered scriptWalk, so they visibly emerge one by
      // one from each mound.
    },
    converge: () => {
      if (L.staticMode) {
        L.convergeTarget = 0;
        L.convergeReturned = 0;
        if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'info', mode: 'Ants getting info' });
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Static review: backend forecasts are ready; ants stay in place for the run.');
        return;
      }
      // Send every visible worker to the crystal. To make them read as a
      // single-file line per colony (not a chaotic swarm) we:
      //   • bucket workers by colony
      //   • use ONE shared curl sign per colony (so all curves bow the same way)
      //   • stagger tStart so they're distributed along the trail at frame 1
      //   • tighten laneOffset so the column has minimal lateral spread
      const crystal = DN.crystal ? DN.crystal.position() : new THREE.Vector3(0, 0, 0);
      let count = 0;
      L.convergeTarget = 0;
      L.convergeReturned = 0;
      (DN.colony.list || []).forEach((col, ci) => {
        // collect this colony's eligible workers — INCLUDING idle ones
        // (the recruitment phase deliberately left them idle so we wake
        // them here in the same step that gives them their walk).
        const ants = [];
        for (const a of DN.ants.list) {
          if (a.hero) continue;
          if (a.col !== col) continue;
          if (a.state === 'dead') continue;
          ants.push(a);
        }
        if (!ants.length) return;
        // alternating curl signs around the ring so the 7 lines fan out
        // rather than overlapping
        const sign = (ci % 2 === 0) ? 1 : -1;
        // Negative tStart values mean each ant WAITS at the entrance
        // (curve start) for a fraction of a full traversal before its
        // `migT` reaches 0 and walking begins. With speed=0.12 the full
        // path is ~8.3s; tStart range [-0.55, 0] means the slowest ant
        // emerges ~4.5s after the first. That gives a continuous
        // visible stream of ants leaving the mound and walking the
        // ENTIRE path to the crystal — not pre-distributed along it.
        ants.forEach((a, i) => {
          a._homing = false; // reset before new outbound trip
          a._phaseTrip = 'converge';
          DN.ants.scriptWalk(
            a, col.entrance.x, col.entrance.z, crystal.x, crystal.z,
            {
              speed: 0.12,
              curl: 0.10,
              curlSign: sign,
              tStart: -(i / Math.max(1, ants.length - 1)) * 0.55,
              onArrive: convergerArrivedAtCrystal
            }
          );
          a.laneOffset = (i % 2 === 0 ? -1 : 1) * 0.08;
          count++;
        });
      });
      L.convergeTarget = count;
      if (DN.logTerm) DN.logTerm.push('SYSTEM', count + ' workers converging on the crystal in 7 columns.');
      // No camera change — kickoff framing already shows every colony
      // + the crystal at centre.
    },
    ingress: () => {
      L.ingressDone = false;
      if (L.staticMode) {
        L.ingressDone = true;
        if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'rooms', mode: 'Ants in rooms' });
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Static view retained; no underground camera move needed.');
        return;
      }
      // Workers who are already on their home leg (a._homing === true)
      // are left alone — they're walking home in single file already.
      // Anyone still outbound or stalled gets snapped onto a fast home
      // walk so the surface clears within the 6s phase.
      let homing = 0;
      for (const a of DN.ants.list) {
        if (a.hero) continue;
        if (a.state === 'idle' || a.state === 'dead') continue;
        if (a._homing) continue; // already heading home — don't interrupt
        DN.ants.scriptWalk(
          a, a.x, a.z, a.col.entrance.x, a.col.entrance.z,
          { speed: 0.24, curl: 0.04, onArrive: hideAnt }
        );
        a._homing = true;
        homing++;
      }
      if (homing && DN.logTerm) DN.logTerm.push('SYSTEM', homing + ' stragglers heading underground.');
      if (DN.crystal) DN.crystal.hide();
      // Delay the underground dive by a couple of seconds so the user
      // sees the homing ants actually reach the mounds before the
      // camera cuts to the chamber view.
      const col = DN.colony && DN.colony.list && DN.colony.list[0];
      if (col && DN.app && DN.app.enterColony) {
        setTimeout(() => {
          if (L.phase === 'ingress') DN.app.enterColony(col);
          L.ingressDone = true;
        }, 2200);
      } else {
        L.ingressDone = true;
      }
    },
    debate: () => {
      L.debateDone = false;
      // Reset the forecast trigger so we only exit on forecasts that
      // arrive AFTER debate starts. Otherwise leftover forecast events
      // drained during converge/ingress would immediately collapse the
      // debate phase before any chamber message appears.
      if (DN.commsViz) DN.commsViz._sawForecast = false;
      if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Chambers in session — waiting on backend debate events.');
      if (L.staticMode) {
        if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'rooms', mode: 'Ants in rooms' });
      } else if (DN.underground && DN.underground.startDebate) {
        DN.underground.startDebate();
      }
      // Backend writes events.jsonl in a single batch at the END of the
      // run (the API doesn't stream live), so the buffer may be empty
      // when this phase fires. Poll until events arrive (or the run
      // completes), then stream them into the chambers with timing.
      const MAX_WAIT_MS = 45000;
      const POLL_MS = 1500;
      const startedAt = Date.now();
      let streamed = false;
      const tryStream = () => {
        if (streamed) return;
        const events = DN.databridge && DN.databridge.getCommunications ? DN.databridge.getCommunications() : [];
        const discussionEvents = events.filter((ev) => ev && ev.event_type !== 'forecast');
        const buffered = discussionEvents.length;
        const elapsed = Date.now() - startedAt;
        if (buffered > 0) {
          streamed = true;
          if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Streaming ' + Math.min(buffered, 24) + ' real debate events into chambers.');
          const STRIDE = 520;
          const COUNT = 24;
          if (DN.commsViz && DN.commsViz.bufferChamberEvents) {
            DN.commsViz.bufferChamberEvents(discussionEvents.slice(0, COUNT));
          }
          if (DN.commsViz && DN.commsViz.streamChambersFromBuffer) {
            DN.commsViz.streamChambersFromBuffer({ count: COUNT, strideMs: STRIDE, logRows: true });
          }
          // Debate ends after the curated chamber stream and comms queue
          // finish. Forecast rows may already exist in the backend batch,
          // but rendering them immediately makes the UI jump from dispute
          // to betting without the colony-room discussion beat.
          const visibleCount = Math.max(8, Math.min(COUNT, buffered));
          const streamDurationMs = visibleCount * STRIDE + 2200;
          const streamFinishedAt = Date.now() + streamDurationMs;
          const watcher = () => {
            const streamDone = Date.now() >= streamFinishedAt;
            const drainIdle = !DN.commsViz || !DN.commsViz.isIdle || DN.commsViz.isIdle();
            if (streamDone && drainIdle) {
              if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Chamber discussion complete — moving to forecast settlement.');
              L.debateDone = true;
              return;
            }
            setTimeout(watcher, 200);
          };
          setTimeout(watcher, 200);
          return;
        }
        if (elapsed >= MAX_WAIT_MS) {
          if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Backend events not arriving after ' + Math.round(MAX_WAIT_MS / 1000) + 's — advancing without debate text.');
          L.debateDone = true;
          return;
        }
        // Kick a fresh poll so events show up as soon as the backend
        // writes events.jsonl
        if (DN.hud && DN.hud._pollComms) DN.hud._pollComms();
        setTimeout(tryStream, POLL_MS);
      };
      tryStream();
    },
    resolution: () => {
      if (DN.underground && DN.underground.stopDebate) DN.underground.stopDebate();
      if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'predict', mode: 'Predictions ready' });
      L.phaseHold = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        L.phaseHold = false;
        L.phaseT = 0;
      };
      settleRunEconomy().finally(release);
      // Watchdog: settle network calls can hang (backend down, missing
      // ARC_TREASURY_PRIVATE_KEY, etc.) — force-release after 12s so
      // the demo still advances to egress_roam and ants emerge.
      setTimeout(() => {
        if (!released && DN.logTerm) DN.logTerm.push('SYSTEM', 'Settle still in flight after 12s — advancing to egress so the run continues.');
        release();
      }, 12000);
    },
    egress_roam: () => {
      if (L.staticMode) {
        deriveOutcomes();
        if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Run complete — scene remains static for inspection.');
        return;
      }
      // Back to surface; derive per-agent outcome, then have each
      // colony's workers emerge in a single-file line and walk to a
      // shared roam target. The shared per-colony target means all
      // ants from one mound walk one column out together.
      if (DN.app && DN.app.exitColony) DN.app.exitColony();
      deriveOutcomes();
      let woke = 0;
      (DN.colony.list || []).forEach((col, ci) => {
        // One destination per colony — far enough out to be visible.
        const ang = (ci / Math.max(1, (DN.colony.list || []).length)) * Math.PI * 2;
        const r = 30;
        const tx = col.pos.x + Math.cos(ang) * r;
        const tz = col.pos.z + Math.sin(ang) * r;
        const ants = [];
        for (const a of DN.ants.list) {
          if (a.hero) continue;
          if (a.col !== col) continue;
          if (a.outcome === 'culled') continue;
          if (a.state !== 'idle') continue;
          ants.push(a);
        }
        if (!ants.length) return;
        const sign = (ci % 2 === 0) ? 1 : -1;
        ants.forEach((a, i) => {
          // Negative tStart → ants wait at the entrance and emerge one
          // by one over ~5 seconds, walking the full path out.
          DN.ants.scriptWalk(
            a, col.entrance.x, col.entrance.z, tx, tz,
            {
              speed: 0.08,
              curl: 0.10,
              curlSign: sign,
              tStart: -(i / Math.max(1, ants.length - 1)) * 0.45,
              onArrive: roamHop
            }
          );
          a.laneOffset = (i % 2 === 0 ? -1 : 1) * 0.08;
          woke++;
        });
      });
      if (DN.logTerm) DN.logTerm.push('SYSTEM', woke + ' agents emerging in colony columns with their outcomes.');
      // App.exitColony fires its own short close-up flyTo to the colony
      // it dove into (~600ms later). Wait for that to settle, then ease
      // back to the same wide kickoff framing so the outcome cloud is
      // visible across every colony.
      setTimeout(() => {
        if (L.phase === 'egress_roam' && DN.camera && DN.camera.flyTo) {
          DN.camera.flyTo(new THREE.Vector3(0, 0, 0), 190, 120, 2.4);
        }
      }, 1200);
    }
  };

  async function settleRunEconomy() {
    if (!DN.databridge || !DN.databridge.setupForecastDemo || !DN.databridge.settleForecastDemo) {
      if (DN.logTerm) DN.logTerm.push('SETTLE', 'Skipping on-chain economy — forecast API unavailable.');
      return;
    }
    const meta = selectedGameMeta();
    const contract = configuredContract();
    const walletStore = configuredForecastWalletStore();
    // The lifecycle only reaches resolution after the scouting run and KG
    // replay complete, so this should be the selected run id.
    const runId = L.runId || (DN.databridge && DN.databridge.runId) || null;
    if (!runId) {
      if (DN.logTerm) DN.logTerm.push('SETTLE', 'Skipping on-chain economy — no completed backend run.');
      return;
    }
    if (DN.hud && DN.hud.updateBackendFlow) DN.hud.updateBackendFlow({ stage: 'settle', mode: 'Settlement' });
    const marketKey = runMarketKey(meta, runId);
    L.winner = selectedWinner();
    if (DN.logTerm) {
      if (contract) DN.logTerm.push('CONTRACT', 'Using Arc forecast contract ' + contract);
      DN.logTerm.push('STAKE', 'Creating Arc market and staking ant forecasts from ' + runId + ' …');
    }
    try {
      const setup = await DN.databridge.setupForecastDemo({
        contract: contract || undefined,
        market_key: marketKey,
        market_type: meta.market_type || 'three_way',
        metadata_uri: meta.market_key || marketKey,
        run_id: runId || undefined,
        expected_match_id: L.skipScouting ? undefined : (meta.match_id || meta.market_key || undefined),
        wallet_store: walletStore || undefined,
        max_stakers: 12,
        wait_for_run_forecasts: true,
        run_forecast_timeout_seconds: 240,
        allow_fallback_stakes: false,
        fee_bps: 1000
      });
      L.marketKey = (setup && setup.market_key) || marketKey;
      L.forecastContract = (setup && setup.contract) || contract || L.forecastContract;
      L.forecastStakes = (setup && setup.stakes) || [];
      const totals = (setup && setup.totals) || {};
      logForecastChainTrail('STAKE', setup);
      if (DN.logTerm) {
        DN.logTerm.push(
          'STAKE',
          'Stakes committed from ' + ((setup && setup.stake_source) || 'backend forecasts') +
            ' · ' + (totals.total_usdc || '?') + ' USDC escrowed.'
        );
      }

      let winner = L.winner;
      let winnerSide = winnerSideFor(winner, meta);
      let winningAgents = L.forecastStakes
        .filter((stake) => stake.outcome === winnerSide)
        .map((stake) => stake.agent);
      if (!winningAgents.length && L.forecastStakes.length) {
        winnerSide = sideWithLargestStake(L.forecastStakes);
        winner = winnerNameForSide(winnerSide, meta);
        winningAgents = L.forecastStakes
          .filter((stake) => stake.outcome === winnerSide)
          .map((stake) => stake.agent);
        if (DN.logTerm) {
          DN.logTerm.push('SETTLE', 'Selected winner had no staked ants; resolving to staked side ' + winner + ' so payouts can claim.');
        }
      }
      L.winner = winner;
      if (DN.logTerm) DN.logTerm.push('SETTLE', 'Settling Arc market with winner = ' + winner + ' …');
      const settled = await DN.databridge.settleForecastDemo({
        contract: contract || undefined,
        market_key: L.marketKey,
        winner,
        home_team: meta.home_team,
        away_team: meta.away_team,
        wallet_store: walletStore || undefined,
        winning_agents: winningAgents
      });
      L.forecastContract = (settled && settled.contract) || L.forecastContract || contract || null;
      logForecastChainTrail('SETTLE', settled);
      const settleTx = firstTransactionForAction(settled, 'settle');
      L.settleTxHash = settleTx ? settleTx.hash : null;
      if (DN.logTerm) {
        DN.logTerm.push(
          'SETTLE',
          winner + ' settled · ' + winningAgents.length + ' winners claimed' +
            (settleTx ? ' · settlement tx ' + settleTx.hash + (settleTx.explorer_url ? ' · ' + settleTx.explorer_url : '') : '')
        );
      }
      await applySettlementEvolution(winnerSide);
    } catch (err) {
      if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Economy settlement error: ' + (err && err.message || err));
    }
  }

  function agentIdForCandidate(item) {
    return String((item && (item.agent_id || item.agent || item.agentId)) || '').trim();
  }

  function candidateStake(item) {
    const n = Number(item && (item.stake != null ? item.stake : item.amount));
    return Number.isFinite(n) ? n : 0;
  }

  function uniqueForecastCandidates(winnerSide) {
    const comms = (DN.databridge && DN.databridge.getCommunications)
      ? DN.databridge.getCommunications().filter(e => e.event_type === 'forecast')
      : [];
    const storedForecasts = (DN.databridge && DN.databridge.getForecasts)
      ? DN.databridge.getForecasts()
      : [];
    const source = []
      .concat(comms.map((f) => ({ agent_id: f.agent_id, side: f.side, stake: f.stake })))
      .concat(storedForecasts.map((f) => ({ agent_id: f.agent_id, side: f.side, stake: f.stake })))
      .concat((L.forecastStakes || []).map((s) => ({ agent_id: s.agent, side: s.outcome, stake: s.amount })));
    const seen = new Set();
    const out = [];
    for (const item of source) {
      const agentId = agentIdForCandidate(item);
      const side = String(item.side || item.outcome || '').trim();
      if (!agentId || !side || side === 'pass') continue;
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      out.push({
        agent_id: agentId,
        side,
        stake: candidateStake(item),
        correct: side === winnerSide,
      });
    }
    out.sort((a, b) => (b.stake - a.stake) || a.agent_id.localeCompare(b.agent_id));
    return out;
  }

  function visibleAntForAgent(agentId) {
    if (!DN.ants || !DN.ants.list) return null;
    return DN.ants.list.find((a) => a.agentRecord && a.agentRecord.agent_id === agentId) || null;
  }

  function markVisibleAntKilled(agentId) {
    const ant = visibleAntForAgent(agentId);
    if (!ant) return null;
    ant.outcome = 'culled';
    ant.state = 'dead';
    ant.deadTimer = 2.0;
    ant.permanentDead = true;
    if (ant.agentRecord) ant.agentRecord.status = 'dead';
    return ant;
  }

  async function applySettlementEvolution(winnerSide) {
    const settlementEvolutionCount = 5;
    if (!DN.databridge || !DN.databridge.killAnt || !DN.databridge.reproduceAnt) {
      if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Skipping settlement evolution — ant lifecycle API unavailable.');
      return;
    }
    const candidates = uniqueForecastCandidates(winnerSide);
    const wrong = candidates.filter((item) => !item.correct).slice(0, settlementEvolutionCount);
    const correct = candidates.filter((item) => item.correct).slice(0, settlementEvolutionCount);
    if (DN.logTerm) {
      DN.logTerm.push(
        'LINEAGE',
        'Settlement evolution queued: ' + wrong.length + ' wrong ants culled · ' + correct.length + ' correct ants reproducing.'
      );
    }

    let killed = 0;
    for (const item of wrong) {
      try {
        const result = await DN.databridge.killAnt(item.agent_id, { reason: 'wrong_prediction_settlement' });
        markVisibleAntKilled(item.agent_id);
        killed++;
        const ant = (result && result.ant) || {};
        const name = ant.ens_name || ant.agent_id || item.agent_id;
        if (DN.logTerm) DN.logTerm.push('CULL', name + ' killed after wrong settlement prediction.');
      } catch (err) {
        if (DN.logTerm) DN.logTerm.push('CULL', item.agent_id + ' kill failed: ' + (err && err.message || err));
      }
    }

    let born = 0;
    for (const item of correct) {
      try {
        const parentAnt = visibleAntForAgent(item.agent_id);
        const payload = await DN.databridge.reproduceAnt({
          parent_agent_id: item.agent_id,
          wallet_store: configuredForecastWalletStore() || undefined,
        });
        const child = (payload && payload.child) || null;
        if (child && DN.ants && DN.ants.attachChildRecord) {
          const childAnt = DN.ants.attachChildRecord(parentAnt, child);
          if (childAnt) {
            childAnt.outcome = 'correct';
            childAnt.state = childAnt.state === 'dead' ? 'idle' : childAnt.state;
          }
        }
        born++;
        const childName = child && (child.ens_name || child.agent_id);
        if (DN.logTerm) {
          DN.logTerm.push(
            'LINEAGE',
            item.agent_id + ' reproduced after correct settlement prediction' +
              (childName ? ' → ' + childName : '') + '.'
          );
        }
      } catch (err) {
        if (DN.logTerm) DN.logTerm.push('LINEAGE', item.agent_id + ' reproduction failed: ' + (err && err.message || err));
      }
    }

    if (DN.ants && DN.ants.showOutcomeGlow) DN.ants.showOutcomeGlow();
    if (DN.logTerm) DN.logTerm.push('LINEAGE', 'Settlement evolution complete: ' + killed + ' killed · ' + born + ' born.');
  }

  function deriveOutcomes() {
    const winnerSide = winnerSideFor(L.winner, selectedGameMeta());
    const comms = (DN.databridge && DN.databridge.getCommunications)
      ? DN.databridge.getCommunications().filter(e => e.event_type === 'forecast') : [];
    const stored = (DN.databridge && DN.databridge.getForecasts) ? DN.databridge.getForecasts() : [];
    const source = []
      .concat(comms.map((f) => Object.assign({ _source: 'comms' }, f)))
      .concat(stored.map((f) => Object.assign({ _source: 'stored' }, f)))
      .concat((L.forecastStakes || []).map((s) => ({
        _source: 'stake',
        agent_id: s.agent,
        side: s.outcome,
        stake: s.amount,
      })));
    const knownAgentIds = new Set();
    if (DN.databridge && DN.databridge.getAgents) {
      (DN.databridge.getAgents() || []).forEach((agent) => {
        if (agent && agent.agent_id) knownAgentIds.add(agent.agent_id);
      });
    }
    if (!knownAgentIds.size && DN.ants && DN.ants.list) {
      DN.ants.list.forEach((ant) => {
        if (ant.agentRecord && ant.agentRecord.agent_id) knownAgentIds.add(ant.agentRecord.agent_id);
      });
    }
    const maxScoredAgents = knownAgentIds.size || boundedInt(configuredRun().agents, 200, 1, 200);
    const byAgent = new Map();
    for (const f of source) {
      const agentId = agentIdForCandidate(f);
      if (!agentId || byAgent.has(agentId)) continue;
      if (knownAgentIds.size && !knownAgentIds.has(agentId)) continue;
      if (byAgent.size >= maxScoredAgents) continue;
      byAgent.set(agentId, f);
    }
    let correct = 0, wrong = 0, pending = 0;
    for (const [agentId, f] of byAgent.entries()) {
      const side = String(f.side || f.outcome || '').trim();
      const visible = (DN.ants && DN.ants.list)
        ? DN.ants.list.filter(a => a.agentRecord && a.agentRecord.agent_id === agentId)
        : [];
      visible.forEach((ant) => {
        ant.forecast = f;
        if (side === 'pass') ant.outcome = 'pending';
        else if (side === winnerSide) ant.outcome = 'correct';
        else ant.outcome = 'wrong';
      });
      if (side === 'pass') pending++;
      else if (side === winnerSide) correct++;
      else wrong++;
    }
    if (DN.logTerm) {
      DN.logTerm.push(
        'OUTCOME',
        correct + ' agents correct · ' + wrong + ' wrong' +
          (pending ? ' · ' + pending + ' pending' : '') +
          ' · ' + byAgent.size + ' unique agents scored (winner = ' + (L.winner || '?') + ')'
      );
    }
    if (DN.ants && DN.ants.showOutcomeGlow) DN.ants.showOutcomeGlow();
  }

  // ---- public API -------------------------------------------------------
  L.init = function (scene) {
    L._scene = scene;
    // explicit idle entry
    L.phase = 'idle';
    L.phaseT = 0;
    if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Lifecycle ready — idle. Click Run to start.');
  };

  L.start = function (opts) {
    opts = opts || {};
    // Hard reset, then enter phase 1.
    L.phase = 'idle';
    L.phaseT = 0;
    L.winner = null;
    L.settleTxHash = null;
    L.forecastContract = configuredContract() || null;
    L.runId = null;
    L.marketKey = null;
    L.forecastStakes = [];
    L.runPromise = null;
    L.runError = null;
    L.runResult = null;
    L.backendDone = false;
    L.kgReady = false;
    L.kg = null;
    L.phaseHold = false;
    L.scoutingDone = false;
    L.scoutingResult = null;
    L.scoutingError = null;
    L.kgReplayDone = false;
    L.convergeTarget = 0;
    L.convergeReturned = 0;
    L.ingressDone = false;
    L.debateDone = false;
    L.skipScouting = opts.scout === false || opts.skipScouting === true;
    L.scoutMode = opts.scoutMode || 'openfootball';
    L.staticMode = opts.staticMode !== false;
    // Drop the previous run's cached events AND the chamber message
    // buffer before kicking the new run — otherwise the debate phase
    // replays leftover messages from the prior demo into chambers,
    // making it look like the new run is "generating random messages".
    if (DN.databridge && DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(null);
    if (DN.commsViz && DN.commsViz.reset) DN.commsViz.reset();
    if (ENTER.idle) ENTER.idle();
    enter('kickoff');
  };

  L.reset = function () {
    // Hard reset — stop the running debate / chamber stream / queued
    // events and put every ant back to idle. The next L.start() starts
    // from a clean slate so the demo can be re-run without reloading.
    if (DN.underground && DN.underground.stopDebate) DN.underground.stopDebate();
    if (DN.underground && DN.underground.hideAllChamberMessages) DN.underground.hideAllChamberMessages();
    if (DN.commsViz && DN.commsViz.reset) DN.commsViz.reset();
    if (DN.databridge && DN.databridge.resetCommsRun) DN.databridge.resetCommsRun(null);
    if (DN.txTable && DN.txTable.clear) DN.txTable.clear();
    if (DN.ants && DN.ants.list) {
      for (const a of DN.ants.list) {
        a.state = 'idle';
        a._idleWritten = false;
        a._homing = false;
        a._phaseTrip = null;
        a.scout = false;
        a.hasShard = false;
        a.outcome = null;
        a.forecast = null;
      }
    }
    if (DN.ants && DN.ants.hideOutcomeGlow) DN.ants.hideOutcomeGlow();
    if (DN.crystal && DN.crystal.hide) DN.crystal.hide();
    if (DN.app && DN.app.exitColony && DN.app.view === 'underground') DN.app.exitColony();
    L.runPromise = null;
    L.runResult = null;
    L.runError = null;
    L.backendDone = false;
    L.scoutingDone = false;
    L.kgReplayDone = false;
    L.convergeTarget = 0;
    L.convergeReturned = 0;
    L.ingressDone = false;
    L.debateDone = false;
    L.phaseHold = false;
    L.winner = null;
    L.settleTxHash = null;
    L.forecastContract = configuredContract() || null;
    L.runId = null;
    L.marketKey = null;
    L.forecastStakes = [];
    enter('idle');
    if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Lifecycle reset — agents back to idle.');
  };

  L.getPhase = function () { return L.phase; };
  L.getRunId = function () { return L.runId || (DN.databridge && DN.databridge.runId) || null; };
  L.getEconomyState = function () {
    return {
      contract: L.forecastContract || configuredContract() || '',
      market_key: L.marketKey || '',
      settle_tx_hash: L.settleTxHash || '',
      winner: L.winner || '',
      stakes: (L.forecastStakes || []).slice(),
    };
  };
  L.logForecastChainTrail = logForecastChainTrail;

  function enter(next) {
    L.phase = next;
    L.phaseT = 0;
    L.phaseHold = false;
    logPhase(next);
    try { if (ENTER[next]) ENTER[next](); }
    catch (err) { if (DN.logTerm) DN.logTerm.push('SYSTEM', 'Phase enter error: ' + (err && err.message || err)); }
  }

  function nextPhaseFor(phase) {
    return NEXT[phase];
  }

  function phaseReady(phase) {
    if (phase === 'idle' || phase === 'egress_roam') return false;
    if (phase === 'kickoff') return true;
    if (phase === 'scouting') return L.scoutingDone;
    if (phase === 'kg_forming') return L.kgReplayDone;
    if (phase === 'recruitment') return true;
    if (phase === 'converge') {
      if (L.convergeTarget <= 0) return true;
      // Advance as soon as the majority have returned — the staggered
      // emergence means the last ant takes ~20s, but the column is
      // visibly streaming back home long before that. Hard cap at 14s
      // so even network-stalled animations don't strand the demo.
      const enoughReturned = L.convergeReturned >= L.convergeTarget * 0.5;
      const timedOut = L.phaseT >= 14.0;
      return enoughReturned || timedOut;
    }
    if (phase === 'ingress') return L.ingressDone;
    if (phase === 'debate') return L.debateDone;
    if (phase === 'resolution') return !L.phaseHold;
    return true;
  }

  L.update = function (dt, elapsed) {
    L.phaseT += dt;
    // Per-phase per-frame work
    if (L.phase === 'debate' && DN.underground && DN.underground.tickDebate) {
      DN.underground.tickDebate(dt, elapsed);
    }
    if (L.phaseHold) return;
    const minDuration = L.staticMode ? STATIC_MIN_DURATIONS[L.phase] : MIN_DURATIONS[L.phase];
    if (isFinite(minDuration) && L.phaseT >= minDuration && phaseReady(L.phase)) {
      const next = nextPhaseFor(L.phase);
      if (next) enter(next);
    }
  };

  return L;
})();
