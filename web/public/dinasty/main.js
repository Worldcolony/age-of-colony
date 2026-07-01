// WorldColony — app orchestrator: sim clock, environment, transitions, controls
window.DN = window.DN || {};

DN.app = (function () {
  const App = { view: 'surface', selection: null, following: null };
  const S = { playing: true, speed: 1, simTime: 20, GEN: 60, DAY: 200, lastThought: 0, lastWeather: -100, wIdx: 0 };
  const WEATHER = [
    { name: 'Clear skies', fog: [2600, 5600], temp: 24 },
    { name: 'Soft fog', fog: [1700, 4300], temp: 19 },
    { name: 'Golden haze', fog: [2100, 5000], temp: 27 },
    { name: 'Bright sun', fog: [3000, 6200], temp: 29 }
  ];
  let world, clock, lastHud = 0;

  const THOUGHTS = [
    () => { const c = rc(); return [c.name + ' reinforced a pheromone highway to its richest data cache.', 'Forage', '#E8A23D']; },
    () => { const c = rc(); return [c.name + ' resolved Round #' + S.gen + ' at ' + c.stats.accuracy + '% accuracy — staking pays out.', 'Forecast', '#3FA89F']; },
    () => { const c = rc(); return ['Agents in ' + c.name + ' debated a low-evidence claim; reputation reallocated.', 'Debate', '#8E79C4']; },
    () => { const c = rc(); return [c.name + ' queen seeded ' + (2 + Math.floor(Math.random() * 6)) + ' new agents from top lineages.', 'Lineage', '#D96E54']; },
    () => ['Cross-colony knowledge exchange settled — evidence priced into the next round.', 'Economy', '#E8A23D'],
    () => { const c = lowFood(); return c ? [c.name + ' stores low (' + Math.round(c.stats.food) + '%) — biasing toward forage.', 'Forage', '#E8A23D'] : null; }
  ];
  function rc() { const a = DN.colony.list; return a[Math.floor(Math.random() * a.length)]; }
  function lowFood() { return DN.colony.list.slice().sort((a, b) => a.stats.food - b.stats.food)[0]; }

  function evolve(simDt) {
    DN.colony.list.forEach(c => {
      const s = c.stats;
      const rosterLocked = c._rosterLockedPopulation && Number.isFinite(Number(c._rosterPopulation));
      const rosterPopulation = rosterLocked ? Math.max(0, Number(c._rosterPopulation)) : s.population;
      let consume = rosterPopulation * 0.0006 * simDt;
      if (c.directive === 'defend') consume *= 1.2; if (c.directive === 'expand') consume *= 1.15;
      s.food = Math.max(0, s.food - consume);
      let target = 40 + s.food * 0.5; if (c.directive === 'defend') target += 8;
      s.health += (target - s.health) * Math.min(1, 0.04 * simDt);
      s.health = Math.max(10, Math.min(100, s.health));
      if (rosterLocked) {
        s.population = rosterPopulation;
      } else {
        s.population = Math.max(40, s.population + (s.food > 35 && s.health > 45 ? 0.8 : -0.6) * simDt * (c.directive === 'expand' ? 1.4 : 1));
      }
      s.accuracy = Math.max(45, Math.min(96, s.accuracy + (Math.random() - 0.5) * 0.4 * simDt));
      s.staked = Math.max(80, s.staked + (Math.random() - 0.45) * 8 * simDt);
    });
  }

  function fmtClock() {
    const phase = (S.simTime % S.DAY) / S.DAY, mins = Math.floor(phase * 1440);
    return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  }
  function period(p) { return p < 0.22 ? 'Dawn' : p < 0.5 ? 'Midday' : p < 0.72 ? 'Dusk' : 'Night'; }

  let _rafId = 0;
  function frame() {
    // Pause the entire render+sim loop while the tab is hidden. A
    // backgrounded WebGL canvas otherwise keeps rendering the full scene
    // and forces the (discrete) GPU to stay awake — the main battery drain.
    if (typeof document !== 'undefined' && document.hidden) { _rafId = 0; return; }
    _rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    const el = clock.elapsedTime;
    const timeScale = S.playing ? S.speed : 0;
    const simDt = dt * timeScale;
    if (S.playing) S.simTime += simDt;
    S.gen = Math.floor(S.simTime / S.GEN) + 1;
    const phase = (S.simTime % S.DAY) / S.DAY;

    world.setDaylight(phase);
    if (S.simTime - S.lastWeather > 32) {
      S.lastWeather = S.simTime; S.wIdx = (S.wIdx + 1 + Math.floor(Math.random() * 2)) % WEATHER.length;
      const w = WEATHER[S.wIdx]; if (world.scene.fog) { world.scene.fog.near = w.fog[0]; world.scene.fog.far = w.fog[1]; }
    }

    evolve(simDt);

    if (App.view === 'surface') {
      world.update(dt, el);
      DN.flora.update(dt, el);
      DN.resources.update(dt, el);
      DN.colony.update(dt, el);
      if (DN.queen && DN.queen.update) DN.queen.update(dt, el);
      // Live world: broadcast my queen position (throttled inside supa.js)
      // and tick smoothing for other players' ghost queens.
      if (DN.supa && DN.supa.ready) {
        DN.supa.tick(dt);
        const w = DN.wallet;
        if (w && w.connected && w.pubkey && DN.queen && DN.queen.has && DN.queen.has()) {
          const p = DN.queen.position && DN.queen.position();
          if (p) {
            const facing = (DN.queen.group && DN.queen.group.rotation) ? DN.queen.group.rotation.y : 0;
            const accent = (typeof w.accentColor === 'function') ? w.accentColor() : 0xE8C24A;
            DN.supa.broadcastQueen({ pubkey: w.pubkey, x: p.x, z: p.z, facing, accent });
          }
        }
      }
      DN.ants.update(dt, el, Math.max(0.0001, timeScale));
      DN.trails.update(dt, el);
      if (DN.commsViz && DN.commsViz.update) DN.commsViz.update(dt, el);
      if (DN.crystal && DN.crystal.update) DN.crystal.update(dt, el);
      if (DN.lifecycle && DN.lifecycle.update) DN.lifecycle.update(dt, el);
      if (App.following) DN.camera.follow(() => DN.ants.heroPos(App.following));
      DN.camera.update(dt);
      DN.interactions.update();
      world.renderer.render(world.scene, world.camera);
    } else {
      DN.underground.update(dt, el);
      // Keep the lifecycle ticking + surface ants migrating even while
      // underground — without these the ants we asked to walk home at
      // INGRESS freeze mid-route and never become `idle`, so EGRESS
      // can't find anyone to emerge.
      DN.ants.update(dt, el, Math.max(0.0001, timeScale));
      if (DN.lifecycle && DN.lifecycle.update) DN.lifecycle.update(dt, el);
      DN.interactions.update();
      world.renderer.render(DN.underground.scene, DN.underground.camera);
    }

    if (el - lastHud > 0.25) {
      lastHud = el;
      let staked = 0, acc = 0;
      DN.colony.list.forEach(c => { staked += c.stats.staked; acc += c.stats.accuracy; });
      // Prefer backend agent count when records are available so the top
      // stats row reads the real on-chain population, not the scene's
      // visual ant count (which is just 100 × colony count).
      const liveAgents = DN.databridge && DN.databridge.getAgents ? DN.databridge.getAgents() : [];
      const antsLive = liveAgents && liveAgents.length ? liveAgents.length : DN.ants.list.length;
      DN.hud.setStats({
        colonies: DN.colony.list.length, ants: antsLive, resources: DN.resources.list.filter(r => !r.depleted).length,
        staked, accuracy: Math.round(acc / DN.colony.list.length), round: S.gen
      });
      DN.hud.setTransport({ playing: S.playing, speed: S.speed, gen: S.gen, clock: 'Sol ' + (Math.floor(S.simTime / S.DAY) + 1) + ' · ' + fmtClock(), progress: (S.simTime % S.GEN) / S.GEN });
      const o = DN.hud._open;
      if (o && o.type === 'colony') DN.hud._updateColony(o.col);
      if (o && o.type === 'ant') DN.hud._updateAnt(o.ant);
      if (S.playing && S.simTime - S.lastThought > 6 / Math.max(0.5, S.speed)) {
        S.lastThought = S.simTime; let t = null, n = 0;
        if (DN.databridge && DN.databridge.ready) t = DN.databridge.nextThought();
        while (!t && n++ < 6) t = THOUGHTS[Math.floor(Math.random() * THOUGHTS.length)]();
        if (t) DN.hud.pushThought(t[0], t[1], t[2]);
      }
    }
  }

  // ---- public actions ----
  App.selectColony = function (col) {
    DN.colony.list.forEach(c => c.selected = (c === col));
    DN.ants.heroes.forEach(a => a.selected = false);
    App.selection = col; App.following = null;
    DN.hud.showColony(col);
    DN.camera.flyTo(col.corePos, 30, 18);
  };
  App.selectAnt = function (a) {
    DN.colony.list.forEach(c => c.selected = false);
    DN.ants.heroes.forEach(x => x.selected = (x === a));
    App.selection = a;
    // Glow ring follows the clicked ant — works for both heroes and
    // ordinary instanced workers.
    if (DN.ants.setSelected) DN.ants.setSelected(a);
    // Clicking always starts following — camera chases the ant. Click
    // another ant (or call selectAnt(null)) to release.
    App.following = a;
    DN.camera.follow(() => DN.ants.heroPos(a));
    DN.hud.showAnt(a, true);
  };
  App.toggleFollow = function (a) {
    App.following = (App.following === a) ? null : a;
    if (!App.following) {
      DN.camera.stopFollow();
      if (DN.ants.setSelected) DN.ants.setSelected(null);
    } else if (DN.ants.setSelected) {
      DN.ants.setSelected(a);
    }
    DN.hud.showAnt(a, App.following === a);
  };
  App.setDirective = function (col, d) {
    col.directive = d;
    document.querySelectorAll('#inspector .dir-btn').forEach(b => b.classList.toggle('active', b.dataset.dir === d));
    const msg = { forage: 'Foraging columns dispatched toward the richest caches.', defend: 'Soldiers forming a defensive ring around the mound.', expand: 'Pioneers pushing the frontier to scout fresh ground.' };
    DN.hud.pushThought(col.name + ': ' + msg[d], d.replace(/^./, c => c.toUpperCase()), d === 'forage' ? '#E8A23D' : d === 'defend' ? '#3FA89F' : '#D96E54');
  };
  App.dropFood = function (p) {
    const res = DN.resources.spawn(p.x, p.z, 90);
    if (res) { DN.trails.rebuild(); DN.hud.pushThought('New forage cache detected — nearest foragers rerouting.', 'Forage', '#E8A23D'); }
  };

  // Find the colony currently owned by the connected wallet, if any.
  App.findMyColony = function () {
    const w = window.DN && DN.wallet;
    if (!w || !w.connected || !w.pubkey) return null;
    return DN.colony.list.find(c => c.owner === w.pubkey) || null;
  };

  function saveMyColony(pubkey, payload) {
    // localStorage is the synchronous fallback / offline cache.
    try { localStorage.setItem('dn:my-colony:' + pubkey, JSON.stringify(payload)); } catch (e) {}
    // Supabase mirrors it to the live world so other players see it.
    if (DN.supa && DN.supa.ready) {
      DN.supa.saveColony({ pubkey, ...payload }).catch(() => {});
    }
  }
  function loadMyColonyLocal(pubkey) {
    try { return JSON.parse(localStorage.getItem('dn:my-colony:' + pubkey) || 'null'); } catch (e) { return null; }
  }
  // Returns a Promise<payload|null>. Prefers Supabase (source of truth),
  // falls back to the local cache when offline / not configured.
  async function loadMyColony(pubkey) {
    if (DN.supa && DN.supa.ready) {
      const row = await DN.supa.loadMyColony(pubkey).catch(() => null);
      if (row) {
        try { localStorage.setItem('dn:my-colony:' + pubkey, JSON.stringify({
          angle: row.angle, dist: row.dist, accent: Number(row.accent), name: row.name
        })); } catch (e) {}
        return { angle: row.angle, dist: row.dist, accent: Number(row.accent), name: row.name };
      }
    }
    return loadMyColonyLocal(pubkey);
  }

  App.createUserColony = function (worldPos) {
    const w = window.DN && DN.wallet;
    if (!(w && w.connected)) {
      DN.hud.pushThought('Connect your Phantom wallet first to found your colony.', 'Wallet', '#D96E54');
      return null;
    }
    // One colony per wallet. If the user already founded one this
    // session, jump there instead of placing another.
    const existing = App.findMyColony();
    if (existing) {
      App.selectColony(existing);
      DN.hud.pushThought('You already have a colony — flying you home.', 'Colony', '#E8A23D');
      return existing;
    }
    const angle = Math.atan2(worldPos.z, worldPos.x);
    const dist = Math.hypot(worldPos.x, worldPos.z);
    const accent = (typeof w.accentColor === 'function') ? w.accentColor() : 0xE8A23D;
    const shortAddr = (typeof w.shortAddress === 'function' && w.shortAddress()) || (w.pubkey ? w.pubkey.slice(0, 4) : 'You');
    const name = shortAddr + "'s Colony";
    const col = DN.colony.foundColony({ angle, dist, accent, name, owner: w.pubkey });
    if (col) {
      saveMyColony(w.pubkey, { angle, dist, accent, name });
      App.selectColony(col);
      DN.hud.pushThought('Your colony was founded by ' + shortAddr + '.', 'Colony', '#' + accent.toString(16).padStart(6, '0'));
      if (DN.onboarding && DN.onboarding.notifyColonyFounded) DN.onboarding.notifyColonyFounded();
      if (DN.minimap && DN.minimap.refresh) DN.minimap.refresh();
    } else {
      DN.hud.pushThought('Too close to another colony — try a clearer spot.', 'Wallet', '#D96E54');
    }
    return col;
  };

  // Restore a previously-founded colony for the connected wallet, so the
  // 1-per-wallet rule survives page reloads. Now async because Supabase
  // is the source of truth (with a localStorage fallback).
  App.restoreMyColony = async function () {
    const w = window.DN && DN.wallet;
    if (!w || !w.connected || !w.pubkey) return null;
    if (App.findMyColony()) return null;       // already present
    const saved = await loadMyColony(w.pubkey);
    if (!saved) return null;
    const col = DN.colony.foundColony({
      angle: saved.angle, dist: saved.dist,
      accent: saved.accent, name: saved.name, owner: w.pubkey
    });
    if (col && DN.minimap && DN.minimap.refresh) DN.minimap.refresh();
    return col;
  };

  // Materialise a remote player's colony into the local world. Idempotent:
  // if a colony with that owner already exists, leaves it alone.
  function applyRemoteColony(row) {
    if (!row || !row.pubkey) return null;
    const w = window.DN && DN.wallet;
    // Skip our own — App.restoreMyColony handles that path.
    if (w && w.connected && w.pubkey === row.pubkey) return null;
    const existing = DN.colony.list.find(c => c.owner === row.pubkey);
    if (existing) return existing;
    const col = DN.colony.foundColony({
      angle: row.angle,
      dist: row.dist,
      accent: Number(row.accent),
      name: row.name,
      owner: row.pubkey,
    });
    if (col && DN.minimap && DN.minimap.refresh) DN.minimap.refresh();
    return col;
  }

  // Pull every existing colony from Supabase and render the ones that
  // aren't already on screen. Called once on boot.
  App.hydrateLiveWorld = async function () {
    if (!(DN.supa && DN.supa.ready)) return;
    const rows = await DN.supa.loadColonies().catch(() => []);
    for (const row of rows) applyRemoteColony(row);
  };

  App.enterColony = function (col) {
    if (App.view !== 'surface') return;
    App.selection = col;
    const fade = document.getElementById('fade'); fade.classList.add('show');
    DN.hud.hideEnterBanner();
    setTimeout(() => {
      App.view = 'underground';
      DN.camera.controls.enabled = false;
      DN.underground.resize();
      DN.underground.enter(col);
      DN.hud.setUnderground(true);
      DN.hud.pushThought('Descending into ' + col.name + ' — ' + Math.round(col.stats.population) + ' agents at work below.', 'World', '#E8A23D');
      requestAnimationFrame(() => fade.classList.remove('show'));
    }, 560);
  };
  App.exitColony = function () {
    if (App.view !== 'underground') return;
    const fade = document.getElementById('fade'); fade.classList.add('show');
    setTimeout(() => {
      App.view = 'surface';
      DN.camera.controls.enabled = (DN.camera.mode === 'cinematic');
      DN.hud.setUnderground(false);
      const col = DN.underground.col;
      DN.underground.exit();
      if (col) DN.camera.flyTo(col.corePos, 34, 20);
      requestAnimationFrame(() => fade.classList.remove('show'));
    }, 560);
  };

  App.setBiome = function (i) {
    if (App.view !== 'surface') return;
    const b = DN.biomes[i];
    if (!b || b === DN.world.biome) return;
    const fade = document.getElementById('fade'); fade.classList.add('show');
    DN.hud.setActiveBiome(i);
    setTimeout(() => {
      DN.world.applyBiome(b);
      DN.flora.rebuild();
      DN.hud.pushThought('Surveying ' + b.name + ' — ' + b.tag.toLowerCase() + ' conditions shift across the basin.', 'World', '#E8A23D');
      requestAnimationFrame(() => fade.classList.remove('show'));
    }, 560);
  };

  App.setCameraMode = function (m) {
    if (App.view === 'underground') return;
    DN.camera.setMode(m);
    if (m === 'explore') App.following = null;
  };

  const LENS = {
    world: () => { App.clearSelection(); DN.camera.flyTo(new THREE.Vector3(0, 4, 0), 320, 180, 2); DN.camera.autoRotate(true); },
    colonies: () => { const i = (DN.colony.list.indexOf(App.selection) + 1) % DN.colony.list.length; App.selectColony(DN.colony.list[i < 0 ? 0 : i]); },
    agents: () => { const h = DN.ants.heroes; const i = (h.indexOf(App.selection) + 1) % h.length; const a = h[i < 0 ? 0 : i]; App.selectAnt(a); App.toggleFollow(a); },
    economy: () => { DN.hud.pushThought('Treasury overview — total USDC staked across all colonies is compounding.', 'Economy', '#E8A23D'); },
    forecasts: () => { DN.hud.pushThought('Forecast board — agents are pricing the next round\'s outcome live.', 'Forecast', '#3FA89F'); },
    lineages: () => { DN.hud.pushThought('Lineage view — top-performing families dominate the gene pool.', 'Lineage', '#D96E54'); }
  };
  App.setLens = function (idx) {
    DN.hud.setActiveSlot(idx);
    const ids = ['world', 'colonies', 'agents', 'economy', 'forecasts', 'lineages'];
    if (LENS[ids[idx]]) LENS[ids[idx]]();
  };
  App.clearSelection = function () {
    DN.colony.list.forEach(c => c.selected = false);
    DN.ants.heroes.forEach(a => a.selected = false);
    App.selection = null; App.following = null; DN.camera.stopFollow();
    DN.hud.clearInspector();
  };

  function wire() {
    document.getElementById('play-btn').addEventListener('click', () => { S.playing = !S.playing; DN.camera.autoRotate(S.playing && !App.selection && !App.following); });
    document.querySelectorAll('#speeds .speed').forEach(s => s.addEventListener('click', () => { S.speed = parseFloat(s.dataset.s); }));
    const track = document.getElementById('tl-track'); let scrub = false;
    const doScrub = e => { const r = track.getBoundingClientRect(); const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); S.simTime = Math.floor(S.simTime / S.GEN) * S.GEN + k * S.GEN; };
    track.addEventListener('pointerdown', e => { scrub = true; doScrub(e); track.setPointerCapture(e.pointerId); });
    track.addEventListener('pointermove', e => { if (scrub) doScrub(e); });
    track.addEventListener('pointerup', () => scrub = false);
    document.querySelectorAll('#tools .tool[data-tool]').forEach(t => t.addEventListener('click', () => DN.interactions.setTool(t.dataset.tool)));
    document.getElementById('tool-recenter').addEventListener('click', () => App.setLens(0));
    // World-map tool: toggle Cinematic <-> Minecraft (explore) view. The
    // button reflects the current mode by lighting up while in Minecraft.
    const mapBtn = document.getElementById('tool-map');
    function syncModeBtn() {
      if (mapBtn) mapBtn.classList.toggle('active', DN.camera.mode === 'explore');
    }
    if (mapBtn) mapBtn.addEventListener('click', () => {
      App.setCameraMode(DN.camera.mode === 'explore' ? 'cinematic' : 'explore');
      syncModeBtn();
    });
    syncModeBtn();
    // Keep the button in sync when the mode is changed from elsewhere
    // (keyboard, lens, escape, etc).
    const _origSetMode = App.setCameraMode;
    App.setCameraMode = function (m) { _origSetMode(m); syncModeBtn(); };
    document.querySelectorAll('#cammode .cm').forEach(el => el.addEventListener('click', () => App.setCameraMode(el.dataset.mode)));
    document.getElementById('exitbtn').addEventListener('click', App.exitColony);

    addEventListener('keydown', e => {
      if (e.code === 'Space') {
        if (DN.camera && DN.camera.mode === 'explore') return; // camera uses Space to ascend
        e.preventDefault(); document.getElementById('play-btn').click();
      }
      else if (e.key >= '1' && e.key <= '6' && App.view === 'surface' && DN.camera.mode !== 'explore') App.setLens(parseInt(e.key) - 1);
      else if (e.key === 'f' || e.key === 'F') DN.interactions.setTool(DN.interactions.tool === 'food' ? 'inspect' : 'food');
      else if (e.key === 'c' || e.key === 'C') App.setCameraMode(DN.camera.mode === 'explore' ? 'cinematic' : 'explore');
      else if (e.key === 'e' || e.key === 'E') { if (App.selection && App.selection.stats) App.enterColony(App.selection); }
      else if (e.key === 'm' || e.key === 'M') { if (DN.minimap && DN.minimap.toggle) DN.minimap.toggle(); }
      else if (e.key === 'v' || e.key === 'V') { App.setCameraMode(DN.camera.mode === 'explore' ? 'cinematic' : 'explore'); }
      else if (e.key === 'r' || e.key === 'R') { App.setLens(0); }
      else if (e.key === 'Escape') {
        if (App.view === 'underground') App.exitColony();
        else if (DN.minimap && DN.minimap.isOpen && DN.minimap.isOpen()) DN.minimap.close();
        else if (DN.camera.mode === 'explore') App.setCameraMode('cinematic');
        else App.clearSelection();
      }
    });
    addEventListener('resize', () => DN.underground.resize());
  }

  App.boot = function () {
    world = DN.world.init(document.getElementById('scene'));
    DN.colony.init(world.scene); // before flora so flora can clear around nests
    DN.flora.init(world.scene);
    DN.resources.init(world.scene);
    DN.ants.init(world.scene, DN.colony.list);
    if (DN.commsViz && DN.commsViz.init) DN.commsViz.init(world.scene);
    if (DN.logTerm && DN.logTerm.init) DN.logTerm.init();
    if (DN.crystal && DN.crystal.init) DN.crystal.init(world.scene);
    if (DN.lifecycle && DN.lifecycle.init) DN.lifecycle.init(world.scene);
    DN.trails.init(world.scene, DN.colony.list);
    DN.underground.init();
    DN.camera.init();
    DN.hud.init();
    DN.interactions.init();
    DN.interactions.setTool('inspect');
    DN.hud.setCameraMode('cinematic');
    wire();

    clock = new THREE.Clock();
    // Resume the loop when the tab becomes visible again. `getDelta()` is
    // reset first so we don't apply one giant catch-up dt on the next frame.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !_rafId) { clock.getDelta(); frame(); }
    });
    frame();

    DN.hud.pushThought('WorldColony online — four AI ant civilizations awakening across the basin.', 'World', '#E8A23D');
    setTimeout(() => DN.hud.pushThought('Foragers fanning out along fresh pheromone trails.', 'Forage', '#E8A23D'), 3000);

    setTimeout(() => { document.getElementById('intro').classList.add('hide'); DN.camera.flyTo(new THREE.Vector3(0, 4, 0), 300, 165, 2.4); DN.camera.autoRotate(true); }, 900);
    setTimeout(() => { document.getElementById('intro').style.display = 'none'; }, 2100);
    if (DN.minimap && DN.minimap.init) DN.minimap.init();
    if (DN.onboarding && DN.onboarding.start) DN.onboarding.start();
    if (DN.wallet && typeof DN.wallet.onChange === 'function') {
      DN.wallet.onChange((snap) => {
        if (snap.connected) {
          if (DN.supa && DN.supa.setSelf) DN.supa.setSelf(snap.pubkey);
          App.restoreMyColony().then(() => spawnQueenForWallet());
        }
      });
      if (DN.wallet.connected) {
        if (DN.supa && DN.supa.setSelf) DN.supa.setSelf(DN.wallet.pubkey);
        App.restoreMyColony().then(() => spawnQueenForWallet());
      }
    }
    // Live world wiring — independent of wallet (so spectators see colonies
    // too). Hydrate existing colonies, subscribe to new ones, attach scene
    // to the ghost-queen renderer.
    if (DN.supa && DN.supa.attachScene) DN.supa.attachScene(world.scene, THREE);
    App.hydrateLiveWorld();
    if (DN.supa && DN.supa.subscribeColonies) {
      DN.supa.subscribeColonies((row) => applyRemoteColony(row));
    }
  };

  // Spawn the player's queen avatar at their colony's entrance (or origin
  // if no colony yet). Uses the wallet's accent for the crown.
  function spawnQueenForWallet() {
    if (!DN.queen || !DN.queen.spawn) return;
    if (DN.queen.has && DN.queen.has()) return;     // already spawned
    const w = DN.wallet;
    const accent = (w && typeof w.accentColor === 'function') ? w.accentColor() : 0xE8C24A;
    DN.queen.spawn(world.scene, accent);
    const mine = App.findMyColony && App.findMyColony();
    if (mine && mine.entrance) {
      DN.queen.moveTo(mine.entrance.x, mine.entrance.z, mine.group ? mine.group.rotation.y + Math.PI : 0);
    }
  }

  return App;
})();

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', DN.app.boot);
else DN.app.boot();
