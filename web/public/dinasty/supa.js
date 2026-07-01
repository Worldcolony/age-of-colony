// WorldColony — Supabase live-world bridge
// ------------------------------------------------------------------
// Wires the frontend to Supabase for two things:
//   1. colonies   — persistent table, one row per Phantom wallet
//   2. queens     — ephemeral Realtime Broadcast channel ("queens"),
//                   carries live position/heading of every online player
//
// If SUPABASE_URL or SUPABASE_ANON_KEY is empty, the module no-ops and
// callers should fall back to localStorage.
window.DN = window.DN || {};

DN.supa = (function () {
  const S = {
    ready: false,
    client: null,
    selfPubkey: null,
  };

  const cfg = (window.DN_CONFIG || {});
  const URL = cfg.SUPABASE_URL || '';
  const KEY = cfg.SUPABASE_ANON_KEY || '';

  // Throttle queen broadcasts to keep traffic sane (Hz)
  const QUEEN_HZ = 3;
  const QUEEN_MIN_MS = 1000 / QUEEN_HZ;
  // Drop ghost queens that haven't pinged in this window (ms)
  const GHOST_TTL_MS = 10000;

  // ---- channels ----
  let queensChannel = null;
  let queensJoined = false;
  let coloniesChannel = null;
  let lastQueenSendAt = 0;
  let lastQueenPayload = null;

  // ---- ghost queens (other players, rendered locally) ----
  // Map<pubkey, { group, accent, target:{x,z}, facing:number, lastSeen:number }>
  const ghosts = new Map();
  let scene3D = null;
  let _THREE = null;

  function libsLoaded() {
    return typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function';
  }

  function configured() {
    return !!(URL && KEY);
  }

  S.init = function () {
    if (S.ready) return S;
    if (!configured()) {
      console.warn('[supa] SUPABASE_URL or SUPABASE_ANON_KEY missing — live world disabled, using localStorage fallback.');
      return S;
    }
    if (!libsLoaded()) {
      console.warn('[supa] @supabase/supabase-js not loaded yet — retrying shortly.');
      setTimeout(() => S.init(), 250);
      return S;
    }
    try {
      S.client = window.supabase.createClient(URL, KEY, {
        realtime: { params: { eventsPerSecond: 10 } },
      });
      S.ready = true;
    } catch (err) {
      console.warn('[supa] init failed:', err && err.message);
    }
    return S;
  };

  // -----------------------------------------------------------------
  // COLONIES — persistent
  // -----------------------------------------------------------------
  S.saveColony = async function (payload) {
    if (!S.ready) return null;
    const row = {
      pubkey: payload.pubkey,
      angle: payload.angle,
      dist: payload.dist,
      accent: payload.accent,
      name: payload.name,
    };
    const { data, error } = await S.client
      .from('colonies')
      .upsert(row, { onConflict: 'pubkey' })
      .select()
      .single();
    if (error) { console.warn('[supa] saveColony error:', error.message); return null; }
    return data;
  };

  S.loadColonies = async function () {
    if (!S.ready) return [];
    const { data, error } = await S.client
      .from('colonies')
      .select('*')
      .order('founded_at', { ascending: true });
    if (error) { console.warn('[supa] loadColonies error:', error.message); return []; }
    return data || [];
  };

  S.loadMyColony = async function (pubkey) {
    if (!S.ready || !pubkey) return null;
    const { data, error } = await S.client
      .from('colonies')
      .select('*')
      .eq('pubkey', pubkey)
      .maybeSingle();
    if (error) { console.warn('[supa] loadMyColony error:', error.message); return null; }
    return data || null;
  };

  // Subscribe to colony insert/update events for other players. Pass two
  // callbacks: onColony(row) is fired for both insert and update so the
  // consumer can idempotently render the mound.
  S.subscribeColonies = function (onColony) {
    if (!S.ready) return () => {};
    if (coloniesChannel) {
      try { S.client.removeChannel(coloniesChannel); } catch (e) {}
      coloniesChannel = null;
    }
    coloniesChannel = S.client
      .channel('public:colonies')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'colonies' }, (msg) => {
        if (msg && msg.new && typeof onColony === 'function') onColony(msg.new);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'colonies' }, (msg) => {
        if (msg && msg.new && typeof onColony === 'function') onColony(msg.new);
      })
      .subscribe();
    return () => {
      try { S.client.removeChannel(coloniesChannel); } catch (e) {}
      coloniesChannel = null;
    };
  };

  // -----------------------------------------------------------------
  // QUEENS — ephemeral live positions via Realtime Broadcast
  // -----------------------------------------------------------------
  function ensureQueensChannel() {
    if (!S.ready || queensChannel) return queensChannel;
    queensChannel = S.client.channel('queens', {
      config: { broadcast: { ack: false, self: false } },
    });
    queensChannel.on('broadcast', { event: 'pos' }, (msg) => {
      const p = msg && msg.payload;
      if (!p || !p.pubkey || p.pubkey === S.selfPubkey) return;
      updateGhost(p);
    });
    queensChannel.subscribe((status) => {
      queensJoined = (status === 'SUBSCRIBED');
    });
    return queensChannel;
  }

  S.setSelf = function (pubkey) {
    S.selfPubkey = pubkey || null;
    // Removing my own ghost if it accidentally got rendered
    if (pubkey && ghosts.has(pubkey)) removeGhost(pubkey);
  };

  // Throttled broadcast. Call every frame; module decides when to send.
  S.broadcastQueen = function (payload) {
    if (!S.ready) return;
    const ch = ensureQueensChannel();
    if (!ch) return;
    // Until the channel has actually joined, `send()` falls back to a REST
    // POST and Supabase logs a deprecation warning every call. Skip sending
    // until we're subscribed over the websocket.
    if (!queensJoined) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastQueenSendAt < QUEEN_MIN_MS) return;
    // Cheap delta-skip: don't re-send if position barely changed.
    if (lastQueenPayload &&
        Math.abs(lastQueenPayload.x - payload.x) < 0.05 &&
        Math.abs(lastQueenPayload.z - payload.z) < 0.05 &&
        Math.abs(lastQueenPayload.facing - payload.facing) < 0.05) {
      return;
    }
    lastQueenSendAt = now;
    lastQueenPayload = { x: payload.x, z: payload.z, facing: payload.facing };
    try {
      ch.send({ type: 'broadcast', event: 'pos', payload });
    } catch (err) {
      // Channel not subscribed yet — retry next tick
    }
  };

  // -----------------------------------------------------------------
  // GHOST QUEENS — remote player rendering
  // -----------------------------------------------------------------
  S.attachScene = function (scene, THREE) {
    scene3D = scene;
    _THREE = THREE || window.THREE;
  };

  function buildGhostMesh(accent) {
    if (!_THREE) _THREE = window.THREE;
    if (!_THREE) return null;
    // Reuse the real queen mesh template if exposed, otherwise fall back
    // to a tagged sphere so the player is still visible.
    if (DN.queen && typeof DN.queen.buildMesh === 'function') {
      const g = DN.queen.buildMesh(accent);
      if (g) g.scale.set(0.22, 0.22, 0.22);
      return g;
    }
    const geo = new _THREE.SphereGeometry(0.5, 12, 10);
    const mat = new _THREE.MeshStandardMaterial({ color: accent || 0xE8C24A, emissive: 0x221100, roughness: 0.55 });
    return new _THREE.Mesh(geo, mat);
  }

  function groundAt(x, z) {
    if (DN.world && typeof DN.world.heightAt === 'function') return DN.world.heightAt(x, z);
    return 0;
  }

  function updateGhost(p) {
    if (!scene3D || !_THREE) return;
    let g = ghosts.get(p.pubkey);
    if (!g) {
      const mesh = buildGhostMesh(p.accent || 0xE8C24A);
      if (!mesh) return;
      mesh.position.set(p.x, groundAt(p.x, p.z), p.z);
      mesh.rotation.y = p.facing || 0;
      scene3D.add(mesh);
      g = { group: mesh, accent: p.accent, target: { x: p.x, z: p.z }, facing: p.facing || 0, lastSeen: Date.now() };
      ghosts.set(p.pubkey, g);
    } else {
      g.target.x = p.x;
      g.target.z = p.z;
      g.facing = p.facing || g.facing;
      g.lastSeen = Date.now();
    }
  }

  function removeGhost(pubkey) {
    const g = ghosts.get(pubkey);
    if (!g) return;
    if (scene3D && g.group) scene3D.remove(g.group);
    ghosts.delete(pubkey);
  }

  // Called every frame from the main animation loop. Lerps each ghost
  // toward its latest broadcast target so motion looks smooth even though
  // packets arrive at ~3 Hz. Also evicts stale ghosts.
  S.tick = function (dt) {
    if (!ghosts.size) return;
    const now = Date.now();
    const k = Math.min(1, dt * 6); // ~150ms catch-up at 60fps
    for (const [pubkey, g] of ghosts) {
      if (now - g.lastSeen > GHOST_TTL_MS) { removeGhost(pubkey); continue; }
      if (!g.group) continue;
      const px = g.group.position.x;
      const pz = g.group.position.z;
      const nx = px + (g.target.x - px) * k;
      const nz = pz + (g.target.z - pz) * k;
      g.group.position.set(nx, groundAt(nx, nz), nz);
      // shortest-angle rotation toward facing
      let curR = g.group.rotation.y;
      let dR = g.facing - curR;
      while (dR > Math.PI) dR -= Math.PI * 2;
      while (dR < -Math.PI) dR += Math.PI * 2;
      g.group.rotation.y = curR + dR * k;
    }
  };

  S.ghostCount = function () { return ghosts.size; };

  // Auto-init (idempotent). Safe to call before DOM is ready — it will
  // self-retry until the supabase-js global lands.
  S.init();
  return S;
})();
