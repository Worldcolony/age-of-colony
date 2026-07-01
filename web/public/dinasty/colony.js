// WorldColony — surface colonies: voxel mounds + tunnel entrances, faction identity, stats
window.DN = window.DN || {};

DN.colony = (function () {
  const C = { list: [] };
  let scene, group;
  const P = DN.palette;
  function ground(x, z) { return DN.world.heightAt(x, z); }

  // Seven colonies spread evenly around the play area so the player
  // always sees a few from any orbit angle. Distances vary so they don't
  // form a perfect circle.
  const DEFS = [
    { angle: -0.6, dist: 76 },
    { angle: 0.7,  dist: 118 },
    { angle: 1.8,  dist: 92 },
    { angle: 2.9,  dist: 130 },
    { angle: 3.9,  dist: 84 },
    { angle: 4.9,  dist: 120 },
    { angle: 5.9,  dist: 96 }
  ];

  // Smooth low-poly ant-hill. The body is a single revolved profile (LatheGeometry)
  // so it gets one clean convex silhouette with an upturned crater rim sculpted in —
  // no terraced seams — and is shaded with a height-based dirt gradient (the trick
  // flora.js uses on trees). Returns a vertex-colored BufferGeometry that
  // DN.util.voxelMat (vertexColors + flatShading) renders directly.
  function buildMound(accent, seed) {
    const rng = (function (a) { return function () { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(seed);
    const soil = new THREE.Color(P.dirt), soilDark = new THREE.Color(P.dirtDark);
    const soilLight = new THREE.Color(0x9C7A45), hole = new THREE.Color(0x231708);
    const greens = [0x5A7A2E, 0x6B8A37, 0x46602A];
    const SEG = 16;                 // radial facets — low-poly but smooth-reading
    const tc = new THREE.Color();   // scratch color reused by gradient fns

    const T = function (x, y, z, sx, sy, sz, ry) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, 0));
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy == null ? sx : sy, sz == null ? sx : sz));
      return m;
    };
    const parts = [];
    // color may be a hex/THREE.Color (flat) or a fn(y, r) -> THREE.Color (per-vertex)
    const add = function (geo, matrix, color) { parts.push({ geo: geo, matrix: matrix, color: color }); };
    const j = function (s) { return 1 + (rng() - 0.5) * s; };
    const V2 = function (x, y) { return new THREE.Vector2(x, y); };

    // --- mound body: one revolved convex profile, base -> dome -> upturned crater rim ---
    const H = 6.2 * j(0.08);        // peak height (rim crest), slight per-colony variance
    const W = 7.7 * j(0.05);        // base radius
    const bodyPts = [
      V2(W,        0.00 * H),
      V2(W * 0.94, 0.11 * H),
      V2(W * 0.82, 0.27 * H),
      V2(W * 0.68, 0.45 * H),
      V2(W * 0.54, 0.62 * H),
      V2(W * 0.42, 0.77 * H),
      V2(W * 0.35, 0.89 * H),
      V2(W * 0.37, 0.965 * H),      // rim flares slightly outward -> raised lip
      V2(W * 0.32, 1.00 * H)        // rim crest
    ];
    const bodyCol = function (y) {
      const t = Math.max(0, Math.min(1, y / H));
      if (t < 0.55) tc.copy(soilDark).lerp(soil, t / 0.55);
      else tc.copy(soil).lerp(soilLight, (t - 0.55) / 0.45);
      return tc;
    };
    add(new THREE.LatheGeometry(bodyPts, SEG), T(0, 0, 0, 1, 1, 1, rng() * 6.28), bodyCol);

    // --- summit entrance: a wide, deep shaft sunk into the crest. THIS is the
    //     colony's only entrance — ants climb the mound and drop in from the top. ---
    const rimY = H, rimR = W * 0.34;
    const craterPts = [
      V2(rimR,        rimY),
      V2(rimR * 0.82, rimY - 0.55),
      V2(rimR * 0.60, rimY - 1.30),
      V2(rimR * 0.42, rimY - 2.10),
      V2(rimR * 0.30, rimY - 2.80),
      V2(0.05,        rimY - 3.05)
    ];
    const craterCol = function (y) {
      const t = Math.max(0, Math.min(1, (rimY - y) / 3.05));
      return tc.copy(soilDark).lerp(hole, Math.min(1, t * 1.5));   // fades to near-black down the shaft
    };
    add(new THREE.LatheGeometry(craterPts, SEG), T(0, 0, 0, 1, 1, 1), craterCol);

    // surface radius of the body at a given height (lets props sit on the slope)
    const surfaceR = function (yy) {
      const p = bodyPts;
      if (yy <= p[0].y) return p[0].x;
      for (let k = 1; k < p.length; k++) {
        if (yy <= p[k].y) { const f = (yy - p[k - 1].y) / (p[k].y - p[k - 1].y); return p[k - 1].x + (p[k].x - p[k - 1].x) * f; }
      }
      return p[p.length - 1].x;
    };

    // --- a worn switchback path of trodden steps spiralling up to the summit hole ---
    const steps = 9;
    const baseAng = rng() * 6.28;
    for (let i = 0; i < steps; i++) {
      const f = i / (steps - 1);
      const yy = 0.35 + f * (H - 1.0);
      const ang = baseAng + f * Math.PI * 1.5 + (rng() - 0.5) * 0.2;  // winds ~3/4 turn around
      const rr = surfaceR(yy) + 0.12;
      const sw = 1.0 - 0.45 * f;                 // steps narrow as they climb
      add(new THREE.CylinderGeometry(sw * 0.7, sw * 0.8, 0.32, 6), T(Math.cos(ang) * rr, yy, Math.sin(ang) * rr, 1, 1, 1, rng() * 6.28), soilDark);
    }

    // --- excavated pebbles ringing the base (low-poly rocks, like flora's rock clusters) ---
    const peb = 9;
    for (let i = 0; i < peb; i++) {
      const a = (i / peb) * 6.2832 + rng() * 0.7;
      const rr = W * 0.92 + rng() * 2.0;
      const s = 0.45 + rng() * 0.9;
      const geo = (i % 2) ? new THREE.DodecahedronGeometry(s, 0) : new THREE.IcosahedronGeometry(s, 0);
      add(geo, T(Math.cos(a) * rr, s * 0.4, Math.sin(a) * rr, 1, 0.7, 1, rng() * 6.28), rng() < 0.5 ? soilDark : soil);
    }

    // --- a few grass tufts for a touch of life around the dug earth ---
    for (let i = 0; i < 6; i++) {
      const a = rng() * 6.2832;
      const rr = W * 0.96 + rng() * 1.8;
      add(new THREE.ConeGeometry(0.32, 1.0 + rng() * 0.8, 5), T(Math.cos(a) * rr, 0.55, Math.sin(a) * rr, 1, 1, 1, rng() * 6.28), greens[(rng() * greens.length) | 0]);
    }

    // merge everything into one flat-shaded, vertex-colored geometry
    const pos = [], norm = [], col = [], nm = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color();
    parts.forEach(function (p) {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      const pa = g.attributes.position, na = g.attributes.normal;
      nm.getNormalMatrix(p.matrix);
      const fn = typeof p.color === 'function';
      if (!fn) c.set(p.color);
      for (let i = 0; i < pa.count; i++) {
        v.fromBufferAttribute(pa, i);                 // local position (for gradient eval)
        if (fn) c.copy(p.color(v.y, Math.hypot(v.x, v.z)));
        v.applyMatrix4(p.matrix);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        pos.push(v.x, v.y, v.z); norm.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b);
      }
      if (g !== p.geo) g.dispose();
      p.geo.dispose();
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3));
    out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    // craterR = opening radius at the rim; shaftDepth = how far the hole sinks below the crest.
    // Both feed the ant-lift in ants.js so ants ride up the mound and drop into the top hole.
    out.userData = { peakH: H, baseR: W, craterR: rimR, shaftDepth: 3.05 };
    return out;
  }

  function addMoundDetails(colGroup, moundGeo, accent, seed) {
    const rng = (function (a) { return function () { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(seed || 1);
    const detail = new THREE.Group();
    detail.name = 'colony-mound-detail';
    const H = moundGeo.userData.peakH, R = moundGeo.userData.baseR, craterR = moundGeo.userData.craterR;

    const shadowGeo = new THREE.RingGeometry(craterR * 0.54, craterR * 1.18, 36);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({
      color: 0x070402, transparent: true, opacity: 0.50, side: THREE.DoubleSide, depthWrite: false
    }));
    shadow.position.y = H - 0.62;
    detail.add(shadow);

    const moistureGeo = new THREE.RingGeometry(R * 0.50, R * 0.92, 44);
    moistureGeo.rotateX(-Math.PI / 2);
    const moisture = new THREE.Mesh(moistureGeo, new THREE.MeshBasicMaterial({
      color: 0x2f2412, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false
    }));
    moisture.position.y = 0.08;
    detail.add(moisture);

    const rootMat = new THREE.MeshStandardMaterial({ color: P.dirtDark, roughness: 0.96, metalness: 0.0, flatShading: true });
    const rootGeo = new THREE.BoxGeometry(1, 1, 1);
    const roots = new THREE.InstancedMesh(rootGeo, rootMat, 18);
    roots.name = 'colony-root-strands';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + (rng() - 0.5) * 0.28;
      const len = 2.0 + rng() * 4.6;
      const rr = R * (0.58 + rng() * 0.38);
      pv.set(Math.cos(a) * (rr + len * 0.45), 0.18 + rng() * 0.35, Math.sin(a) * (rr + len * 0.45));
      e.set((rng() - 0.5) * 0.16, -a + Math.PI / 2, (rng() - 0.5) * 0.16);
      q.setFromEuler(e);
      sv.set(len, 0.09 + rng() * 0.05, 0.08 + rng() * 0.05);
      m.compose(pv, q, sv);
      roots.setMatrixAt(i, m);
    }
    roots.instanceMatrix.needsUpdate = true;
    detail.add(roots);

    const ember = new THREE.Sprite(new THREE.SpriteMaterial({
      map: DN.util.softSprite(), color: accent, transparent: true, opacity: 0.32,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    ember.name = 'colony-shaft-inner-glow';
    ember.position.set(0, H - 1.1, 0);
    ember.scale.set(4.2, 4.2, 1);
    detail.add(ember);

    colGroup.add(detail);
    return detail;
  }

  // Build a single colony at (angle, dist) and register it. Returns the
  // colony object (already pushed onto C.list). Pulled out of C.init so
  // founding new colonies post-startup can reuse this codepath.
  C._buildOne = function (angle, dist, idx, accent, name) {
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const cy = ground(cx, cz);
    const g = new THREE.Group();
    g.position.set(cx, cy, cz);
    g.rotation.y = angle + Math.PI;
    const yaw = g.rotation.y;

    const moundGeo = buildMound(accent, 50 + idx);
    const moundMat = DN.util.voxelMat({ roughness: 1.0 });
    moundMat.side = THREE.DoubleSide;   // mound is a hollow shell — render both sides so the
                                        // open summit shaft reads as a real hole, not see-through
    const mound = new THREE.Mesh(moundGeo, moundMat);
    mound.castShadow = true; mound.receiveShadow = true;
    g.add(mound);

    // accent crystal marker — kept (founding/idle animations still drive it) but hidden:
    // the entrance is now the summit shaft, so no crystal beacon sits on top.
    const cb = new DN.util.VoxelBuilder();
    cb.box([0.9, 2.2, 0.9], [0, 0, 0], accent);
    cb.box([0.5, 1.0, 0.5], [0, 1.4, 0], accent);
    const markerMat = DN.util.voxelMat({ roughness: 0.3, emissive: new THREE.Color(accent), emissiveIntensity: 0.25 });
    markerMat.transparent = true;
    const marker = new THREE.Mesh(cb.geometry(), markerMat);
    marker.position.set(0, 7.4, 0);
    marker.visible = false;
    g.add(marker);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: DN.util.softSprite(), color: accent, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(7, 7, 1); glow.position.set(0, moundGeo.userData.peakH - 0.6, 0);  // light glowing up out of the summit shaft
    g.add(glow);

    // ground footprint ring (accent), grows when selected
    const ringGeo = new THREE.RingGeometry(9, 10.4, 56);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.y = 0.4;
    g.add(ring);

    const detailGroup = addMoundDetails(g, moundGeo, accent, 700 + idx);

    group.add(g);

    // entrance is the shaft at the summit — ants converge on the centre, climb the
    // mound surface (see ants.js surf()) and drop into the hole from the top.
    const entrance = new THREE.Vector3(cx, cy + moundGeo.userData.peakH - 0.5, cz);

    const pick = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    pick.position.set(cx, cy + 4, cz);
    scene.add(pick);

    const col = {
      id: 'col-' + idx, idx, name, accent,
      pos: new THREE.Vector3(cx, cy, cz),
      corePos: new THREE.Vector3(cx, cy + 7, cz),
      entrance,
      group: g, mound, marker, glow, ring, pickTarget: pick, _detailGroup: detailGroup,
      _mH: moundGeo.userData.peakH, _mR: moundGeo.userData.baseR,
      _mCr: moundGeo.userData.craterR, _mSd: moundGeo.userData.shaftDepth,
      directive: 'forage', selected: false, _t: Math.random() * 6,
      stats: {
        population: 180 + Math.round(Math.random() * 220),
        health: 70 + Math.round(Math.random() * 24),
        food: 45 + Math.round(Math.random() * 40),
        accuracy: 56 + Math.round(Math.random() * 32),
        staked: (180 + Math.random() * 900),
        rep: 50 + Math.round(Math.random() * 45),
        gen: 1
      }
    };
    pick.userData.colony = col;
    mound.userData.colony = col;
    C.list.push(col);
    return col;
  };

  C.init = function (sceneRef) {
    scene = sceneRef;
    group = new THREE.Group();
    scene.add(group);

    DEFS.forEach((def, idx) => {
      const accent = P.factions[idx];
      const name = P.factionNames[idx];
      C._buildOne(def.angle, def.dist, idx, accent, name);
    });

    // Auto-founding disabled for now — re-enable by uncommenting below.
    // scheduleNextFounding();

    return C;
  };

  function scheduleNextFounding() {
    setTimeout(() => {
      let col = null;
      try { col = C.foundColony({}); } catch (_) {}
      // Fly the camera over the new colony so the founding animation
      // happens centre-frame instead of off-screen somewhere.
      if (col && DN.camera && DN.camera.flyTo && DN.app && DN.app.view === 'surface') {
        // Higher + further so canopy trees in the foreground can't block
        // the rising mound mid-animation.
        DN.camera.flyTo(col.pos, 56, 44, 2.0);
      }
      scheduleNextFounding();
    }, 15000);
  }

  // ---- Founding a NEW colony with a cinematic animation. -------------
  // Mound rises from flat → tall, marker materialises with a glow burst,
  // a shockwave ring pulses outward, then the colony's foragers start
  // emerging. Pass {} to randomly place the founding in a clear spot.
  C.foundColony = function (opts) {
    opts = opts || {};
    const idx = C.list.length;
    if (idx >= 14) return null; // hard cap so the world doesn't fill forever
    const accent = opts.accent != null ? opts.accent : P.factions[idx % P.factions.length];
    const factionName = opts.name || (P.factionNames[idx % P.factionNames.length] + ' II');

    // pick a clear (angle, dist) — at least 60 units from existing colonies
    let angle = opts.angle, dist = opts.dist;
    if (angle != null && dist != null) {
      // caller-provided placement (e.g. user click): still enforce spacing.
      const tx = Math.cos(angle) * dist, tz = Math.sin(angle) * dist;
      for (const c of C.list) {
        if (Math.hypot(c.pos.x - tx, c.pos.z - tz) < 60) return null;
      }
    } else {
      for (let tries = 0; tries < 40; tries++) {
        const ta = Math.random() * Math.PI * 2;
        const td = 70 + Math.random() * 70;
        const tx = Math.cos(ta) * td, tz = Math.sin(ta) * td;
        let clear = true;
        for (const c of C.list) {
          if (Math.hypot(c.pos.x - tx, c.pos.z - tz) < 60) { clear = false; break; }
        }
        if (clear) { angle = ta; dist = td; break; }
      }
      if (angle == null) return null;
    }
    const col = C._buildOne(angle, dist, idx, accent, factionName);
    if (opts.owner) col.owner = opts.owner;

    if (DN.logTerm) DN.logTerm.push('FOUND', 'Colony "' + factionName + '" founded.');

    // Founder colony: the nearest existing colony whose workers will
    // migrate over to seed the new mound. Without this the new ants
    // would just spawn at the entrance, which feels static.
    let parent = null, pd = Infinity;
    for (const c of C.list) {
      if (c === col) continue;
      const d = c.pos.distanceTo(col.pos);
      if (d < pd) { pd = d; parent = c; }
    }
    col._parent = parent;

    // Clear surrounding trees + rocks + ground cover so the new mound
    // isn't buried in forest. Generous radius so the camera flight in
    // never lands a frame with a tree blocking the mound.
    if (DN.flora && DN.flora.clearAround) {
      DN.flora.clearAround(col.pos.x, col.pos.z, 48);
    }

    // Hide / pre-set everything for the animation.
    col.mound.scale.set(0.5, 0.001, 0.5);
    if (col._detailGroup) col._detailGroup.scale.set(0.5, 0.001, 0.5);
    col.marker.material.opacity = 0;
    col.marker.scale.setScalar(0.01);
    col.marker.material.emissiveIntensity = 0;
    col.glow.material.opacity = 0;
    col.ring.material.opacity = 0;

    // Shockwave ring (separate from the footprint ring so it animates
    // independently). Lives on the colony group and is removed when the
    // animation finishes.
    const swGeo = new THREE.RingGeometry(2, 2.4, 64);
    swGeo.rotateX(-Math.PI / 2);
    const sw = new THREE.Mesh(swGeo, new THREE.MeshBasicMaterial({
      color: accent, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    sw.position.y = 0.45;
    col.group.add(sw);

    // Dust burst — a temporary Points cloud puffing outward from the
    // mound centre. Particles fall back to ground over ~3s.
    const N = 40;
    const dustPos = new Float32Array(N * 3);
    const dustVel = [];
    for (let i = 0; i < N; i++) {
      dustPos[i * 3] = 0; dustPos[i * 3 + 1] = 1; dustPos[i * 3 + 2] = 0;
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 4;
      dustVel.push({ vx: Math.cos(a) * r, vy: 5 + Math.random() * 4, vz: Math.sin(a) * r, age: Math.random() * 0.4 });
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      size: 1.4, map: DN.util.softSprite(), color: 0xA8845A,
      transparent: true, opacity: 0.95, depthWrite: false
    }));
    dust.frustumCulled = false;
    col.group.add(dust);

    col._foundAnim = { t: 0, sw, dust, dustVel, antsSpawned: false };

    // Optional founder migration. Product-created wallet colonies use this
    // as persisted state first, so they can skip the visual ant swarm.
    if (opts.spawnAnts !== false && DN.ants && DN.ants.addColony) {
      DN.ants.addColony(col, parent);
      col._foundAnim.antsSpawned = true;
      if (DN.logTerm && parent) {
        DN.logTerm.push('MIGRATE', 'Founder column dispatched from ' + parent.name + ' → ' + factionName + '.');
      }
    }
    return col;
  };

  C.update = function (dt, elapsed) {
    C.list.forEach(c => {
      c._t += dt;

      // ---- founding animation ---------------------------------------
      if (c._foundAnim) {
        const an = c._foundAnim;
        an.t += dt;
        const T = an.t;
        // Phase 0 (0–0.8s): site glow + dust puff
        // Phase 1 (0.8–3.8s): mound rises with eased growth
        // Phase 2 (3.8–5.0s): crystal materialises with marker glow burst
        // Phase 3 (5.0–6.5s): shockwave ring expands and fades
        // Done (6.5s+): finalise + spawn ants
        if (T < 0.8) {
          const p = T / 0.8;
          c.glow.material.opacity = p * 0.55;
        } else if (T < 3.8) {
          const p = (T - 0.8) / 3.0;
          const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
          c.mound.scale.y = 0.001 + e * 0.999;
          c.mound.scale.x = 0.5 + e * 0.5;
          c.mound.scale.z = 0.5 + e * 0.5;
          if (c._detailGroup) c._detailGroup.scale.copy(c.mound.scale);
          c.glow.material.opacity = 0.55 + Math.sin(T * 5) * 0.08;
        } else if (T < 5.0) {
          c.mound.scale.set(1, 1, 1);
          if (c._detailGroup) c._detailGroup.scale.set(1, 1, 1);
          const p = (T - 3.8) / 1.2;
          const e = Math.sin(p * Math.PI * 0.5); // ease-out sine
          c.marker.scale.setScalar(e);
          c.marker.material.opacity = e;
          c.marker.material.emissiveIntensity = 0.25 + (1 - p) * 1.2; // bright pop then settle
          c.glow.material.opacity = 0.55 + (1 - p) * 0.35;
        } else if (T < 6.5) {
          const p = (T - 5.0) / 1.5;
          // shockwave expands outward
          const s = 1 + p * 8;
          an.sw.scale.set(s, 1, s);
          an.sw.material.opacity = (1 - p) * 0.9;
          c.marker.material.emissiveIntensity = 0.25 + (1 - p) * 0.4;
        } else {
          // finalise
          c.mound.scale.set(1, 1, 1);
          if (c._detailGroup) c._detailGroup.scale.set(1, 1, 1);
          c.marker.scale.setScalar(1);
          c.marker.material.opacity = 1;
          c.marker.material.emissiveIntensity = 0.25;
          if (an.sw) { c.group.remove(an.sw); an.sw.geometry.dispose(); an.sw.material.dispose(); }
          if (an.dust) { c.group.remove(an.dust); an.dust.geometry.dispose(); an.dust.material.dispose(); }
          // ants already spawned at the start of founding (see foundColony)
          c._foundAnim = null;
        }
        // dust particle physics: outward + up, gravity pull, fade
        if (an.dust) {
          const arr = an.dust.geometry.attributes.position.array;
          for (let i = 0; i < an.dustVel.length; i++) {
            const v = an.dustVel[i];
            v.age = (v.age || 0) + dt;
            arr[i * 3] += v.vx * dt;
            arr[i * 3 + 1] += v.vy * dt;
            arr[i * 3 + 2] += v.vz * dt;
            v.vy -= 16 * dt; // gravity
            // slight drag
            v.vx *= 0.96; v.vz *= 0.96;
          }
          an.dust.geometry.attributes.position.needsUpdate = true;
          an.dust.material.opacity = Math.max(0, 0.95 * (1 - T / 3.5));
        }
        return; // skip normal pulses while founding
      }

      // ---- normal idle pulses ---------------------------------------
      c.glow.material.opacity = (c.selected ? 0.55 : 0.34) + Math.sin(c._t * 1.4) * 0.06;
      c.marker.material.emissiveIntensity = 0.25 + Math.sin(c._t * 2) * 0.12;
      if (c.selected) {
        c.ring.material.opacity = Math.min(0.55, c.ring.material.opacity + dt * 1.6);
        c.ring.rotation.y += dt * 0.4;
      } else c.ring.material.opacity = Math.max(0, c.ring.material.opacity - dt * 2);
    });
  };

  return C;
})();
