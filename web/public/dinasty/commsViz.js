// WorldColony — communication visualizer.
// Turns backend debate_claim + social_action events into:
//   1. live glowing Bezier arcs between speaker and target ants
//   2. a persistent (decaying) influence-graph overlay
//   3. log + thought-ticker entries
// Fed by backend run events from hud.js/databridge.
window.DN = window.DN || {};

DN.commsViz = (function () {
  const V = { _seen: new Set(), _arcs: [], _edges: new Map(), _queue: [], _queueTimer: null };
  let surfaceScene = null;
  let arcPoints = null;        // shared THREE.Points cloud for all live arcs
  let arcPosAttr = null;
  let arcColAttr = null;
  const ARC_PARTICLES_PER = 8;
  const ARC_MAX = 30;
  const ARC_BUFFER = ARC_MAX * ARC_PARTICLES_PER;

  const ROLE_COLOR = {
    elite:          0xFFD988,
    challenger:     0xFF8B6B,
    skeptic:        0x66E0FF,
    source_auditor: 0xB47EE0,
    wildcard:       0xE26B8E
  };
  const DEFAULT_ROLE_COLOR = 0xFFD988;

  function economyState() {
    if (DN.lifecycle && DN.lifecycle.getEconomyState) return DN.lifecycle.getEconomyState();
    const cfg = (window.DN_CONFIG && window.DN_CONFIG.FORECAST) || {};
    return { contract: cfg.CONTRACT || '', market_key: '', settle_tx_hash: '' };
  }

  function shortHash(value) {
    const text = String(value || '');
    if (text.length < 14) return text;
    return text.slice(0, 8) + '...' + text.slice(-6);
  }

  function marketSideLabel(side, ev) {
    if (DN.databridge && DN.databridge.marketSideLabel) {
      return DN.databridge.marketSideLabel(side, ev || {});
    }
    if (side === 'pass') return 'No stake';
    if (side === 'draw') return 'Draw';
    if (side === 'home') return 'Team A';
    if (side === 'away') return 'Team B';
    return String(side || 'unknown');
  }

  function qualitativeLean(homeProbability, ev) {
    if (homeProbability == null) return '—';
    const value = Number(homeProbability);
    if (!Number.isFinite(value)) return '—';
    const firstSide = marketSideLabel('home', ev);
    const secondSide = marketSideLabel('away', ev);
    if (value >= 0.62) return 'strong ' + firstSide;
    if (value >= 0.54) return 'soft ' + firstSide;
    if (value <= 0.38) return 'strong ' + secondSide;
    if (value <= 0.46) return 'soft ' + secondSide;
    return 'balanced';
  }

  function findAntByAgentId(agentId) {
    if (!agentId || !DN.ants || !DN.ants.list) return null;
    return DN.ants.list.find(a => a.agentRecord && (
      a.agentRecord.agent_id === agentId ||
      a.agentRecord.ens_name === agentId ||
      a.agentRecord.name === agentId
    )) || null;
  }

  // Pick a fan-out target when speaker has no explicit target — nearest
  // ant of a different colony, so the arc visibly crosses the map.
  function pickFanoutTarget(speaker) {
    if (!speaker || !DN.ants || !DN.ants.list.length) return null;
    let best = null, bestD = Infinity;
    for (const a of DN.ants.list) {
      if (a === speaker || a.col === speaker.col || a.hero) continue;
      if (a.state === 'dead' || a.state === 'migrating') continue;
      const dx = a.x - speaker.x, dz = a.z - speaker.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  function ensureArcPoints() {
    if (arcPoints || !surfaceScene) return arcPoints;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(ARC_BUFFER * 3);
    const col = new Float32Array(ARC_BUFFER * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    arcPosAttr = geo.attributes.position;
    arcColAttr = geo.attributes.color;
    const mat = new THREE.PointsMaterial({
      size: 0.9, map: DN.util.softSprite(),
      transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
      vertexColors: true, sizeAttenuation: true
    });
    arcPoints = new THREE.Points(geo, mat);
    arcPoints.frustumCulled = false;
    surfaceScene.add(arcPoints);
    return arcPoints;
  }

  // build a Bezier between two world positions with vertical bow
  function makeArcCurve(ax, ay, az, bx, by, bz) {
    const mid = new THREE.Vector3((ax + bx) / 2, Math.max(ay, by) + 7, (az + bz) / 2);
    return new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(ax, ay, az),
      mid,
      new THREE.Vector3(bx, by, bz)
    );
  }

  V.init = function (sceneRef) {
    surfaceScene = sceneRef;
    ensureArcPoints();
    return V;
  };

  // Called by hud.js after each /recent_communications poll.
  // Field names match the REAL deployed colony_api event schema:
  //   social_action  → actor_id, target_actor_id, text, weight, action_type
  //   debate_claim   → message, confidence, dispute, direction, debate_role
  //                    (no speaker field — synthesis/room aggregation)
  //   forecast       → agent_id, ens_name, side, home_probability, edge, bankroll
  V.ingest = function (events) {
    if (!events || !events.length) return;
    const fresh = [];
    for (const ev of events) {
      const key = [
        ev.event_type || '?',
        ev.action_id || '',
        ev.actor_id || ev.agent_id || '',
        ev.target_actor_id || '',
        (ev.text || ev.message || '').slice(0, 40),
        ev.round_id || ''
      ].join('|');
      if (V._seen.has(key)) continue;
      V._seen.add(key);
      fresh.push(ev);
    }
    if (!fresh.length) return;
    V._queue.push(...fresh);
    V._drainQueue();
    if (V._seen.size > 3000) {
      const arr = Array.from(V._seen).slice(-2000);
      V._seen = new Set(arr);
    }
  };

  V._drainQueue = function () {
    if (V._queueTimer) return;
    // One event per tick at a slow cadence — bursts of 100+ events from
    // a single comms-poll batch otherwise flood the log faster than the
    // user can read.
    const TICK_MS = 80;
    const tick = () => {
      const ev = V._queue.shift();
      if (ev) {
        if (ev.event_type === 'social_action') V._handleSocial(ev);
        else if (ev.event_type === 'debate_claim') V._handleClaim(ev);
        else if (ev.event_type === 'forecast') V._handleForecast(ev);
      }
      if (!V._queue.length) {
        V._queueTimer = null;
        return;
      }
      V._queueTimer = setTimeout(tick, TICK_MS);
    };
    V._queueTimer = setTimeout(tick, TICK_MS);
  };

  // social_action: the primary speaking event. actor speaks (and optionally
  // targets another actor). Always logs; arc-spawn is best-effort.
  V._handleSocial = function (ev) {
    const actorId = ev.actor_id || ev.actor_name;
    const targetId = ev.target_actor_id;
    const actorDisplay = ev.actor_name || actorId || 'agent';
    const isReply = !!targetId && targetId !== actorId;
    const tag = isReply ? 'DISPUTE' : 'SPEAK';
    const role = ev.role || 'speaker';
    const color = ROLE_COLOR[role] || DEFAULT_ROLE_COLOR;
    const text = (ev.text || '').replace(/\s+/g, ' ').trim();
    const snippet = text.length > 140 ? text.slice(0, 138) + '…' : text;
    let logMsg;
    if (isReply) {
      logMsg = actorDisplay + ' → ' + targetId + (snippet ? ': "' + snippet + '"' : '');
    } else {
      logMsg = actorDisplay + ' (' + (ev.action_type || 'speaks') + ')' + (snippet ? ': "' + snippet + '"' : '');
    }
    if (DN.logTerm) DN.logTerm.push(tag, logMsg);
    if (DN.hud && DN.hud.pushThought && snippet) {
      DN.hud.pushThought(snippet, actorDisplay, '#' + color.toString(16).padStart(6, '0'));
    }
    // Always buffer the latest chamber-eligible events so they can
    // replay into the chamber-bubble overlay when the user dives
    // underground / debate phase starts (events often arrive BEFORE
    // the user is underground).
    if (snippet) {
      V._bufferChamberMsg(ev.room_id || actorId || ev.action_id || '', actorDisplay, isReply ? targetId : null, snippet);
      // Live route too — `showChamberMessage` internally no-ops if
      // underground isn't active, so this is safe regardless of phase.
      if (DN.underground && DN.underground.showChamberMessage) {
        const keySrc = ev.room_id || actorId || ev.action_id || '';
        let h = 0;
        for (let i = 0; i < keySrc.length; i++) h = ((h * 31) + keySrc.charCodeAt(i)) | 0;
        DN.underground.showChamberMessage(h, actorDisplay, isReply ? targetId : null, snippet);
      }
    }
    V._bumpEdge(actorId, targetId, ev.weight || 0.3);
    // best-effort arc
    const speaker = findAntByAgentId(actorId);
    if (!speaker) return;
    let target = targetId ? findAntByAgentId(targetId) : null;
    if (!target) target = pickFanoutTarget(speaker);
    if (!target) return;
    V._spawnArc(speaker, target, color, 3.0 + (ev.weight || 0.5) * 2.0);
  };

  // debate_claim: chamber-level synthesis / aggregate. No speaker, so we
  // log the message and (if confidence high) flash a bright pulse on a
  // random ant of each colony as a "room speaks" effect.
  V._handleClaim = function (ev) {
    const role = ev.debate_role || 'elite';
    const color = ROLE_COLOR[role] || DEFAULT_ROLE_COLOR;
    const tag = ev.dispute && Object.keys(ev.dispute).length ? 'DISPUTE' : 'SPEAK';
    const text = (ev.message || '').replace(/\s+/g, ' ').trim();
    const snippet = text.length > 160 ? text.slice(0, 158) + '…' : text;
    const speaker = ev.persona || ev.claim_type || 'chamber';
    if (DN.logTerm) DN.logTerm.push(tag, speaker + ': "' + snippet + '"');
    if (DN.hud && DN.hud.pushThought && snippet) {
      DN.hud.pushThought(snippet, speaker, '#' + color.toString(16).padStart(6, '0'));
    }
    // Buffer + live-route the chamber-synthesis line (no phase gate —
    // showChamberMessage no-ops when not underground).
    if (snippet) {
      V._bufferChamberMsg(ev.room_id || ev.round_id || ev.persona || 'synthesis', speaker, null, snippet);
      if (DN.underground && DN.underground.showChamberMessage) {
        const keySrc = ev.room_id || ev.round_id || ev.persona || 'synthesis';
        let h = 0;
        for (let i = 0; i < keySrc.length; i++) h = ((h * 31) + keySrc.charCodeAt(i)) | 0;
        DN.underground.showChamberMessage(h, speaker, null, snippet);
      }
    }
  };

  V._handleForecast = function (ev) {
    // The first forecast event signals "debate over, betting begun" —
    // the lifecycle uses this to know when to leave the chamber.
    V._sawForecast = true;
    if (!DN.logTerm) return;
    const aid = ev.ens_name || ev.agent_id || 'agent';
    const side = marketSideLabel(ev.side || 'pass', ev);
    const lean = qualitativeLean(ev.home_probability, ev);
    const edge = ev.edge != null ? Number(ev.edge).toFixed(2) : '—';
    const bank = ev.credits_balance != null ? Math.round(Number(ev.credits_balance)) : ev.bankroll != null ? Math.round(Number(ev.bankroll)) : '—';
    const economy = economyState();
    if (economy.contract && !V._forecastContractLogged) {
      V._forecastContractLogged = true;
      DN.logTerm.push('CHAIN', 'FORECAST contract ' + economy.contract);
    }
    const contractBit = economy.contract ? ', contract ' + shortHash(economy.contract) : '';
    const marketBit = economy.market_key ? ', market ' + economy.market_key : '';
    DN.logTerm.push('FORECAST', aid + ' → ' + side + ' · ' + lean + ' (edge read ' + edge + ', credits ' + bank + contractBit + marketBit + ')');
  };

  V.sawForecast = function () { return !!V._sawForecast; };

  V._bumpEdge = function (fromId, toId, weight) {
    if (!fromId || !toId || fromId === toId) return;
    const key = fromId + '->' + toId;
    const now = performance.now();
    const cur = V._edges.get(key) || { fromId, toId, weight: 0, last: 0 };
    cur.weight = Math.min(2.0, cur.weight + (weight || 0.2));
    cur.last = now;
    V._edges.set(key, cur);
  };

  // Phase gate: only spawn surface arcs during DEBATE / RESOLUTION /
  // EGRESS — otherwise an old run's social_action events would draw
  // arcs across the world during scouting / kg_forming, which the
  // lifecycle never wants. Log rows still stream.
  V._arcsAllowed = function () {
    if (!DN.lifecycle || !DN.lifecycle.getPhase) return true;
    const p = DN.lifecycle.getPhase();
    return p === 'debate' || p === 'resolution' || p === 'egress_roam';
  };

  V._spawnArc = function (speaker, target, color, ttl) {
    if (!V._arcsAllowed()) return;
    if (V._arcs.length >= ARC_MAX) {
      // evict oldest (lowest remaining ttl)
      V._arcs.shift();
    }
    const curve = makeArcCurve(speaker.x, 1, speaker.z, target.x, 1, target.z);
    const offs = [];
    for (let i = 0; i < ARC_PARTICLES_PER; i++) offs.push(i / ARC_PARTICLES_PER);
    V._arcs.push({
      curve,
      colorR: ((color >> 16) & 0xFF) / 255,
      colorG: ((color >> 8) & 0xFF) / 255,
      colorB: (color & 0xFF) / 255,
      offs,
      ttl,
      age: 0,
      speed: 0.4 + Math.random() * 0.3
    });
  };

  V.update = function (dt /*, elapsed */) {
    if (!arcPoints) return;
    const tmp = new THREE.Vector3();
    let p = 0;
    for (let i = V._arcs.length - 1; i >= 0; i--) {
      const a = V._arcs[i];
      a.age += dt;
      if (a.age >= a.ttl) { V._arcs.splice(i, 1); continue; }
      const fade = Math.min(1, a.age / 0.4) * Math.min(1, (a.ttl - a.age) / 0.6);
      for (let k = 0; k < a.offs.length; k++) {
        const t = (a.offs[k] + a.age * a.speed) % 1;
        a.curve.getPoint(t, tmp);
        const ai = p * 3;
        arcPosAttr.array[ai]     = tmp.x;
        arcPosAttr.array[ai + 1] = tmp.y;
        arcPosAttr.array[ai + 2] = tmp.z;
        arcColAttr.array[ai]     = a.colorR * fade;
        arcColAttr.array[ai + 1] = a.colorG * fade;
        arcColAttr.array[ai + 2] = a.colorB * fade;
        p++;
        if (p >= ARC_MAX * ARC_PARTICLES_PER) break;
      }
      if (p >= ARC_MAX * ARC_PARTICLES_PER) break;
    }
    arcPosAttr.needsUpdate = true;
    arcColAttr.needsUpdate = true;
    arcPoints.geometry.setDrawRange(0, p);
  };

  // expose so hud/influence overlay can read accumulated influence later
  V.getEdges = function () { return Array.from(V._edges.values()); };

  // ---- chamber-message buffer + replay --------------------------------
  // Real backend social_action / debate_claim events frequently arrive
  // BEFORE the user dives underground. We stash the last 30 of them in
  // a rolling buffer so when DEBATE phase fires (or whenever the user
  // is underground), we can stream them into the chamber bubbles for
  // visible activity.
  V._chamberMsgs = [];
  V._chamberStreamTimers = [];
  V._bufferChamberMsg = function (keySrc, actor, target, text, tag) {
    V._chamberMsgs.push({ keySrc: String(keySrc || ''), actor, target, text, tag: tag || (target ? 'DISPUTE' : 'SPEAK') });
    if (V._chamberMsgs.length > 60) V._chamberMsgs.shift();
  };

  V.bufferChamberEvents = function (events) {
    if (!events || !events.length) return;
    events.forEach((ev) => {
      if (!ev) return;
      if (ev.event_type === 'social_action') {
        const actorId = ev.actor_id || ev.actor_name;
        const targetId = ev.target_actor_id;
        const actorDisplay = ev.actor_name || actorId || 'agent';
        const isReply = !!targetId && targetId !== actorId;
        const text = (ev.text || '').replace(/\s+/g, ' ').trim();
        const snippet = text.length > 140 ? text.slice(0, 138) + '...' : text;
        if (snippet) V._bufferChamberMsg(ev.room_id || actorId || ev.action_id || '', actorDisplay, isReply ? targetId : null, snippet);
      } else if (ev.event_type === 'debate_claim') {
        const text = (ev.message || '').replace(/\s+/g, ' ').trim();
        const snippet = text.length > 160 ? text.slice(0, 158) + '...' : text;
        const speaker = ev.persona || ev.claim_type || 'chamber';
        if (snippet) V._bufferChamberMsg(ev.room_id || ev.round_id || ev.persona || 'synthesis', speaker, null, snippet);
      }
    });
  };

  V.streamChambersFromBuffer = function (opts) {
    opts = opts || {};
    V._chamberStreamTimers.forEach((t) => clearTimeout(t));
    V._chamberStreamTimers = [];
    const msgs = V._chamberMsgs.slice(-(opts.count || 24));
    const stride = Math.max(80, opts.strideMs || 480);
    const logRows = opts.logRows !== false;
    msgs.forEach((m, i) => {
      let h = 0;
      const key = m.keySrc + ':' + i;
      for (let j = 0; j < key.length; j++) h = ((h * 31) + key.charCodeAt(j)) | 0;
      const timer = setTimeout(() => {
        if (DN.underground && DN.underground.showChamberMessage) {
          DN.underground.showChamberMessage(h, m.actor, m.target, m.text);
        }
        if (logRows && DN.logTerm) {
          const arrow = m.target ? ' → ' + m.target : '';
          DN.logTerm.push(m.tag || 'SPEAK', (m.actor || 'agent') + arrow + ': "' + (m.text || '') + '"');
        }
      }, i * stride);
      V._chamberStreamTimers.push(timer);
    });
  };

  V.isIdle = function () {
    return !V._queue.length && !V._queueTimer;
  };


  // Wipe the dedup table so a fresh backend run's events all re-dispatch.
  // Called after Run-LLM / Scouting completes (when the backend switches
  // to a new run_id and old action_ids might collide with new ones).
  V.reset = function () {
    V._seen = new Set();
    V._queue.length = 0;
    if (V._queueTimer) {
      clearTimeout(V._queueTimer);
      V._queueTimer = null;
    }
    V._chamberStreamTimers.forEach((t) => clearTimeout(t));
    V._chamberStreamTimers = [];
    V._chamberMsgs.length = 0;
    V._sawForecast = false;
    V._arcs.length = 0;
    V._edges.clear();
    V._forecastContractLogged = false;
  };

  return V;
})();
