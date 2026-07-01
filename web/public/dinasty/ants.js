// WorldColony — ant agents: instanced voxel ants w/ shader-animated legs, behavior, hero ants
window.DN = window.DN || {};

DN.ants = (function () {
  const A = { perCol: 40, list: [], heroes: [], byMesh: {}, GROUPS: 5, ambientDeaths: false };
  let scene, noise;
  const P = DN.palette;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  function ground(x, z) { return DN.world.heightAt(x, z); }
  // height a colony mound adds at a world point — a smooth dome rising to the summit,
  // then a dip into the crater shaft near the centre so ants climb the hill and visibly
  // drop into the hole at the top instead of clipping through the mound.
  function moundLift(col, x, z) {
    if (!col || !col._mR) return 0;
    const dx = x - col.pos.x, dz = z - col.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= col._mR) return 0;
    let h = col._mH * 0.5 * (1 + Math.cos(Math.PI * (d / col._mR)));   // dome
    const cr = col._mCr;
    if (cr && d < cr) {                          // inside the rim -> follow the shaft down
      const f = d / cr;                          // 0 centre .. 1 rim
      const shaftY = col._mH - (col._mSd || 3) * (1 - f);
      h = Math.min(h, shaftY);
    }
    return h;
  }
  // ground height including whichever colony mound an ant is standing on
  function surf(x, z) {
    let lift = 0;
    const list = DN.colony && DN.colony.list;
    if (list) { for (let i = 0; i < list.length; i++) { const l = moundLift(list[i], x, z); if (l > lift) lift = l; } }
    return ground(x, z) + lift;
  }

  // ---- shared trail cache: ants travelling between the same (colony,
  // resource) pair ride a single Quadratic Bezier curve. That way many ants
  // form a single-file column instead of fanning out individually. -----
  const _trails = new Map();
  function trailKey(col, res) { return col.id + '|' + (res ? res.id : 'wander'); }
  function makeTrail(col, res) {
    const start = new THREE.Vector3(col.entrance.x, 0, col.entrance.z);
    let end;
    if (res) {
      end = new THREE.Vector3(res.pos.x, 0, res.pos.z);
    } else {
      // wander destination — a deterministic far-out point per colony so
      // the wander trail is also a real column, not random per-ant scatter.
      let h = 0;
      for (let i = 0; i < col.id.length; i++) h = ((h * 31) + col.id.charCodeAt(i)) | 0;
      const ang = ((h % 360) / 360) * Math.PI * 2;
      const r = 38 + Math.abs((h >> 8) % 24);
      end = new THREE.Vector3(col.pos.x + Math.cos(ang) * r, 0, col.pos.z + Math.sin(ang) * r);
    }
    const dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    // perpendicular curl seeded by key hash so each trail has its own arc
    const key = trailKey(col, res);
    let kh = 0; for (let i = 0; i < key.length; i++) kh = ((kh * 131) + key.charCodeAt(i)) | 0;
    const curl = (((kh % 100) / 100) - 0.5) * 0.22 * len;
    const perpx = -dz / len, perpz = dx / len;
    const mid = new THREE.Vector3(
      (start.x + end.x) * 0.5 + perpx * curl,
      0,
      (start.z + end.z) * 0.5 + perpz * curl
    );
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    return { curve, length: len, key, resId: res ? res.id : null };
  }
  function getTrail(col, res) {
    const k = trailKey(col, res);
    let t = _trails.get(k);
    if (!t) { t = makeTrail(col, res); _trails.set(k, t); }
    return t;
  }
  function invalidateTrailsFor(resId) {
    for (const [k, t] of _trails) if (t.resId === resId) _trails.delete(k);
  }

  // ---- ant geometry builder with leg-animation attributes ----
  function AntBuilder() { this.pos = []; this.norm = []; this.col = []; this.leg = []; this.root = []; this.phase = []; this._c = new THREE.Color(); }
  const FACES = [
    [[0, 0, 1], [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]]],
    [[0, 0, -1], [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]]],
    [[1, 0, 0], [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5]]],
    [[-1, 0, 0], [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5]]],
    [[0, 1, 0], [[-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5], [-.5, .5, -.5]]],
    [[0, -1, 0], [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]]]
  ];
  AntBuilder.prototype.box = function (size, position, color, isLeg, root, phase, rot) {
    const c = this._c.set(color);
    const [sx, sy, sz] = size, [px, py, pz] = position;
    let ra = 0, rax = 'z'; if (rot) { ra = rot.a; rax = rot.axis; }
    const ca = Math.cos(ra), sa = Math.sin(ra);
    const R = (x, y, z) => {
      if (!ra) return [x, y, z];
      if (rax === 'z') return [x * ca - y * sa, x * sa + y * ca, z];
      if (rax === 'x') return [x, y * ca - z * sa, y * sa + z * ca];
      return [x * ca + z * sa, y, -x * sa + z * ca];
    };
    const lf = isLeg ? 1 : 0, rt = root || [0, 0, 0], ph = phase || 0;
    for (let f = 0; f < 6; f++) {
      const nm = FACES[f][0], corners = FACES[f][1];
      const rn = R(nm[0], nm[1], nm[2]);
      const vv = corners.map(v => { const r = R(v[0] * sx, v[1] * sy, v[2] * sz); return [r[0] + px, r[1] + py, r[2] + pz]; });
      const tri = [0, 1, 2, 0, 2, 3];
      for (let t = 0; t < 6; t++) {
        const v = vv[tri[t]];
        this.pos.push(v[0], v[1], v[2]); this.norm.push(rn[0], rn[1], rn[2]); this.col.push(c.r, c.g, c.b);
        this.leg.push(lf); this.root.push(rt[0], rt[1], rt[2]); this.phase.push(ph);
      }
    }
  };
  AntBuilder.prototype.geometry = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.norm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aLeg', new THREE.BufferAttribute(new Float32Array(this.leg), 1));
    g.setAttribute('aLegRoot', new THREE.BufferAttribute(new Float32Array(this.root), 3));
    g.setAttribute('aLegPhase', new THREE.BufferAttribute(new Float32Array(this.phase), 1));
    return g;
  };

  function buildAntGeo(mark) {
    const b = new AntBuilder();
    // Matte-black warrior-ant palette — body reads as black with a subtle
    // top-light sheen so anatomy stays legible against the warm world.
    const body  = 0x0e0e0e; // base
    const dark  = 0x050505; // shadow / joints
    const light = 0x242424; // dorsal sheen
    const sheen = 0x363636; // top crown
    const eye   = 0x0a0a0a; // compound eyes (slightly distinct from body)

    // ---------------- GASTER (abdomen) ----------------
    // Tapered teardrop built from layered slabs so the silhouette curves.
    const gz = -0.45;
    b.box([0.56, 0.50, 0.32], [0, 0.46, gz + 0.20], body);     // front shoulder
    b.box([0.66, 0.60, 0.36], [0, 0.48, gz - 0.04], body);     // widest belly
    b.box([0.62, 0.58, 0.34], [0, 0.46, gz - 0.32], body);
    b.box([0.50, 0.46, 0.28], [0, 0.42, gz - 0.56], body);
    b.box([0.34, 0.30, 0.20], [0, 0.38, gz - 0.74], body);
    b.box([0.18, 0.16, 0.12], [0, 0.36, gz - 0.86], dark);     // tail tip
    // dorsal sheen + small faction stripe on top (colony identity)
    b.box([0.32, 0.06, 0.42], [0, 0.74, gz - 0.10], light);
    b.box([0.16, 0.06, 0.22], [0, 0.78, gz - 0.10], mark);

    // ---------------- PETIOLE & POSTPETIOLE (narrow waist) ----------------
    b.box([0.10, 0.14, 0.10], [0, 0.42, -0.10], dark);          // petiole node
    b.box([0.08, 0.18, 0.06], [0, 0.50, -0.10], dark);          // peak
    b.box([0.12, 0.12, 0.10], [0, 0.40,  0.02], dark);          // postpetiole

    // ---------------- THORAX / MESOSOMA (arched dome) ----------------
    b.box([0.40, 0.32, 0.50], [0, 0.42, 0.22], body);
    b.box([0.34, 0.22, 0.46], [0, 0.58, 0.24], body);
    b.box([0.22, 0.10, 0.36], [0, 0.70, 0.22], light);          // top sheen
    b.box([0.30, 0.26, 0.18], [0, 0.48, 0.42], body);           // pronotum bulge

    // ---------------- HEAD ----------------
    b.box([0.52, 0.44, 0.42], [0, 0.46, 0.72], body);           // main head
    b.box([0.44, 0.20, 0.38], [0, 0.64, 0.72], light);          // top dome
    b.box([0.34, 0.10, 0.32], [0, 0.72, 0.72], sheen);          // crown
    b.box([0.46, 0.30, 0.18], [0, 0.40, 0.86], body);           // forward face
    // compound eyes — large bean shapes angled outward
    b.box([0.14, 0.18, 0.12], [ 0.24, 0.52, 0.80], eye, false, null, 0, { axis: 'y', a:  0.22 });
    b.box([0.14, 0.18, 0.12], [-0.24, 0.52, 0.80], eye, false, null, 0, { axis: 'y', a: -0.22 });

    // mandibles — long sickle: 2 angled segments per side curving inward
    b.box([0.06, 0.08, 0.22], [ 0.14, 0.36, 1.00], dark, false, null, 0, { axis: 'y', a:  0.38 });
    b.box([0.06, 0.08, 0.18], [ 0.22, 0.36, 1.18], dark, false, null, 0, { axis: 'y', a: -0.42 });
    b.box([0.06, 0.08, 0.22], [-0.14, 0.36, 1.00], dark, false, null, 0, { axis: 'y', a: -0.38 });
    b.box([0.06, 0.08, 0.18], [-0.22, 0.36, 1.18], dark, false, null, 0, { axis: 'y', a:  0.42 });

    // antennae — elbowed 3-segment, animated as a unit (shared root+phase)
    // Right
    {
      const r = [0.15, 0.66, 0.84];
      b.box([0.05, 0.05, 0.34], [ 0.20, 0.74, 1.00], light, true, r, 1.2, { axis: 'x', a: -0.55 }); // scape
      b.box([0.06, 0.06, 0.06], [ 0.24, 0.84, 1.18], dark,  true, r, 1.2);                          // elbow
      b.box([0.04, 0.04, 0.30], [ 0.28, 0.86, 1.34], light, true, r, 1.2, { axis: 'x', a:  0.32 }); // flagellum
      b.box([0.035,0.035,0.10], [ 0.30, 0.80, 1.52], dark,  true, r, 1.2, { axis: 'x', a:  0.50 }); // tip
    }
    // Left
    {
      const r = [-0.15, 0.66, 0.84];
      b.box([0.05, 0.05, 0.34], [-0.20, 0.74, 1.00], light, true, r, 2.4, { axis: 'x', a: -0.55 });
      b.box([0.06, 0.06, 0.06], [-0.24, 0.84, 1.18], dark,  true, r, 2.4);
      b.box([0.04, 0.04, 0.30], [-0.28, 0.86, 1.34], light, true, r, 2.4, { axis: 'x', a:  0.32 });
      b.box([0.035,0.035,0.10], [-0.30, 0.80, 1.52], dark,  true, r, 2.4, { axis: 'x', a:  0.50 });
    }

    // ---------------- LEGS ----------------
    // 6 legs, tripod gait. Each leg: coxa stub (at body wall) + femur
    // (horizontal bone spanning from hip OUT to knee) + knee + tibia
    // (drops vertical to foot) + tarsus foot hook. All segments share
    // root+phase so the leg-animation shader rotates them as one unit.
    // Hips sit at the thorax wall (x = ±0.18); knees ~0.40 outboard.
    const hipY = 0.36, legZ = [0.35, 0.18, -0.02];
    for (let s = 0; s < 2; s++) {
      const sign = s ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        const hx = 0.18 * sign, hz = legZ[i];
        const root = [hx, hipY, hz];
        const ph = ((s + i) % 2) * Math.PI;
        const kneeX = hx + 0.42 * sign;
        // coxa — chunky hip joint embedded in the body wall
        b.box([0.14, 0.14, 0.14], [hx + 0.02 * sign, hipY, hz], dark, true, root, ph);
        // femur — long horizontal bone from coxa OUT to knee
        // (length along X so it visibly bridges the body and the leg post)
        b.box([0.40, 0.07, 0.07], [hx + 0.22 * sign, hipY + 0.04, hz], dark, true, root, ph, { axis: 'z', a: sign * 0.18 });
        // knee joint
        b.box([0.09, 0.09, 0.09], [kneeX, hipY + 0.08, hz], dark, true, root, ph);
        // tibia — drops vertical from knee toward ground
        b.box([0.06, 0.44, 0.06], [kneeX + 0.02 * sign, hipY - 0.16, hz], dark, true, root, ph, { axis: 'z', a: sign * -0.10 });
        // tarsus foot — small forward hook resting on ground
        b.box([0.06, 0.06, 0.12], [kneeX + 0.04 * sign, hipY - 0.40, hz + 0.04], dark, true, root, ph);
      }
    }
    return b.geometry();
  }

  // Exposed so the underground colony view can reuse the same detailed
  // voxel ant body + leg-animation shader (so underground ants look
  // identical to surface ants instead of crude procedural blobs).
  A.buildAntGeo = buildAntGeo;
  A.antMaterial = antMaterial;

  function antMaterial() {
    const mat = DN.util.voxelMat({ roughness: 0.34, metalness: 0.18, flatShading: false });
    mat.userData.sceneRevampSheen = true;
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = { value: 0 };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute float aLeg;
        attribute vec3 aLegRoot;
        attribute float aLegPhase;
        attribute vec2 aInst;
        uniform float uTime;`);
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        if(aLeg > 0.5){
          float walk = uTime * aInst.y + aInst.x;
          float sw = sin(walk + aLegPhase);
          float ang = sw * 0.55;
          vec3 lp = transformed - aLegRoot;
          float ca = cos(ang), sa = sin(ang);
          lp = vec3(lp.x*ca + lp.z*sa, lp.y, -lp.x*sa + lp.z*ca);
          lp.y += max(0.0, sw) * 0.14;
          transformed = aLegRoot + lp;
        }
        transformed.y += sin(uTime*aInst.y*2.0 + aInst.x)*0.018;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `
        float antRim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.2);
        gl_FragColor.rgb += vec3(0.055, 0.050, 0.040) * antRim;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), 0.06);
        #include <dithering_fragment>`);
      mat.userData.sh = sh;
    };
    return mat;
  }

  // Migration trail from a parent colony's entrance to the new colony's
  // entrance. One shared curve so the founder party reads as one column.
  function buildMigrationTrail(parent, newCol) {
    const start = new THREE.Vector3(parent.entrance.x, 0, parent.entrance.z);
    const end = new THREE.Vector3(newCol.entrance.x, 0, newCol.entrance.z);
    const dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    const perpx = -dz / len, perpz = dx / len;
    // gentle curl so the migration arcs naturally instead of pure straight
    const mid = new THREE.Vector3(
      (start.x + end.x) * 0.5 + perpx * 0.12 * len,
      0,
      (start.z + end.z) * 0.5 + perpz * 0.12 * len
    );
    return { curve: new THREE.QuadraticBezierCurve3(start, mid, end), length: len };
  }

  // Spawn the ant InstancedMesh + worker list for one colony. Pulled out
  // of A.init so newly founded colonies can call it via A.addColony().
  // `parent` (optional): if provided, all initial ants begin at parent.
  // entrance and walk a migration trail to col.entrance, then settle into
  // normal foraging behaviour.
  function spawnColonyAnts(col, ci, parent) {
    const geo = buildAntGeo(col.accent);
    const n = A.perCol;
    const mesh = new THREE.InstancedMesh(geo, A.material, n);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.userData.colIndex = ci;
    const inst = new Float32Array(n * 2);
    const migTrail = parent ? buildMigrationTrail(parent, col) : null;
    for (let i = 0; i < n; i++) {
      inst[i * 2] = Math.random() * 6.28;
      inst[i * 2 + 1] = 7 + Math.random() * 4;
      const jx = (Math.random() - 0.5) * 1.2;
      const jz = (Math.random() - 0.5) * 1.2;
      const groupIdx = i % A.GROUPS;
      const startX = parent ? parent.entrance.x + jx : col.entrance.x + jx;
      const startZ = parent ? parent.entrance.z + jz : col.entrance.z + jz;
      const ant = {
        id: 'w-' + ci + '-' + i, ci, col, inst: i, mesh,
        x: startX, z: startZ,
        yaw: Math.random() * 6.28,
        speed: 2.0 + Math.random() * 1.0,
        // 'migrating' = walking from parent to new colony entrance
        // 'out'/'home' = normal forage cycle
        // Default to 'idle' so workers stay hidden under the mound until the
        // lifecycle controller calls A.activate(). Migrating founders still
        // walk in immediately.
        state: parent ? 'migrating' : 'idle',
        wob: Math.random() * 6.28,
        trail: null, t: 0, dir: 1,
        // migration state
        migTrail,
        // staggered start so the procession is a long visible column
        // rather than a single clump (i/n in [0,1] → migT in [-0.5, 0])
        migT: parent ? -(i / n) * 0.5 : 0,
        groupIdx,
        laneOffset: (Math.random() - 0.5) * 0.45,
        tStart: ((i / n) * A.GROUPS % 1) + Math.random() * 0.04,
        scale: 1.05 + Math.random() * 0.5, hero: false, cargo: 0,
        deadTimer: 0,
        role: ['Forager', 'Forager', 'Scout', 'Worker'][i % 4]
      };
      if (!parent) pickTarget(ant);
      A.list.push(ant);
    }
    mesh.geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 2));
    scene.add(mesh);
    A.meshes.push(mesh);
    A.byMesh[mesh.uuid] = ci;
    col._antMesh = mesh;
  }

  // Called by colony.js after a founding animation completes — adds the
  // new colony's foragers to the surface ant system. If `parent` is given,
  // those ants walk the migration trail from parent → col before settling.
  A.addColony = function (col, parent) {
    if (!scene || !A.material) return; // not initialised yet
    spawnColonyAnts(col, A.meshes.length, parent);
  };

  A.removeColony = function (col) {
    if (!col) return;
    A.list = A.list.filter(a => a.col !== col);
    A.heroes = A.heroes.filter(a => a.col !== col);
    if (col._antMesh) {
      if (scene) scene.remove(col._antMesh);
      delete A.byMesh[col._antMesh.uuid];
      A.meshes = A.meshes.filter(mesh => mesh !== col._antMesh);
      col._antMesh = null;
    }
  };

  A.init = function (sceneRef, colonies) {
    scene = sceneRef;
    noise = new DNNoise(404);
    const mat = antMaterial();
    A.material = mat;
    A.meshes = [];

    colonies.forEach((col, ci) => { spawnColonyAnts(col, ci); });

    // ---- hero (named) ants ----
    const greek = ['Δ', 'Σ', 'Ω', 'Φ', 'Ψ', 'Θ'];
    const roles = ['Forecaster', 'Scout', 'Forecaster', 'Debater', 'Treasurer', 'Archivist'];
    const heroPool = [];
    for (let h = 0; h < 6; h++) {
      const col = colonies[h % colonies.length];
      const ant = A.list.filter(a => a.col === col && !a.hero)[h < colonies.length ? 0 : 1];
      if (!ant) continue;
      ant.hero = true;
      // heroes stay visible even before lifecycle activation
      ant.state = 'out';
      ant._idleWritten = false;
      if (!ant.trail) pickTarget(ant);
      ant.scale = 1.15;
      ant.role = roles[h];
      ant.name = roles[h].slice(0, 1) + 'gent ' + greek[h] + '-' + String(7 + h * 13).padStart(2, '0');
      ant.accuracy = 58 + Math.round(Math.random() * 34);
      ant.reputation = 40 + Math.round(Math.random() * 55);
      ant.staked = (40 + Math.random() * 220).toFixed(1);
      ant.age = 1 + Math.round(Math.random() * 24);
      ant.gen = 1 + Math.round(Math.random() * 5);
      // glow + pick target follow this ant
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: DN.util.softSprite(), color: col.accent, transparent: true, opacity: 0.6,
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
      glow.scale.set(5, 5, 1);
      scene.add(glow);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 10), new THREE.MeshBasicMaterial({ visible: false }));
      pick.userData.ant = ant;
      scene.add(pick);
      ant.glow = glow; ant.pickTarget = pick;
      A.heroes.push(ant);
    }

    // ---- carried cargo (instanced little crystals above carrying ants) ----
    const cb = new DN.util.VoxelBuilder();
    cb.box([0.4, 0.4, 0.4], [0, 0, 0], 0xE8C24A);
    const cargoMesh = new THREE.InstancedMesh(cb.geometry(), DN.util.voxelMat({ roughness: 0.35 }), A.list.length);
    cargoMesh.frustumCulled = false; cargoMesh.castShadow = false;
    scene.add(cargoMesh);
    A.cargoMesh = cargoMesh;

    // ---- selection marker: a single glow sprite that follows whichever
    // ant the user has clicked. Tinted to the colony accent on selection.
    A.selectionGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: DN.util.softSprite(), color: 0xFFFFFF,
      transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    A.selectionGlow.scale.set(5, 5, 1);
    A.selectionGlow.frustumCulled = false;
    scene.add(A.selectionGlow);
    A.selectedAnt = null;

    // ---- outcome tint: one shared Points cloud, one vertex per ant ----
    // Drawn after lifecycle.deriveOutcomes() flips a.outcome. Colour =
    // green / red / grey by outcome; vertex moved below the world for
    // ants that are not yet decided.
    const outN = A.list.length;
    const outPos = new Float32Array(outN * 3);
    const outCol = new Float32Array(outN * 3);
    for (let i = 0; i < outN * 3; i++) { outPos[i] = -1000; outCol[i] = 1; }
    const outGeo = new THREE.BufferGeometry();
    outGeo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
    outGeo.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
    A.outcomeGlow = new THREE.Points(outGeo, new THREE.PointsMaterial({
      size: 2.6, map: DN.util.softSprite(),
      transparent: true, opacity: 0.85,
      vertexColors: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    }));
    A.outcomeGlow.frustumCulled = false;
    A.outcomeGlow.visible = false;
    scene.add(A.outcomeGlow);
    A._outcomePos = outGeo.attributes.position;
    A._outcomeCol = outGeo.attributes.color;

    return A;
  };

  // RGB tints per outcome state
  const OUTCOME_COLOR = {
    correct: [0.42, 0.78, 0.32],   // green
    wrong:   [0.86, 0.36, 0.28],   // red
    pending: [0.55, 0.49, 0.36],   // tarnished gold
    culled:  [0.30, 0.26, 0.22]    // near-black
  };

  // Called by lifecycle.deriveOutcomes() to make the outcome glow visible
  // and force a refresh next frame. Cheap; no per-ant work here.
  A.showOutcomeGlow = function () {
    if (!A.outcomeGlow) return;
    A.outcomeGlow.visible = true;
    A._outcomeDirty = true;
  };

  A.hideOutcomeGlow = function () {
    if (!A.outcomeGlow) return;
    A.outcomeGlow.visible = false;
  };

  // Mark an ant as the currently inspected one — surface (and underground
  // later) updates the glow sprite to follow it. Pass null to deselect.
  A.setSelected = function (a) {
    A.selectedAnt = a || null;
    if (A.selectionGlow) {
      if (a) A.selectionGlow.material.color.setHex(a.col.accent);
      else A.selectionGlow.material.opacity = 0;
    }
  };

  // Returns the i-th nearest live resource to the colony, so each forager
  // group can lock to a different one and form its own column.
  function nthNearestResource(col, n) {
    const list = (DN.resources && DN.resources.list || []).filter(r => !r.depleted && r.amount > 0);
    if (!list.length) return null;
    list.sort((x, y) => col.pos.distanceTo(x.pos) - col.pos.distanceTo(y.pos));
    return list[Math.min(n, list.length - 1)];
  }

  // Assign this ant to a trail (shared curve to/from a resource). Many
  // ants on the same trail produces a single-file column visually.
  function pickTarget(a) {
    if (a.state === 'out') {
      const res = nthNearestResource(a.col, a.groupIdx || 0);
      a._res = res || null;
      a.trail = getTrail(a.col, res);
      a.dir = 1;
      a.t = a.tStart != null ? a.tStart : 0;
      a.tStart = null;
    } else {
      // returning — reuse last trail in reverse
      if (!a.trail) a.trail = getTrail(a.col, a._res);
      a.dir = -1;
      a.t = 1;
    }
  }

  A.update = function (dt, elapsed, timeScale) {
    if (A.material.userData.sh) A.material.userData.sh.uniforms.uTime.value = elapsed;
    let cargoN = 0;
    const meshDirty = {};
    const _curvePos = new THREE.Vector3();
    const _curveTan = new THREE.Vector3();
    for (let k = 0; k < A.list.length; k++) {
      const a = A.list[k];

      // ---- idle: ant is hidden under the mound until the lifecycle
      // controller activates it. Collapse the instance matrix to zero
      // ONCE, then skip all per-frame work until state flips out. ----
      if (a.state === 'idle') {
        if (!a._idleWritten) {
          a._idleWritten = true;
          _p.set(a.col.entrance.x, -100, a.col.entrance.z); // below ground
          _e.set(0, 0, 0); _q.setFromEuler(_e);
          _s.setScalar(0);
          _m.compose(_p, _q, _s);
          a.mesh.setMatrixAt(a.inst, _m);
          meshDirty[a.mesh.uuid] = a.mesh;
        }
        continue;
      }
      // any non-idle iteration clears the flag so re-entering idle will
      // re-collapse the matrix
      a._idleWritten = false;

      // ---- death animation: ant tips forward, fades to small, then is
      // teleported back to the entrance and respawned outbound. Rate is
      // tuned so ~1 ant dies every several seconds across all colonies. ----
      if (a.state === 'dead') {
        if ((a.permanentDead || a.outcome === 'culled' || (a.agentRecord && (a.agentRecord.status === 'dead' || a.agentRecord.status === 'killed'))) && a.deadTimer <= 0) {
          _p.set(a.x, -100, a.z);
          _e.set(0, 0, 0); _q.setFromEuler(_e);
          _s.setScalar(0);
          _m.compose(_p, _q, _s);
          a.mesh.setMatrixAt(a.inst, _m);
          meshDirty[a.mesh.uuid] = a.mesh;
          continue;
        }
        a.deadTimer -= dt;
        const ttl = Math.max(0, a.deadTimer / 2.0);
        const dieScale = a.scale * Math.max(0.18, ttl);
        const gy = surf(a.x, a.z);
        _p.set(a.x, gy + 0.02, a.z);
        // tip forward as it dies (pitch rotation on X axis)
        _e.set(Math.PI * 0.45 * (1 - ttl), a.yaw, 0);
        _q.setFromEuler(_e);
        _s.setScalar(dieScale);
        _m.compose(_p, _q, _s);
        a.mesh.setMatrixAt(a.inst, _m);
        meshDirty[a.mesh.uuid] = a.mesh;
        if (a.deadTimer <= 0) {
          // respawn at entrance, fresh forager outbound
          a.state = 'out';
          a.x = a.col.entrance.x + (Math.random() - 0.5) * 1.2;
          a.z = a.col.entrance.z + (Math.random() - 0.5) * 1.2;
          a.t = 0; a.dir = 1; a.cargo = 0;
          pickTarget(a);
        }
        continue;
      }
      // Product colonies should only mark death from backend state or an explicit user action.
      // Keep the old ambient survival mechanic behind a disabled flag for visual experiments.
      if (A.ambientDeaths && !a.hero && a.state !== 'migrating' && Math.random() < dt * 0.0002 * timeScale) {
        a.state = 'dead';
        a.deadTimer = 2.0;
        // Rate-limited log emission — at most one DEATH row per ~2s globally.
        A._lastDeathLog = A._lastDeathLog || 0;
        const nowMs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (DN.logTerm && nowMs - A._lastDeathLog > 2000) {
          A._lastDeathLog = nowMs;
          const id = (a.agentRecord && a.agentRecord.agent_id) || a.id;
          DN.logTerm.push('DEATH', id + ' perished mid-route in ' + a.col.name);
        }
        continue;
      }

      // ---- migration: walk from parent.entrance to new colony.entrance
      // along a shared Bezier trail. Negative migT lets each ant wait its
      // turn at the parent entrance so the procession is staggered. -----
      if (a.state === 'migrating') {
        // Tuned so the lead ants arrive just as the 6.5-sec founding
        // animation finishes — total migration ≈ 7s with a ~4s spread.
        a.migT += dt * (a.scriptSpeed || 0.14) * timeScale;
        if (a.migT < 0) {
          // still waiting at parent entrance — render in place
          const gy = surf(a.x, a.z);
          _p.set(a.x, gy + 0.05, a.z);
          _e.set(0, a.yaw, 0); _q.setFromEuler(_e);
          _s.setScalar(a.scale);
          _m.compose(_p, _q, _s);
          a.mesh.setMatrixAt(a.inst, _m);
          meshDirty[a.mesh.uuid] = a.mesh;
          continue;
        }
        if (a.migT >= 1 || !a.migTrail) {
          // Arrived. Sample the exact trail end so there is no teleport.
          if (a.migTrail) {
            a.migTrail.curve.getPoint(1, _curvePos);
            a.x = _curvePos.x; a.z = _curvePos.z;
          }
          // Lifecycle scripted walks can override the arrival behaviour
          // via a per-ant `_onArrive` callback (set by A.scriptWalk).
          // Otherwise fall through to the original `settling` flow.
          if (typeof a._onArrive === 'function') {
            const cb = a._onArrive;
            a._onArrive = null;
            try { cb(a); } catch (_) {}
          } else {
            a.state = 'settling';
            a.settleLeft = Math.random() * 10;
          }
          // render in place this frame so we don't pop
          const gy0 = surf(a.x, a.z);
          _p.set(a.x, gy0 + 0.05, a.z);
          _e.set(0, a.yaw, 0); _q.setFromEuler(_e);
          _s.setScalar(a.scale);
          _m.compose(_p, _q, _s);
          a.mesh.setMatrixAt(a.inst, _m);
          meshDirty[a.mesh.uuid] = a.mesh;
          continue;
        } else {
          a.migTrail.curve.getPoint(a.migT, _curvePos);
          a.migTrail.curve.getTangent(a.migT, _curveTan);
          const perpX = -_curveTan.z, perpZ = _curveTan.x;
          a.x = _curvePos.x + perpX * a.laneOffset;
          a.z = _curvePos.z + perpZ * a.laneOffset;
          const ty = Math.atan2(_curveTan.x, _curveTan.z);
          let d = ty - a.yaw;
          while (d > Math.PI) d -= 6.283;
          while (d < -Math.PI) d += 6.283;
          a.yaw += d * Math.min(1, dt * 8);
          const gy = surf(a.x, a.z);
          _p.set(a.x, gy + 0.05, a.z);
          _e.set(0, a.yaw, 0); _q.setFromEuler(_e);
          _s.setScalar(a.scale);
          _m.compose(_p, _q, _s);
          a.mesh.setMatrixAt(a.inst, _m);
          meshDirty[a.mesh.uuid] = a.mesh;
          continue;
        }
      }

      // ---- settling: just arrived from migration. Drift gently around
      // the new colony entrance for 0–10s, then begin foraging. Each
      // ant's timer is randomised so forage starts spread across that
      // window instead of triggering as a single mass exodus. ----------
      if (a.state === 'settling') {
        a.settleLeft -= dt * timeScale;
        const ex = a.col.entrance.x, ez = a.col.entrance.z;
        // soft random walk
        const turn = noise.n3(a.x * 0.08, a.z * 0.08, elapsed * 0.5 + a.wob);
        a.yaw += turn * dt * 1.5;
        const drift = 0.7;
        a.x += Math.sin(a.yaw) * drift * dt;
        a.z += Math.cos(a.yaw) * drift * dt;
        // soft pull back toward entrance if drifting too far
        const dx = a.x - ex, dz = a.z - ez;
        const d = Math.hypot(dx, dz);
        if (d > 4) {
          a.x -= (dx / d) * 1.5 * dt;
          a.z -= (dz / d) * 1.5 * dt;
        }
        const gy = surf(a.x, a.z);
        _p.set(a.x, gy + 0.05, a.z);
        _e.set(0, a.yaw, 0); _q.setFromEuler(_e);
        _s.setScalar(a.scale);
        _m.compose(_p, _q, _s);
        a.mesh.setMatrixAt(a.inst, _m);
        meshDirty[a.mesh.uuid] = a.mesh;
        if (a.settleLeft <= 0) {
          // settled — join the regular forage rotation
          a.state = 'out'; a.t = 0; a.dir = 1;
          pickTarget(a);
        }
        continue;
      }

      // ensure ant has a trail (first-frame guard)
      if (!a.trail) pickTarget(a);

      // advance t along the trail at constant world-space speed
      const sp = a.speed * timeScale;
      const advance = sp * dt / Math.max(1, a.trail.length);
      a.t += a.dir * advance;

      // arrival → flip state
      if (a.dir > 0 && a.t >= 1) {
        a.t = 1;
        if (a.state === 'out') {
          if (a._res && !a._res.depleted) { a._res.amount -= 0.06 * timeScale; a.cargo = 1; }
          a.state = 'home';
          a.dir = -1;
        }
      } else if (a.dir < 0 && a.t <= 0) {
        a.t = 0;
        if (a.state === 'home') {
          if (a.cargo) { a.col.stats.food = Math.min(100, a.col.stats.food + 0.04); a.cargo = 0; }
          a.state = 'out';
          // re-pick a (possibly fresh) resource — if old resource is gone
          // the trail cache will hand us a new column to follow.
          if (!a._res || a._res.depleted) {
            const next = DN.resources && DN.resources.nearest(a.col.pos);
            a._res = next || null;
            a.trail = getTrail(a.col, a._res);
          }
          a.dir = 1;
        }
      }

      // sample curve position + tangent
      a.trail.curve.getPoint(a.t, _curvePos);
      a.trail.curve.getTangent(a.t, _curveTan);
      // lateral offset perpendicular to tangent (in the xz plane) plus a
      // very small wob noise so the column has organic weave, not a rail
      const perpX = -_curveTan.z, perpZ = _curveTan.x;
      const wob = noise.n3(_curvePos.x * 0.05, _curvePos.z * 0.05, elapsed * 0.4 + a.wob) * 0.3;
      a.x = _curvePos.x + perpX * (a.laneOffset + wob);
      a.z = _curvePos.z + perpZ * (a.laneOffset + wob);

      // face along direction of travel (flip when returning home)
      const dirSign = a.dir;
      const ty = Math.atan2(_curveTan.x * dirSign, _curveTan.z * dirSign);
      let d = ty - a.yaw; while (d > Math.PI) d -= 6.283; while (d < -Math.PI) d += 6.283;
      a.yaw += d * Math.min(1, dt * 8);
      const gy = surf(a.x, a.z);
      _p.set(a.x, gy + 0.05, a.z);
      _e.set(0, a.yaw, 0); _q.setFromEuler(_e);
      _s.setScalar(a.scale);
      _m.compose(_p, _q, _s);
      a.mesh.setMatrixAt(a.inst, _m);
      meshDirty[a.mesh.uuid] = a.mesh;
      // cargo crystal
      if (a.cargo && !a.hero) {
        _p.set(a.x, gy + 0.05 + 0.7 * a.scale, a.z);
        _m.compose(_p, _q, _s);
        A.cargoMesh.setMatrixAt(cargoN++, _m);
      }
      // hero glow + pick follow
      if (a.hero) {
        a.glow.position.set(a.x, gy + 0.9, a.z);
        a.glow.material.opacity = a.selected ? 0.85 : 0.45 + Math.sin(elapsed * 3 + a.wob) * 0.12;
        a.glow.scale.setScalar(a.selected ? 4.5 : 3);
        a.pickTarget.position.set(a.x, gy + 1, a.z);
        a.wx = a.x; a.wy = gy; a.wz = a.z;
      }
    }
    for (const id in meshDirty) meshDirty[id].instanceMatrix.needsUpdate = true;
    A.cargoMesh.count = cargoN;
    A.cargoMesh.instanceMatrix.needsUpdate = true;

    // selection glow follows the currently inspected ant
    if (A.selectedAnt && A.selectionGlow) {
      const a = A.selectedAnt;
      const gy = surf(a.x, a.z);
      A.selectionGlow.position.set(a.x, gy + 1.4, a.z);
      // pulse opacity for visibility
      A.selectionGlow.material.opacity = 0.65 + Math.sin(elapsed * 5) * 0.2;
      // breathing scale so the ring reads against the busy ant column
      const s = 4.2 + Math.sin(elapsed * 3) * 0.4;
      A.selectionGlow.scale.set(s, s, 1);
    }

    // outcome tint sprite cloud — mirrors each ant's position and tints
    // by `a.outcome`. Only ticks when the cloud is visible (lifecycle
    // turns it on at egress_roam).
    if (A.outcomeGlow && A.outcomeGlow.visible && A._outcomePos) {
      const pos = A._outcomePos.array, col = A._outcomeCol.array;
      let anyAlive = false;
      const pulse = 0.85 + Math.sin(elapsed * 2.6) * 0.12;
      A.outcomeGlow.material.opacity = pulse;
      for (let i = 0; i < A.list.length; i++) {
        const a = A.list[i];
        if (!a.outcome || a.state === 'idle' || a.state === 'dead') {
          // hide vertex by parking it below the world
          pos[i * 3 + 1] = -1000;
          continue;
        }
        const c = OUTCOME_COLOR[a.outcome] || OUTCOME_COLOR.pending;
        const gy = surf(a.x, a.z);
        pos[i * 3]     = a.x;
        pos[i * 3 + 1] = gy + 1.6;
        pos[i * 3 + 2] = a.z;
        col[i * 3]     = c[0];
        col[i * 3 + 1] = c[1];
        col[i * 3 + 2] = c[2];
        anyAlive = true;
      }
      A._outcomePos.needsUpdate = true;
      A._outcomeCol.needsUpdate = true;
      if (!anyAlive) A.outcomeGlow.visible = false;
    }
  };

  // resolve an instanced raycast hit into an ant object
  // Distribute backend agent records across the surface ants. If there are
  // fewer records than ants we cycle (so every ant has a wallet); if there
  // are more we just use the first A.list.length of them. Heroes prefer
  // top-ranked records so their named UI matches the real leader.
  function applyAgentRecord(a, rec) {
    a.agentRecord = rec;
    if (rec.ens_name) a.name = rec.ens_name;
    if (rec.status === 'dead' || rec.status === 'killed') {
      a.outcome = 'culled';
      a.state = 'dead';
      a.deadTimer = 0;
      a.permanentDead = true;
    }
  }

  A.bindAgentRecords = function (records) {
    if (!records || !records.length || !A.list.length) return;
    const sorted = records.slice().sort((x, y) => (y.bankroll || 0) - (x.bankroll || 0));
    // Heroes first: give them the top records so their names/wallets align
    const heroes = A.list.filter(a => a.hero);
    for (let h = 0; h < heroes.length; h++) {
      const rec = sorted[h % sorted.length];
      applyAgentRecord(heroes[h], rec);
    }
    // Then everyone else round-robins across the rest
    let ri = 0;
    for (const a of A.list) {
      if (a.hero) continue;
      applyAgentRecord(a, sorted[ri % sorted.length]);
      ri++;
    }
  };

  A.attachChildRecord = function (parentAnt, record) {
    if (!record || !A.list.length) return null;
    const sameCol = parentAnt && parentAnt.col
      ? A.list.filter(a => a.col === parentAnt.col && a !== parentAnt && !a.hero)
      : A.list.filter(a => !a.hero);
    const target = sameCol.find(a => !a.agentRecord || !a.agentRecord.parent_agent_id) || sameCol[0] || null;
    if (!target) return null;
    target.agentRecord = record;
    target.name = record.ens_name || record.name || record.agent_id || target.name;
    target.role = 'Founder';
    target.gen = record.generation || ((parentAnt && parentAnt.gen) ? parentAnt.gen + 1 : target.gen);
    target.scale = Math.max(target.scale || 1, 1.25);
    target.outcome = null;
    target.deadTimer = 0;
    target.permanentDead = false;
    if (target.state === 'dead') target.state = 'idle';
    return target;
  };

  // Activate idle ants. Called by DN.lifecycle when phases transition out
  // of IDLE. Options:
  //   colony: only activate ants for this colony (default: all)
  //   limit:  cap the number of activated ants per call (default: all)
  //   state:  target state to flip into (default: 'out' — normal foraging)
  A.activate = function (opts) {
    opts = opts || {};
    const target = opts.state || 'out';
    let activated = 0;
    for (const a of A.list) {
      if (a.state !== 'idle') continue;
      if (a.permanentDead || (a.agentRecord && (a.agentRecord.status === 'dead' || a.agentRecord.status === 'killed'))) continue;
      if (opts.colony && a.col !== opts.colony) continue;
      // jitter the spawn point so they don't all surface in the same pixel
      a.x = a.col.entrance.x + (Math.random() - 0.5) * 1.4;
      a.z = a.col.entrance.z + (Math.random() - 0.5) * 1.4;
      a.state = target;
      a.t = 0; a.dir = 1; a.cargo = 0;
      a._idleWritten = false;
      activated++;
      if (opts.limit && activated >= opts.limit) break;
    }
    return activated;
  };

  // Script a one-off Bezier walk for an ant: from (fromX, fromZ) to
  // (toX, toZ). Uses the existing migration walker so we get smooth
  // lateral offset, easing, and yaw lerp for free. On arrival, the
  // ant's `_onArrive` callback fires (the migration arrival hook
  // we added). Speed is tuned to feel scout-like, not forager-like.
  A.scriptWalk = function (ant, fromX, fromZ, toX, toZ, opts) {
    opts = opts || {};
    const start = new THREE.Vector3(fromX, 0, fromZ);
    const end = new THREE.Vector3(toX, 0, toZ);
    const dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    const curlAmount = opts.curl != null ? opts.curl : 0.18;
    const perpx = -dz / len, perpz = dx / len;
    const sign = opts.curlSign || (Math.random() < 0.5 ? -1 : 1);
    const mid = new THREE.Vector3(
      (start.x + end.x) * 0.5 + perpx * curlAmount * len * sign,
      0,
      (start.z + end.z) * 0.5 + perpz * curlAmount * len * sign
    );
    ant.state = 'migrating';
    ant.migTrail = { curve: new THREE.QuadraticBezierCurve3(start, mid, end), length: len };
    ant.migT = opts.tStart != null ? opts.tStart : 0;
    ant.x = start.x; ant.z = start.z;
    ant._idleWritten = false;
    ant._onArrive = opts.onArrive || null;
    // override the default migration speed for snappier scout pacing
    if (opts.speed != null) ant.scriptSpeed = opts.speed;
  };

  // Reset everyone back to idle — used when the lifecycle controller is
  // re-triggered (user clicks Run again).
  A.allIdle = function () {
    for (const a of A.list) {
      if (a.hero) continue; // heroes stay visible
      if (a.permanentDead || (a.agentRecord && (a.agentRecord.status === 'dead' || a.agentRecord.status === 'killed'))) {
        a.state = 'dead';
        a.deadTimer = 0;
        a.outcome = 'culled';
        a.permanentDead = true;
        continue;
      }
      a.state = 'idle';
      a._idleWritten = false;
      a.trail = null; a.t = 0; a.dir = 1; a.cargo = 0;
      a.outcome = null;
    }
  };

  A.antFromHit = function (mesh, instanceId) {
    const ci = A.byMesh[mesh.uuid];
    if (ci === undefined) return null;
    return A.list.find(a => a.ci === ci && a.inst === instanceId) || null;
  };
  A.heroPos = function (a) { return new THREE.Vector3(a.wx || a.x, (a.wy || surf(a.x, a.z)) + 1, a.wz || a.z); };

  return A;
})();
