// WorldColony — underground colony: cinematic cutaway, 11 chambers, tunnels, moving ants
window.DN = window.DN || {};

DN.underground = (function () {
  const U = { active: false, col: null };
  let scene, camera, controls, dom;
  const P = DN.palette;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

  // deterministic seeded PRNG so room decoration is stable across reloads
  function mulberryUG(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- geometry helpers ----------------------------------------------------
  function makeMatrix(x, y, z, sx, sy, sz, rx, ry, rz) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
    const sX = sx, sY = sy == null ? sx : sy, sZ = sz == null ? sx : sz;
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sX, sY, sZ));
    return m;
  }
  function mergeGeos(parts) {
    const pos = [], norm = [], col = [], nm = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color();
    parts.forEach(p => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      const pa = g.attributes.position, na = g.attributes.normal;
      nm.getNormalMatrix(p.matrix); c.set(p.color);
      for (let i = 0; i < pa.count; i++) {
        v.fromBufferAttribute(pa, i).applyMatrix4(p.matrix);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        pos.push(v.x, v.y, v.z); norm.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b);
      }
      if (g !== p.geo) g.dispose();
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3));
    out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    return out;
  }

  // ---- procedural ant model: head + thorax + abdomen, 6 angled legs, 2
  // antennae. Geometry is shared across all 60 instances of the InstancedMesh
  // so this only costs ~600 verts total. ---------------------------------
  function makeAntGeo(scale) {
    const s = scale || 1.0;
    const body = P.ant, dark = P.antDark;
    const parts = [];
    // abdomen — large rear ovoid
    parts.push({ geo: new THREE.SphereGeometry(0.36 * s, 10, 8), matrix: makeMatrix(0, 0.32 * s, -0.62 * s, 1, 0.85, 1.55), color: dark });
    // thorax — mid segment
    parts.push({ geo: new THREE.SphereGeometry(0.27 * s, 10, 8), matrix: makeMatrix(0, 0.34 * s, -0.05 * s, 1, 0.9, 1.05), color: body });
    // head — front round, slightly smaller
    parts.push({ geo: new THREE.SphereGeometry(0.24 * s, 10, 8), matrix: makeMatrix(0, 0.34 * s, 0.44 * s, 1, 0.95, 1.0), color: dark });
    // mandibles — two small forward stubs
    parts.push({ geo: new THREE.ConeGeometry(0.05 * s, 0.18 * s, 5), matrix: makeMatrix(-0.08 * s, 0.34 * s, 0.66 * s, 1, 1, 1, Math.PI / 2, 0, 0.4), color: body });
    parts.push({ geo: new THREE.ConeGeometry(0.05 * s, 0.18 * s, 5), matrix: makeMatrix(0.08 * s, 0.34 * s, 0.66 * s, 1, 1, 1, Math.PI / 2, 0, -0.4), color: body });
    // legs — three pairs, angled outward at the thorax. Cylinders are
    // rotated about Z so they fan out laterally; raised slightly so the
    // upper segment reads as the femur.
    const legL = 0.46 * s;
    const legR = 0.045 * s;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const z = (-0.18 + i * 0.18) * s;
        // cylinder default is along Y — rotate about Z to angle outward
        const ang = side * (0.85 + (i === 1 ? 0.15 : 0));
        parts.push({
          geo: new THREE.CylinderGeometry(legR * 0.7, legR, legL, 5),
          matrix: makeMatrix(side * 0.18 * s, 0.18 * s, z, 1, 1, 1, 0, 0, ang),
          color: dark
        });
      }
    }
    // antennae — thin forward+up curving cylinders from head
    parts.push({ geo: new THREE.CylinderGeometry(0.025 * s, 0.035 * s, 0.6 * s, 4), matrix: makeMatrix(-0.10 * s, 0.55 * s, 0.62 * s, 1, 1, 1, 0.7, 0, -0.4), color: dark });
    parts.push({ geo: new THREE.CylinderGeometry(0.025 * s, 0.035 * s, 0.6 * s, 4), matrix: makeMatrix(0.10 * s, 0.55 * s, 0.62 * s, 1, 1, 1, 0.7, 0, 0.4), color: dark });
    const g = mergeGeos(parts); parts.forEach(p => p.geo.dispose());
    g.computeBoundingSphere();
    return g;
  }

  // Five debate chambers arranged in a pentagon ring around a hidden centre
  // at (0, -25). All rooms use the 'debate' prop because the backend's
  // models.py only defines a DebateRoom — everything else was frontend
  // decoration. Layout: α at top, β/γ on the right (clockwise), δ/ε on
  // the left. Radius 15 from centre, chamber radius 6.5.
  const ROOMS = [
    { id: 'room-a', name: 'Chamber α', x:   0.0, y: -10.0, r: 6.5, prop: 'debate' },
    { id: 'room-b', name: 'Chamber β', x:  14.3, y: -20.4, r: 6.5, prop: 'debate' },
    { id: 'room-c', name: 'Chamber γ', x:   8.8, y: -37.1, r: 6.5, prop: 'debate' },
    { id: 'room-d', name: 'Chamber δ', x:  -8.8, y: -37.1, r: 6.5, prop: 'debate' },
    { id: 'room-e', name: 'Chamber ε', x: -14.3, y: -20.4, r: 6.5, prop: 'debate' }
  ];
  // Hub-and-spoke from the surface entrance into the top chamber, then a
  // closed ring connecting all five chambers so agents can walk any pair.
  const TUNNELS = [
    ['ent',    'room-a'],
    ['room-a', 'room-b'],
    ['room-b', 'room-c'],
    ['room-c', 'room-d'],
    ['room-d', 'room-e'],
    ['room-e', 'room-a']
  ];
  const ENT = { id: 'ent', x: 0, y: 2 };
  function node(id) { return id === 'ent' ? ENT : ROOMS.find(r => r.id === id); }

  function labelSprite(text, accent) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(20,13,7,0.82)';
    roundRect(ctx, 6, 14, 244, 36, 18); ctx.fill();
    ctx.fillStyle = '#' + accent.toString(16).padStart(6, '0');
    ctx.beginPath(); ctx.arc(28, 32, 6, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#F4ECE0'; ctx.font = '600 22px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle'; ctx.fillText(text, 46, 33);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(11, 2.75, 1);
    return sp;
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function buildProp(kind, accent) {
    const b = new DN.util.VoxelBuilder();
    const acc = accent, gold = 0xE8C24A, white = 0xEDE3D2, dark = P.antDark;
    if (kind === 'queen') {
      b.box([2.2, 1.6, 3.2], [0, 0.8, -0.5], P.ant);
      b.box([1.4, 1.2, 1.4], [0, 1.0, 1.4], dark);
      b.box([1.6, 0.5, 0.4], [0, 2.0, 1.4], gold); // crown
      b.box([0.3, 0.7, 0.3], [-0.5, 2.4, 1.4], gold); b.box([0.3, 0.7, 0.3], [0.5, 2.4, 1.4], gold);
    } else if (kind === 'eggs') {
      for (let i = 0; i < 5; i++) b.box([0.8, 1.1, 0.8], [(i - 2) * 1.0, 0.6, (i % 2) * 0.8], white);
    } else if (kind === 'forecast') {
      for (let i = 0; i < 5; i++) b.box([0.7, 0.6 + i * 0.5, 0.7], [(i - 2) * 0.9, (0.6 + i * 0.5) / 2, 0], i % 2 ? acc : 0x66C6E0);
    } else if (kind === 'debate') {
      b.box([1, 0.9, 1.6], [-1.4, 0.5, 0], P.ant); b.box([1, 0.9, 1.6], [1.4, 0.5, 0], P.ant);
      b.box([0.7, 0.7, 0.2], [0, 1.6, 0], acc);
    } else if (kind === 'storage') {
      for (let i = 0; i < 4; i++) { const a = i / 4 * 6.28; b.box([0.9, 1.6, 0.9], [Math.cos(a) * 1.2, 0.8, Math.sin(a) * 1.2], 0x66C6E0); }
    } else if (kind === 'coins') {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) b.box([1.3, 0.4, 1.3], [(j - (2 - i) / 2) * 1.5, 0.2 + i * 0.42, 0], gold);
    } else if (kind === 'archive') {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b.box([1.0, 1.0, 0.9], [(i - 1) * 1.2, 0.5 + j * 1.1, 0], j % 2 ? white : acc);
    } else if (kind === 'beds') {
      for (let i = 0; i < 3; i++) b.box([1.6, 0.4, 0.9], [(i - 1) * 2.0, 0.2, 0], white);
    } else if (kind === 'exchange') {
      b.box([1.0, 1.4, 1.0], [-1.5, 0.7, 0], acc); b.box([1.0, 1.4, 1.0], [1.5, 0.7, 0], 0x66C6E0);
      b.box([2.2, 0.2, 0.2], [0, 1.0, 0], gold);
    } else if (kind === 'lineage') {
      b.box([0.5, 2.4, 0.5], [0, 1.2, 0], P.trunk);
      for (let i = 0; i < 4; i++) { const a = i / 4 * 6.28; b.box([0.7, 0.7, 0.7], [Math.cos(a) * 1.8, 2.2 + Math.sin(a), Math.sin(a) * 0.5], acc); }
    } else if (kind === 'stake') {
      b.box([2.4, 2.0, 2.0], [0, 1.0, 0], 0x2E7D6B);
      b.box([1.2, 1.2, 0.3], [0, 1.0, 1.1], gold); // USDC face
    }
    return b.geometry();
  }

  U.init = function () {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1c1208);
    scene.fog = new THREE.Fog(0x1c1208, 50, 140);
    camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 600);
    dom = DN.world.renderer.domElement;

    // soil backdrop
    const wallMat = DN.util.voxelMat({ roughness: 1.0, flatShading: false });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(120, 90, 8), wallMat);
    const wpos = wall.geometry.attributes.position;
    const wcol = new Float32Array(wpos.count * 3);
    const cd = new THREE.Color(0x3a2614), cd2 = new THREE.Color(0x4a3018);
    const nz = new DNNoise(13);
    for (let i = 0; i < wpos.count; i++) {
      const t = nz.n2(wpos.getX(i) * 0.12, wpos.getY(i) * 0.12) * 0.5 + 0.5;
      const c = cd.clone().lerp(cd2, t);
      wcol[i * 3] = c.r; wcol[i * 3 + 1] = c.g; wcol[i * 3 + 2] = c.b;
    }
    wall.geometry.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
    wall.position.set(0, -22, -5);
    wall.receiveShadow = true;
    scene.add(wall);

    scene.add(new THREE.AmbientLight(0x6b4a2a, 0.7));
    const key = new THREE.DirectionalLight(0xFFE3B0, 0.8);
    key.position.set(20, 30, 40); scene.add(key);
    // shaft light from the surface
    const shaft = new THREE.SpotLight(0xFFF0CE, 1.4, 80, 0.7, 0.6);
    shaft.position.set(0, 18, 12); shaft.target.position.set(0, -12, 0);
    scene.add(shaft); scene.add(shaft.target);

    // tunnels (dark rounded tubes + visible glowing centerline so the
    // colony reads as a network the eye can trace)
    U._tunnelGlows = [];
    TUNNELS.forEach(t => {
      const a = node(t[0]), b = node(t[1]);
      const ax = new THREE.Vector3(a.x, a.y, 0), bx = new THREE.Vector3(b.x, b.y, 0);
      const len = ax.distanceTo(bx);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, len, 10), new THREE.MeshStandardMaterial({ color: 0x180f06, roughness: 1 }));
      tube.position.copy(ax).lerp(bx, 0.5); tube.position.z = -0.5;
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bx.clone().sub(ax).normalize());
      scene.add(tube);
      // Thin glowing path line down the middle of each tunnel — recolored
      // to the colony accent on enter so the route reads at a glance.
      const pts = [];
      const N = 12;
      for (let i = 0; i <= N; i++) {
        const k = i / N;
        const px = ax.x + (bx.x - ax.x) * k;
        const py = ax.y + (bx.y - ax.y) * k;
        // sag slightly toward middle for an organic dip
        const sag = Math.sin(k * Math.PI) * 0.4;
        pts.push(new THREE.Vector3(px, py - sag, 0.55));
      }
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      const lm = new THREE.LineBasicMaterial({ color: 0xE3A53C, transparent: true, opacity: 0.5 });
      const line = new THREE.Line(lg, lm);
      scene.add(line);
      U._tunnelGlows.push(lm);
    });

    // chambers — natural carved cavities, not perfect circles.
    // Each chamber gets:
    //  · an inner cavity ShapeGeometry whose perimeter is noise-displaced
    //    around the room's nominal radius (organic clay edge)
    //  · a darker outer rim ShapeGeometry traced from a slightly larger
    //    noisy curve (the "wall thickness")
    //  · a stone pebble cluster on the floor
    //  · a few hanging roots descending from the cavity ceiling
    U.rooms = {};
    const wallNoise = new DNNoise(57);
    ROOMS.forEach(r => {
      const accent = 0xE3A53C;
      const g = new THREE.Group(); g.position.set(r.x, r.y, 0);

      // build a noisy closed perimeter — same seed per room so it's stable
      const seg = 32;
      const innerPts = []; const outerPts = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const cx = Math.cos(a), cy = Math.sin(a);
        // domain-warped noise around the perimeter
        const n = wallNoise.n2(cx * 1.7 + r.x * 0.13, cy * 1.7 + r.y * 0.13);
        const rIn = r.r * (1 + n * 0.10) + 0.25 * Math.sin(a * 3 + r.x);
        const rOut = rIn + 0.9 + wallNoise.n2(cx * 4 + 11, cy * 4 - 7) * 0.5;
        innerPts.push(new THREE.Vector2(cx * rIn, cy * rIn));
        outerPts.push(new THREE.Vector2(cx * rOut, cy * rOut));
      }
      // inner cavity (warm lit clay)
      const innerShape = new THREE.Shape(innerPts);
      const innerGeo = new THREE.ShapeGeometry(innerShape, 6);
      const innerMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1 });
      const inner = new THREE.Mesh(innerGeo, innerMat);
      inner.position.z = 0.2;
      g.add(inner);

      // outer wall ring — darker, gives depth between cavity and surrounding soil
      const ringShape = new THREE.Shape(outerPts);
      ringShape.holes.push(new THREE.Path(innerPts));
      const ringGeo = new THREE.ShapeGeometry(ringShape, 6);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 1 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.z = 0.15;
      g.add(ring);

      // floor ledge — wider organic slab below the cavity center
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(r.r * 1.8, 0.5, 2),
        new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 1 })
      );
      floor.position.set(0, -r.r * 0.78, 0.55);
      g.add(floor);

      // 4-7 floor pebbles for grit detail
      const pebRng = mulberryUG(r.x * 1000 + r.y);
      const pebN = 4 + Math.floor(pebRng() * 4);
      for (let i = 0; i < pebN; i++) {
        const peb = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.18 + pebRng() * 0.22, 0),
          new THREE.MeshStandardMaterial({ color: 0x6a5a44, flatShading: true, roughness: 1 })
        );
        peb.position.set((pebRng() - 0.5) * r.r * 1.2, -r.r * 0.55 + (pebRng() - 0.5) * 0.4, 0.7);
        g.add(peb);
      }

      // a few hanging roots at the cavity ceiling
      const rootN = 2 + Math.floor(pebRng() * 3);
      for (let i = 0; i < rootN; i++) {
        const len = 1.2 + pebRng() * 2.0;
        const root = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.10, len, 5),
          new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 1 })
        );
        root.position.set((pebRng() - 0.5) * r.r * 1.3, r.r * 0.6 - len * 0.5, 0.5);
        root.rotation.z = (pebRng() - 0.5) * 0.4;
        g.add(root);
      }

      U.roomAccent = U.roomAccent || {};
      r._accent = accent;
      g._roomDef = r;
      scene.add(g);
      U.rooms[r.id] = g;
    });

    // build agents
    buildAgents();

    // ambient floating spores
    const sn = 120, sp = new Float32Array(sn * 3);
    for (let i = 0; i < sn; i++) { sp[i * 3] = (Math.random() - .5) * 90; sp[i * 3 + 1] = -Math.random() * 50; sp[i * 3 + 2] = (Math.random() - .5) * 10; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    U.spores = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.5, map: DN.util.softSprite(), color: 0xFFD98A, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
    U.spores.frustumCulled = false; scene.add(U.spores); U._sporeBase = sp.slice();

    U.scene = scene; U.camera = camera;
    return U;
  };

  function flat(geo, hex) {
    const c = new THREE.Color(hex), arr = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < geo.attributes.position.count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    return new THREE.BufferAttribute(arr, 3);
  }

  let agents, agentMesh, propGroups = [];
  // Adjacency built from TUNNELS so agents traverse the actual graph
  // instead of teleporting between arbitrary rooms.
  let ADJ = null, TUNNEL_CURVES = null;
  function buildGraph() {
    ADJ = {}; TUNNEL_CURVES = {};
    const allIds = ROOMS.map(r => r.id).concat(['ent']);
    allIds.forEach(id => { ADJ[id] = []; });
    TUNNELS.forEach(([a, b]) => {
      ADJ[a].push(b); ADJ[b].push(a);
      const na = node(a), nb = node(b);
      const start = new THREE.Vector3(na.x, na.y, 0.6);
      const end = new THREE.Vector3(nb.x, nb.y, 0.6);
      // Slight downward sag and lateral offset so the curve hugs the tunnel
      // tube and reads as a real path, not a straight line crossing rooms.
      const mid = start.clone().add(end).multiplyScalar(0.5);
      mid.y -= 1.2;
      const dir = end.clone().sub(start);
      const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
      mid.addScaledVector(perp, 0.6 * Math.sign(start.x + end.x || 1));
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      TUNNEL_CURVES[a + '->' + b] = { curve, from: na, to: nb };
      TUNNEL_CURVES[b + '->' + a] = { curve, from: nb, to: na, reversed: true };
    });
  }
  function tunnelFor(fromId, toId) { return TUNNEL_CURVES[fromId + '->' + toId] || null; }
  function pickNeighbor(fromId, avoid) {
    const ns = (ADJ[fromId] || []).filter(n => n !== 'ent'); // never walk above ground
    const opts = avoid ? ns.filter(n => n !== avoid) : ns;
    const list = opts.length ? opts : ns;
    return list[Math.floor(Math.random() * list.length)] || fromId;
  }
  // ---- A* on the chamber graph ----------------------------------------
  // Edge weight = euclidean distance between rooms. Heuristic = straight-
  // line distance to goal. 'ent' is excluded (above-ground).
  function pathfind(startId, goalId) {
    if (!ADJ || startId === goalId) return [];
    const open = new Set([startId]);
    const came = {};
    const g = { [startId]: 0 };
    const h = (id) => {
      const a = node(id), b = node(goalId);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const f = { [startId]: h(startId) };
    while (open.size) {
      // pick the open node with the smallest f
      let cur = null, bestF = Infinity;
      for (const id of open) if ((f[id] ?? Infinity) < bestF) { bestF = f[id]; cur = id; }
      if (cur === null) break;
      if (cur === goalId) {
        // reconstruct
        const path = [];
        let n = cur;
        while (came[n]) { path.unshift(n); n = came[n]; }
        return path; // excludes startId, includes goalId
      }
      open.delete(cur);
      const neighbors = (ADJ[cur] || []).filter(n => n !== 'ent');
      for (const nb of neighbors) {
        const a = node(cur), b = node(nb);
        const w = Math.hypot(a.x - b.x, a.y - b.y);
        const tentative = (g[cur] ?? Infinity) + w;
        if (tentative < (g[nb] ?? Infinity)) {
          came[nb] = cur; g[nb] = tentative; f[nb] = tentative + h(nb);
          open.add(nb);
        }
      }
    }
    return []; // unreachable
  }
  function pickGoal(fromId) {
    const candidates = ROOMS.filter(r => r.id !== fromId);
    return candidates[Math.floor(Math.random() * candidates.length)].id;
  }

  function buildAgents() {
    buildGraph();
    // ---- reuse surface ant geo + material so underground ants look
    // identical to the well-formed surface foragers (proper segments,
    // animated legs via the shader, faction-stripe color). ---------------
    const accent = (U.col && U.col.accent) || 0xE3A53C;
    const geo = DN.ants.buildAntGeo(accent);
    const N = 60;
    U._antMat = DN.ants.antMaterial();
    agentMesh = new THREE.InstancedMesh(geo, U._antMat, N);
    agentMesh.frustumCulled = false;
    agentMesh.castShadow = false; agentMesh.receiveShadow = false;
    // per-instance leg-walk phase + gait rate (same encoding as surface)
    const inst = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { inst[i * 2] = Math.random() * 6.28; inst[i * 2 + 1] = 7 + Math.random() * 4; }
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 2));
    scene.add(agentMesh);

    // Queen + larvae props were tied to the deprecated Queen Chamber
    // and Nursery rooms. With the chamber set reduced to 5 debate rooms
    // they no longer have a home, so we skip them and let the chambers
    // speak for themselves. `U.queenMesh` / `U.larvae` stay undefined;
    // the update loop already null-checks them.
    U.larvae = [];

    // ---- pheromone flow: one Points cloud, N=14 particles per tunnel,
    // each particle slides along its assigned curve and wraps. Tinted to
    // the colony accent in U.enter. ------------------------------------
    const phPerTunnel = 14;
    const phN = TUNNELS.length * phPerTunnel;
    const phPos = new Float32Array(phN * 3);
    const phGeo = new THREE.BufferGeometry();
    phGeo.setAttribute('position', new THREE.BufferAttribute(phPos, 3));
    U._phPos = phGeo.attributes.position;
    U._phState = [];
    for (let ti = 0; ti < TUNNELS.length; ti++) {
      const [a, b] = TUNNELS[ti];
      const seg = tunnelFor(a, b);
      for (let i = 0; i < phPerTunnel; i++) {
        U._phState.push({
          curve: seg ? seg.curve : null,
          t: i / phPerTunnel,
          speed: 0.06 + Math.random() * 0.04
        });
      }
    }
    U.pheromones = new THREE.Points(phGeo, new THREE.PointsMaterial({
      size: 0.7, map: DN.util.softSprite(), color: 0xE3A53C,
      transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    U.pheromones.frustumCulled = false;
    scene.add(U.pheromones);

    // Glow billboards beneath each ant — instanced sprites would be ideal
    // but a single PointsMaterial sprite cloud is cheaper and reads as
    // bioluminescent agent trails from camera distance.
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    U._agentGlowPos = glowGeo.attributes.position;
    U.agentGlow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
      size: 1.6, map: DN.util.softSprite(), color: 0xFFD98A,
      transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    U.agentGlow.frustumCulled = false;
    scene.add(U.agentGlow);

    agents = [];
    U.agents = agents; // expose for HUD active-ant counts
    // workers spawn in any room except Queen (Queen is reserved for queen
    // pinned agent) and Nursery (reserved for larvae cluster)
    const workerRooms = ROOMS;
    for (let i = 0; i < N; i++) {
      const room = workerRooms[Math.floor(Math.random() * workerRooms.length)];
      agents.push({
        roomId: room.id,
        // Always start milling so initial frame doesn't snap onto a curve.
        mode: 'mill',
        fromId: room.id, toId: pickNeighbor(room.id),
        // multi-hop plan: list of room ids to traverse (filled in by A*)
        plan: [],
        goalId: null,
        t: Math.random(),
        // smooth elliptical orbit inside the room — slowed down so chamber
        // activity reads as deliberate rather than frantic
        orbitR: room.r * (0.35 + Math.random() * 0.4),
        orbitW: (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.18),
        orbitPh: Math.random() * 6.28,
        orbitY: -room.r * 0.5 + Math.random() * room.r * 0.6,
        millLeft: 3 + Math.random() * 8,
        // dignified tunnel traversal: ~20-30 sec per curve
        speed: 0.032 + Math.random() * 0.018,
        bobPh: Math.random() * 6.28,
        // junction pause + antenna twitch state
        pauseLeft: 0,
        twitchPh: Math.random() * 6.28,
        // smoothed pose, initialized inside the room
        px: room.x, py: room.y - room.r * 0.4, pz: 0.9, rz: 0
      });
    }
  }

  U.enter = function (col) {
    U.active = true; U.col = col;
    // recolor accents to the colony
    ROOMS.forEach(r => { const g = U.rooms[r.id]; r._accent = col.accent; });
    // tunnel paths + agent glow now read in the colony's accent so the
    // network visually belongs to this colony.
    if (U._tunnelGlows) U._tunnelGlows.forEach(lm => lm.color.setHex(col.accent));
    if (U.agentGlow) U.agentGlow.material.color.setHex(col.accent);
    if (U.pheromones) U.pheromones.material.color.setHex(col.accent);
    if (U._debateMat) U._debateMat.color.setHex(col.accent);
    propGroups.forEach(p => scene.remove(p)); propGroups = [];
    ROOMS.forEach(r => {
      const g = U.rooms[r.id];
      // (re)build prop + light + label with colony accent
      if (g._extra) g._extra.forEach(o => g.remove(o));
      const extra = [];
      const prop = new THREE.Mesh(buildProp(r.prop, col.accent), DN.util.voxelMat({ roughness: 0.7 }));
      prop.position.set(0, -r.r * 0.4 + 0.6, 0.8); prop.scale.setScalar(0.85); g.add(prop); extra.push(prop);
      const pl = new THREE.PointLight(col.accent, 0.9, r.r * 4); pl.position.set(0, 0, 4); g.add(pl); extra.push(pl);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: DN.util.softSprite(), color: col.accent, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(r.r * 2.4, r.r * 2.4, 1); glow.position.z = 1; g.add(glow); extra.push(glow);
      const label = labelSprite(r.name, col.accent); label.position.set(0, r.r + 1.4, 2); g.add(label); extra.push(label);
      g._extra = extra;
    });
    // frame camera: dive from top
    camera.position.set(0, 14, 64);
    camera.lookAt(0, -22, 0);
    U._camTarget = new THREE.Vector3(0, -20, 0);
    U._camPos = new THREE.Vector3(2, -16, 58);
    U._camLook = new THREE.Vector3(0, -21, 0);
    U._diveT = 0;
    U._focusTween = null;
    U._focusRoomId = null;
  };

  U.exit = function () { U.active = false; };

  // ---- debate burst -----------------------------------------------------
  // Called by DN.lifecycle during the debate phase. Spawns a rapid stream
  // of brief glowing arcs between random pairs of agents in the same
  // chamber so the user visibly sees "agents arguing" for ~10 seconds.
  // The visuals are independent of backend events — they purely paint
  // chamber activity while the real LLM run is settling on Railway.
  const DEBATE_MAX_PARTICLES = 60;
  const DEBATE_PER_BURST = 6;
  let _debateOn = false;
  let _debateSpawnT = 0;
  let _debateLines = []; // { ax, ay, bx, by, ttl, age }
  function ensureDebateCloud() {
    if (U._debateCloud || !scene) return;
    const buf = new Float32Array(DEBATE_MAX_PARTICLES * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = -9999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
    U._debateMat = new THREE.PointsMaterial({
      size: 1.2, map: (DN.util && DN.util.softSprite) ? DN.util.softSprite() : null,
      color: 0xFFE39A, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    });
    U._debateCloud = new THREE.Points(g, U._debateMat);
    U._debateCloud.frustumCulled = false;
    U._debateCloud.visible = false;
    scene.add(U._debateCloud);
    U._debatePos = g.attributes.position;
  }
  // ---- chamber message bubbles -----------------------------------------
  // 5 HTML overlays that float above each debate chamber and stream the
  // latest debate_claim/social_action text from that chamber. Routed
  // from commsViz when a real backend event arrives during DEBATE phase.
  const ROOM_NAMES = ['Chamber α', 'Chamber β', 'Chamber γ', 'Chamber δ', 'Chamber ε'];
  function escapeHtmlUg(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function ensureBubbleStyle() {
    if (document.getElementById('chamber-bubble-css')) return;
    const css = `
      .chamber-bubble {
        position: fixed; left: 0; top: 0;
        max-width: 280px; min-width: 160px;
        padding: 8px 12px;
        background: rgba(12, 8, 4, 0.88);
        border: 1px solid rgba(196, 142, 68, 0.42);
        border-radius: 8px;
        color: rgba(241, 216, 168, 0.92);
        font-family: var(--mono, ui-monospace), monospace;
        font-size: 11px; line-height: 1.42;
        pointer-events: none; opacity: 0;
        transition: opacity .25s ease, transform .25s ease;
        backdrop-filter: blur(6px) saturate(1.05);
        -webkit-backdrop-filter: blur(6px) saturate(1.05);
        z-index: 6;
        box-shadow: 0 4px 14px -4px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,200,130,0.06);
        transform: translate(-50%, -110%);
        white-space: normal; word-break: break-word;
      }
      .chamber-bubble.live { opacity: 0.96; transform: translate(-50%, -100%); }
      .chamber-bubble .ch-head {
        font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase;
        color: rgba(241, 216, 168, 0.55); margin-bottom: 3px;
      }
      .chamber-bubble .ch-actor { color: #FFD988; font-weight: 700; }
      .chamber-bubble .ch-arrow { color: rgba(241, 216, 168, 0.5); margin: 0 4px; }
      .chamber-bubble .ch-target { color: #FF8B6B; font-weight: 700; }
    `;
    const el = document.createElement('style');
    el.id = 'chamber-bubble-css';
    el.textContent = css;
    document.head.appendChild(el);
  }
  function ensureBubbles() {
    if (U._bubbles) return;
    ensureBubbleStyle();
    U._bubbles = [];
    for (let i = 0; i < ROOMS.length; i++) {
      const div = document.createElement('div');
      div.className = 'chamber-bubble';
      document.body.appendChild(div);
      U._bubbles.push({ div, ttl: 0, idx: i });
    }
  }
  // Public: route a debate message to a chamber. The chamber index is
  // taken modulo 5 so any backend room_id hash lands somewhere.
  U.showChamberMessage = function (chamberIdx, actor, target, text) {
    if (!U.active) return; // only paint when underground is open
    ensureBubbles();
    const i = Math.abs(chamberIdx | 0) % U._bubbles.length;
    const b = U._bubbles[i];
    const snippet = (text || '').replace(/\s+/g, ' ').trim();
    const trimmed = snippet.length > 140 ? snippet.slice(0, 138) + '…' : snippet;
    const headParts = [
      '<span class="ch-actor">' + escapeHtmlUg(actor || 'agent') + '</span>'
    ];
    if (target) {
      headParts.push('<span class="ch-arrow">→</span><span class="ch-target">' + escapeHtmlUg(target) + '</span>');
    }
    b.div.innerHTML =
      '<div class="ch-head">' + escapeHtmlUg(ROOM_NAMES[i] || 'Chamber') + '</div>' +
      '<div>' + headParts.join('') + ': ' + escapeHtmlUg(trimmed) + '</div>';
    b.ttl = 6.0; // visible 6 seconds
    b.div.classList.add('live');
  };
  function updateBubbles(dt) {
    if (!U._bubbles || !camera) return;
    const tmp = new THREE.Vector3();
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = 0; i < U._bubbles.length; i++) {
      const b = U._bubbles[i];
      if (b.ttl > 0) {
        b.ttl -= dt;
        if (b.ttl <= 0) b.div.classList.remove('live');
      }
      // always reposition (even when not live) so when the next message
      // pops in it's at the right spot already
      const r = ROOMS[i];
      tmp.set(r.x, r.y, 0).project(camera);
      const sx = (tmp.x + 1) / 2 * w;
      const sy = (1 - (tmp.y + 1) / 2) * h;
      b.div.style.left = sx + 'px';
      b.div.style.top = (sy - 14) + 'px';
    }
  }
  U.hideAllChamberMessages = function () {
    if (!U._bubbles) return;
    U._bubbles.forEach(b => { b.ttl = 0; b.div.classList.remove('live'); });
  };

  U.startDebate = function () {
    ensureDebateCloud();
    _debateOn = true;
    _debateSpawnT = 0;
    _debateLines = [];
    if (U._debateCloud) U._debateCloud.visible = true;
  };
  U.stopDebate = function () {
    _debateOn = false;
    _debateLines = [];
    if (U._debatePos) {
      const arr = U._debatePos.array;
      for (let i = 0; i < arr.length; i++) arr[i] = -9999;
      U._debatePos.needsUpdate = true;
    }
    if (U._debateCloud) U._debateCloud.visible = false;
    if (U.hideAllChamberMessages) U.hideAllChamberMessages();
  };
  U.tickDebate = function (dt /*, elapsed */) {
    // Always tick the chamber message bubbles so their world-to-screen
    // positions stay synced with the camera and any TTL countdown runs.
    updateBubbles(dt);
    if (!_debateOn || !U._debateCloud || !agents || agents.length < 2) return;
    // ~8 bursts per second so the chambers feel alive
    _debateSpawnT += dt;
    while (_debateSpawnT > 0.12) {
      _debateSpawnT -= 0.12;
      // pick two agents in the same chamber (state==='mill') so the
      // exchange visibly stays inside a chamber rather than crossing
      // tunnels.
      const a = agents[Math.floor(Math.random() * agents.length)];
      const sameRoom = agents.filter(x => x !== a && x.roomId === a.roomId);
      if (!sameRoom.length) continue;
      const b = sameRoom[Math.floor(Math.random() * sameRoom.length)];
      _debateLines.push({ ax: a.px, ay: a.py, bx: b.px, by: b.py, ttl: 1.3, age: 0 });
      if (_debateLines.length > 14) _debateLines.shift();
    }
    // render each line as DEBATE_PER_BURST particles spread along it
    const arr = U._debatePos.array;
    let p = 0;
    for (let i = _debateLines.length - 1; i >= 0; i--) {
      const l = _debateLines[i];
      l.age += dt;
      if (l.age >= l.ttl) { _debateLines.splice(i, 1); continue; }
      const k = Math.min(1, l.age / 0.18) * Math.min(1, (l.ttl - l.age) / 0.4);
      for (let j = 0; j < DEBATE_PER_BURST; j++) {
        if (p * 3 + 2 >= arr.length) break;
        const t = (j / (DEBATE_PER_BURST - 1)) + l.age * 0.6;
        const u = t % 1;
        arr[p * 3]     = l.ax + (l.bx - l.ax) * u;
        arr[p * 3 + 1] = l.ay + (l.by - l.ay) * u;
        arr[p * 3 + 2] = 1.2 + 0.4 * k;
        p++;
      }
    }
    // park remaining buffer below the world
    for (; p < DEBATE_MAX_PARTICLES; p++) {
      arr[p * 3] = -9999; arr[p * 3 + 1] = -9999; arr[p * 3 + 2] = -9999;
    }
    U._debatePos.needsUpdate = true;
  };

  // ---- WASD pan + scroll-zoom + slight mouse tilt --------------------
  // While underground is active, hold WASD to pan the camera across the
  // colony cross-section; scroll wheel zooms in/out by adjusting Z. Tiny
  // mouse-position-based tilt keeps the view feeling alive.
  const fpKeys = {};
  let fpZoom = 0; // -1..1 input; integrates into camera Z
  let fpMouseTx = 0, fpMouseTy = 0;
  addEventListener('keydown', e => { fpKeys[e.code] = true; });
  addEventListener('keyup', e => { fpKeys[e.code] = false; });
  // Scroll-to-zoom disabled per user request — the underground view now
  // stays at its fixed framing regardless of mouse wheel input.
  addEventListener('mousemove', e => {
    if (!U.active) return;
    fpMouseTx = (e.clientX / innerWidth) * 2 - 1;
    fpMouseTy = -((e.clientY / innerHeight) * 2 - 1);
  });
  U._fpUpdate = function (dt) {
    if (!camera || !U.active) return;
    // pan via WASD when camera isn't currently dollying to a focused chamber
    if (!U._focusTween) {
      let vx = 0, vy = 0;
      if (fpKeys['KeyW'] || fpKeys['ArrowUp']) vy += 1;
      if (fpKeys['KeyS'] || fpKeys['ArrowDown']) vy -= 1;
      if (fpKeys['KeyA'] || fpKeys['ArrowLeft']) vx -= 1;
      if (fpKeys['KeyD'] || fpKeys['ArrowRight']) vx += 1;
      const boost = (fpKeys['ShiftLeft'] || fpKeys['ShiftRight']) ? 2.2 : 1.0;
      if (vx || vy) {
        const norm = 1 / Math.hypot(vx, vy);
        const sp = 22 * boost * dt;
        camera.position.x += vx * norm * sp;
        camera.position.y += vy * norm * sp;
        U._camLook.x += vx * norm * sp;
        U._camLook.y += vy * norm * sp;
      }
      // soft clamp to colony bounds so user can't fly off into the void
      camera.position.x = Math.max(-50, Math.min(50, camera.position.x));
      camera.position.y = Math.max(-50, Math.min(20, camera.position.y));
      U._camLook.x = Math.max(-50, Math.min(50, U._camLook.x));
      U._camLook.y = Math.max(-50, Math.min(20, U._camLook.y));
      // scroll zoom integrates camera Z toward target
      const baseZ = 58;
      const targetZ = baseZ - fpZoom * 28; // forward when scrolling down
      camera.position.z += (targetZ - camera.position.z) * Math.min(1, dt * 4);
    }
    // micro-tilt the lookAt by the mouse position so the view feels alive
    const tx = fpMouseTx * 1.2, ty = fpMouseTy * 0.6;
    const tiltedLook = U._camLook.clone();
    tiltedLook.x += tx; tiltedLook.y += ty;
    camera.lookAt(tiltedLook);
  };

  U.pickables = function () {
    return ROOMS.map(r => { const g = U.rooms[r.id]; g.userData.room = r; return g.children[0]; });
  };

  U.update = function (dt, elapsed) {
    if (!U.active) return;
    // tick the surface-ant leg-walk shader so underground ants animate too
    if (U._antMat && U._antMat.userData.sh) U._antMat.userData.sh.uniforms.uTime.value = elapsed;
    // dive-in ease — only while no focus tween is active
    if (U._diveT < 1 && !U._focusTween) {
      U._diveT = Math.min(1, U._diveT + dt * 0.6);
      const k = 1 - Math.pow(1 - U._diveT, 3);
      camera.position.lerpVectors(new THREE.Vector3(0, 14, 70), U._camPos, k);
    }

    // agents — guided paths along the actual TUNNELS, smooth orbits in rooms
    const tmpPos = new THREE.Vector3();
    const tmpTan = new THREE.Vector3();
    for (let idx = 0; idx < agents.length; idx++) {
      const a = agents[idx];
      let wx, wy, faceAng;

      if (a.mode === 'mill') {
        const r = node(a.roomId);
        a.orbitPh += dt * a.orbitW;
        wx = r.x + Math.cos(a.orbitPh) * a.orbitR;
        wy = r.y + a.orbitY + Math.sin(a.orbitPh) * a.orbitR * 0.55;
        // face along the orbit tangent
        faceAng = Math.atan2(Math.cos(a.orbitPh) * a.orbitR * 0.55, -Math.sin(a.orbitPh) * a.orbitR);
        a.millLeft -= dt;
        if (a.millLeft <= 0) {
          // If no plan, pick a goal and compute multi-hop A* path. Each
          // tunnel transition just consumes the next hop in plan, no
          // re-planning between rooms.
          if (!a.plan || !a.plan.length) {
            a.goalId = pickGoal(a.roomId);
            a.plan = pathfind(a.roomId, a.goalId);
          }
          const nextId = a.plan && a.plan.length ? a.plan[0] : pickNeighbor(a.roomId);
          const seg = tunnelFor(a.roomId, nextId);
          if (seg) {
            a.mode = 'junction';
            a.fromId = a.roomId; a.toId = nextId;
            a.pauseLeft = 0.5 + Math.random() * 0.7;
            a.twitchPh = 0;
            a.t = 0;
          } else {
            // dead end — reset and re-plan next tick
            a.plan = []; a.goalId = null;
            a.millLeft = 3 + Math.random() * 4;
          }
        }
      } else if (a.mode === 'junction') {
        // sniff the air — body twitches +/- 0.4 rad and ant stays in place
        const r = node(a.fromId);
        wx = a.px; wy = a.py;
        a.twitchPh += dt * 9;
        const seg0 = tunnelFor(a.fromId, a.toId);
        // initial face = direction toward tunnel mouth
        seg0.curve.getTangent(seg0.reversed ? 1 : 0, tmpTan);
        const baseAng = Math.atan2(seg0.reversed ? -tmpTan.y : tmpTan.y, seg0.reversed ? -tmpTan.x : tmpTan.x);
        faceAng = baseAng + Math.sin(a.twitchPh) * 0.35;
        a.pauseLeft -= dt;
        if (a.pauseLeft <= 0) {
          a.mode = 'travel';
        }
      } else {
        const seg = tunnelFor(a.fromId, a.toId);
        if (!seg) {
          // dangling — reset to mill
          a.mode = 'mill'; a.roomId = a.fromId; a.millLeft = 2 + Math.random() * 4;
          continue;
        }
        // ease in/out so ants don't snap-start or skid at room mouths
        const tRaw = a.t;
        const eased = tRaw < 0.5
          ? 2 * tRaw * tRaw
          : 1 - Math.pow(-2 * tRaw + 2, 2) / 2;
        const u = seg.reversed ? 1 - eased : eased;
        seg.curve.getPoint(u, tmpPos);
        seg.curve.getTangent(u, tmpTan);
        wx = tmpPos.x; wy = tmpPos.y;
        const dirX = seg.reversed ? -tmpTan.x : tmpTan.x;
        const dirY = seg.reversed ? -tmpTan.y : tmpTan.y;
        faceAng = Math.atan2(dirY, dirX);
        a.t += dt * a.speed;
        if (a.t >= 1) {
          a.mode = 'mill';
          a.roomId = a.toId;
          // consume this hop; if plan has more, take a shorter rest before
          // continuing — agents transit busy chambers briefly when en route
          if (a.plan && a.plan.length && a.plan[0] === a.toId) a.plan.shift();
          const arrivedAtGoal = !a.plan || !a.plan.length;
          a.millLeft = arrivedAtGoal
            ? (5 + Math.random() * 8)   // long rest at the goal
            : (1.2 + Math.random() * 1.6); // brief transit pause
          if (arrivedAtGoal) { a.plan = []; a.goalId = null; }
          const r = node(a.roomId);
          a.orbitR = r.r * (0.35 + Math.random() * 0.45);
          a.orbitW = (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.22);
          a.orbitPh = Math.random() * 6.28;
          a.orbitY = -r.r * 0.55 + Math.random() * r.r * 0.7;
        }
      }

      // walking bob: small vertical wobble synced to step rhythm
      a.bobPh += dt * (a.mode === 'travel' ? 9 : 5);
      const bob = Math.sin(a.bobPh) * 0.08;

      // pose smoothing — eases position + rotation so motion reads as
      // sexy and floaty rather than tick-driven discrete steps.
      const k = Math.min(1, dt * 9);
      a.px += (wx - a.px) * k;
      a.py += (wy + bob - a.py) * k;
      // rotation: lerp via shortest angular distance
      let dAng = faceAng - a.rz;
      while (dAng > Math.PI) dAng -= Math.PI * 2;
      while (dAng < -Math.PI) dAng += Math.PI * 2;
      a.rz += dAng * Math.min(1, dt * 7);

      _p.set(a.px, a.py, 0.9);
      // The surface ant model has +Z as forward and +Y as up. For the
      // cross-section view we tilt it 90° about X (so its back faces the
      // camera) and then yaw about Z by faceAng + 90° so its head ends up
      // aligned with the motion direction in the XY plane.
      _e.set(Math.PI / 2, 0, a.rz + Math.PI / 2);
      _q.setFromEuler(_e);
      _s.setScalar(0.95 + Math.sin(a.bobPh * 0.5) * 0.04);
      _m.compose(_p, _q, _s);
      agentMesh.setMatrixAt(idx, _m);
      // mirror the position into the glow sprite cloud
      if (U._agentGlowPos) {
        U._agentGlowPos.array[idx * 3] = a.px;
        U._agentGlowPos.array[idx * 3 + 1] = a.py;
        U._agentGlowPos.array[idx * 3 + 2] = 0.85;
      }
    }
    agentMesh.instanceMatrix.needsUpdate = true;
    if (U._agentGlowPos) U._agentGlowPos.needsUpdate = true;

    // room glow pulse
    ROOMS.forEach(r => {
      const g = U.rooms[r.id];
      if (g._extra) { const glow = g._extra[2]; if (glow) glow.material.opacity = 0.2 + Math.sin(elapsed * 1.5 + r.x) * 0.08; }
    });
    // spores drift
    if (U.spores) {
      const p = U.spores.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { p.array[i * 3 + 1] = U._sporeBase[i * 3 + 1] + Math.sin(elapsed * 0.3 + i) * 1.5; }
      p.needsUpdate = true;
    }

    // larvae soft pulse — emissive intensity + slight scale breathing
    if (U.larvae) {
      U.larvae.forEach((m, i) => {
        const ph = m.userData.basePh;
        const pulse = 0.22 + 0.18 * (0.5 + 0.5 * Math.sin(elapsed * 1.6 + ph));
        m.material.emissiveIntensity = pulse;
        const bs = 1 + 0.06 * Math.sin(elapsed * 1.4 + ph * 1.7);
        m.scale.set((0.9 + (i % 3) * 0.05) * bs, (0.7 + (i % 2) * 0.05) * bs, (1.4 + (i % 4) * 0.04) * bs);
      });
    }
    // queen slow breathing
    if (U.queenMesh) {
      const b = 1 + 0.025 * Math.sin(elapsed * 0.9);
      U.queenMesh.scale.set(b, b, b);
    }
    // pheromone particles flow along their tunnel curves
    if (U._phPos && U._phState.length) {
      const arr = U._phPos.array;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < U._phState.length; i++) {
        const s = U._phState[i];
        if (!s.curve) continue;
        s.t = (s.t + dt * s.speed) % 1;
        s.curve.getPoint(s.t, tmp);
        arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = 0.7;
      }
      U._phPos.needsUpdate = true;
    }

    // hovered chamber highlight — fade its tunnel paths up
    if (U._tunnelGlows) {
      U._tunnelGlows.forEach((lm, idx) => {
        const [a, b] = TUNNELS[idx];
        const hit = U._hoverRoomId && (U._hoverRoomId === a || U._hoverRoomId === b);
        const target = hit ? 0.9 : 0.5;
        lm.opacity += (target - lm.opacity) * Math.min(1, dt * 6);
      });
    }

    // debug overlay: visualise tracked agent 0's current A* plan
    if (U.debugVisible && U._debugPathGeo && agents && agents[0]) {
      const a = agents[0];
      const nodes = [a.roomId].concat(a.plan || []);
      const arr = U._debugPathGeo.attributes.position.array;
      let n = 0;
      // include current world position as the first point so the line
      // starts at the ant rather than at the room center
      arr[n++] = a.px; arr[n++] = a.py; arr[n++] = 1.6;
      for (let i = 0; i < nodes.length && (n / 3) < 20; i++) {
        const r = node(nodes[i]);
        if (!r) continue;
        arr[n++] = r.x; arr[n++] = r.y; arr[n++] = 1.6;
      }
      U._debugPathGeo.attributes.position.needsUpdate = true;
      U._debugPathGeo.setDrawRange(0, n / 3);
    }

    // chamber focus camera dolly
    if (U._focusTween && U._focusTween.t < 1) {
      const tw = U._focusTween;
      tw.t = Math.min(1, tw.t + dt * 0.9);
      const k = 1 - Math.pow(1 - tw.t, 3);
      camera.position.lerpVectors(tw.fromP, tw.toP, k);
      U._camLook.lerpVectors(tw.fromL, tw.toL, k);
    } else if (U._focusTween && U._focusTween.t >= 1) {
      U._focusTween = null; // release so WASD pan resumes
    }
    // WASD pan + zoom + mouse tilt — runs every frame, also writes lookAt
    if (U._fpUpdate) U._fpUpdate(dt);
    else if (U._camLook) camera.lookAt(U._camLook);

  };

  // ---- public: focus the camera on a chamber. Called from interactions.js
  // when the user clicks a room in the underground view. ----------------
  U.focusRoom = function (roomId) {
    const r = node(roomId);
    if (!r || !camera) return;
    const fromP = camera.position.clone();
    const fromL = U._camLook ? U._camLook.clone() : new THREE.Vector3(0, -21, 0);
    const toP = new THREE.Vector3(r.x, r.y + 4, 22);
    const toL = new THREE.Vector3(r.x, r.y, 0);
    U._focusTween = { t: 0, fromP, toP, fromL, toL };
    U._focusRoomId = roomId;
    DN.hud && DN.hud.showRoomInfo && DN.hud.showRoomInfo(r);
  };

  // ---- hover helpers used by interactions.js for tunnel-glow feedback --
  U.setHoverRoom = function (id) { U._hoverRoomId = id || null; };

  // ---- debug overlay --------------------------------------------------
  // Visualises the navigation graph: bright spheres at chamber nodes, the
  // raw tunnel edges (as lines distinct from the pheromone glow), and a
  // bright cyan polyline tracing one tracked agent's current A* plan. The
  // overlay is a single Group toggled visible via U.toggleDebug().
  U.debugVisible = false;
  function ensureDebug() {
    if (U.debugGroup) return U.debugGroup;
    const grp = new THREE.Group();
    grp.visible = false;
    // node markers
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0x66E0FF, transparent: true, opacity: 0.85 });
    ROOMS.forEach(r => {
      const sph = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), nodeMat);
      sph.position.set(r.x, r.y, 1.5);
      grp.add(sph);
    });
    // edge lines
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x66E0FF, transparent: true, opacity: 0.45 });
    TUNNELS.forEach(([aId, bId]) => {
      const a = node(aId), b = node(bId);
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, 1.4),
        new THREE.Vector3(b.x, b.y, 1.4)
      ]);
      grp.add(new THREE.Line(g, edgeMat));
    });
    // tracked agent path (rebuilt every frame when debug is on)
    U._debugPathGeo = new THREE.BufferGeometry();
    U._debugPathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(20 * 3), 3));
    U._debugPathGeo.setDrawRange(0, 0);
    grp.add(new THREE.Line(U._debugPathGeo, new THREE.LineBasicMaterial({
      color: 0xFF6BD6, transparent: true, opacity: 0.95, linewidth: 2
    })));
    scene.add(grp);
    U.debugGroup = grp;
    return grp;
  }
  U.toggleDebug = function () {
    ensureDebug();
    U.debugVisible = !U.debugVisible;
    U.debugGroup.visible = U.debugVisible;
    return U.debugVisible;
  };

  U.resize = function () { if (camera) { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); } };

  return U;
})();
