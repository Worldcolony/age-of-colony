// WorldColony — flora: faceted low-poly trees w/ wind sway, organic rocks/bushes, instanced groundcover
window.DN = window.DN || {};

DN.flora = (function () {
  const F = { windMats: [], treeMats: [], _objs: [] };
  let scene;
  function ground(x, z) { return DN.world.heightAt(x, z); }
  function biome() { return DN.world.biome || DN.biomes[0]; }

  // Tree exclusion zone around each colony so the mound is never buried,
  // but small enough that the colony still feels embedded in forest.
  const CLEAR_R = 30, CLEAR_R2 = CLEAR_R * CLEAR_R;
  function nearColony(x, z) {
    const L = (DN.colony && DN.colony.list) || [];
    for (let i = 0; i < L.length; i++) {
      const dx = x - L[i].pos.x, dz = z - L[i].pos.z;
      if (dx * dx + dz * dz < CLEAR_R2) return true;
    }
    return false;
  }

  function mulberry(a) {
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  // ---- wind sway: instanced uses instanceMatrix phase, single meshes use modelMatrix phase ----
  function makeWindy(mat, amp) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = { value: 0 };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n uniform float uTime;');
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float wph = instanceMatrix[3][0]*0.35 + instanceMatrix[3][2]*0.35;
        #else
          float wph = modelMatrix[3][0]*0.28 + modelMatrix[3][2]*0.28;
        #endif
        float amt = max(transformed.y, 0.0);
        float wsway = sin(uTime*1.5 + wph) * ${amp.toFixed(4)} * amt;
        float wsway2 = cos(uTime*2.1 + wph*1.3) * ${(amp * 0.5).toFixed(4)} * amt;
        transformed.x += wsway;
        transformed.z += wsway2;`);
      mat.userData.sh = sh;
    };
    F.windMats.push(mat);
    return mat;
  }

  // merge a list of {geo, matrix, color} primitives into one flat-shaded vertex-colored geometry
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
  function T(x, y, z, sx, sy, sz, ry) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, 0));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy == null ? sx : sy, sz == null ? sx : sz));
    return m;
  }

  // graceful, trunk-anchored wind with crown flutter + slow gusts
  function makeTreeWindy(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = { value: 0 };
      sh.uniforms.uWind = { value: 1.0 };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n attribute float aSway;\n uniform float uTime;\n uniform float uWind;');
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = modelMatrix[3][0]*0.45 + modelMatrix[3][2]*0.45;
        float bend = (sin(uTime*0.85 + ph) + 0.45*sin(uTime*1.9 + ph*1.7)) * aSway;
        transformed.x += bend * uWind;
        transformed.z += sin(uTime*0.7 + ph*1.2) * aSway * uWind * 0.7;
        transformed.y += sin(uTime*3.4 + position.x*1.3 + position.z*1.1) * aSway*aSway * 0.16 * (0.5 + 0.5*uWind);`);
      mat.userData.sh = sh;
    };
    F.treeMats.push(mat);
    return mat;
  }

  // bake a vertical sun gradient + soft AO into vertex colors, and a per-vertex sway weight
  function applyTreeShade(geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox, minY = bb.min.y, span = Math.max(0.001, bb.max.y - minY);
    const pos = geo.attributes.position, col = geo.attributes.color, nor = geo.attributes.normal;
    const sway = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const h = (pos.getY(i) - minY) / span;
      const grad = 0.74 + 0.40 * h;                 // brighter toward the sun-lit crown
      const ao = 0.80 + 0.20 * (nor.getY(i) * 0.5 + 0.5); // darker undersides
      const f = grad * ao;
      col.setXYZ(i, Math.min(1, col.getX(i) * f), Math.min(1, col.getY(i) * f), Math.min(1, col.getZ(i) * f));
      sway[i] = Math.pow(Math.max(0, Math.min(1, h)), 1.35);
    }
    col.needsUpdate = true;
    geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    return geo;
  }

  function buildTree(seed, kind, fb) {
    const rng = mulberry(seed), parts = [];
    const fol = fb.foliage;
    const fc = i => (rng() < (fb.warmRatio || 0.1) ? fb.warm : fol[i % fol.length]);
    if (kind === 'pine') {
      const tH = 22 + rng() * 16;
      parts.push({ geo: new THREE.CylinderGeometry(tH * 0.035, tH * 0.085, tH, 7), matrix: T(0, tH / 2, 0, 1), color: fb.trunkDark });
      const layers = 6 + Math.floor(rng() * 3);
      for (let i = 0; i < layers; i++) {
        const t = i / (layers - 1), r = 10.5 * (1 - t * 0.82) + 1.8, h = 6.5 * (1 - t * 0.15);
        const y = tH * 0.34 + i * (tH * 0.62 / layers);
        parts.push({ geo: new THREE.ConeGeometry(r, h, 9), matrix: T((rng() - .5) * 0.8, y, (rng() - .5) * 0.8, 1, 1.12, 1, rng() * 6.28), color: fol[i % fol.length] });
      }
      parts.push({ geo: new THREE.ConeGeometry(1.5, 4.2, 8), matrix: T(0, tH + 1.4, 0, 1), color: fol[0] });
    } else {
      const tH = 14 + rng() * 9, lean = (rng() - .5) * 0.12, segs = 4;
      let cx = 0, cz = 0;
      for (let s = 0; s < segs; s++) {
        const t = s / segs, r = tH * 0.12 * (1 - t * 0.55);
        cx += lean * 1.4; cz += (rng() - .5) * 0.55;
        parts.push({ geo: new THREE.CylinderGeometry(r * 0.82, r, tH / segs + 0.7, 7), matrix: T(cx, tH / segs * (s + 0.5), cz, 1), color: s > 1 ? fb.trunk : fb.trunkDark });
      }
      const topX = cx, topZ = cz, topY = tH * 0.96;
      const nb = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < nb; i++) {
        const a = rng() * 6.28, bl = tH * 0.4;
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(topX, topY - 2, topZ), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7 * Math.cos(a), a, 0.7 * Math.sin(a))), new THREE.Vector3(1, 1, 1));
        parts.push({ geo: new THREE.CylinderGeometry(0.18, 0.42, bl, 5), matrix: m, color: fb.trunk });
      }
      const blobs = 8 + Math.floor(rng() * 4), R = 5.5 + rng() * 3;
      for (let i = 0; i < blobs; i++) {
        const a = rng() * 6.28, rr = Math.pow(rng(), 0.6) * R, s = 4 + rng() * 4.5;
        const droop = (rr / R) * 2.2;
        parts.push({ geo: new THREE.IcosahedronGeometry(s, 1), matrix: T(topX + Math.cos(a) * rr, topY + rng() * 5 - droop, topZ + Math.sin(a) * rr, 1, 0.86, 1, rng() * 6.28), color: fc(i) });
      }
      parts.push({ geo: new THREE.IcosahedronGeometry(4 + rng() * 2, 1), matrix: T(topX, topY + 4.6, topZ, 1, 0.92, 1, rng() * 6.28), color: fol[2 % fol.length] });
    }
    const g = mergeGeos(parts); parts.forEach(p => p.geo.dispose());
    return applyTreeShade(g);
  }

  function grassTuftGeo(gb) {
    const b = new THREE.BufferGeometry(), pos = [], col = [], norm = [];
    const base = new THREE.Color(gb.grassDark), tip = new THREE.Color(gb.grassLight);
    function blade(ang) {
      const c = Math.cos(ang), s = Math.sin(ang), w = 0.42, h = 1.0;
      const verts = [[-w, 0, 0], [w, 0, 0], [0, h, 0]], cols = [base, base, tip];
      for (let k = 0; k < 3; k++) { const vv = verts[k]; pos.push(vv[0] * c, vv[1], vv[0] * s); norm.push(0, 1, 0); col.push(cols[k].r, cols[k].g, cols[k].b); }
    }
    blade(0); blade(1.05); blade(2.1);
    b.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    b.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3));
    b.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    return b;
  }

  function add(mesh) { scene.add(mesh); F._objs.push(mesh); return mesh; }

  function scatterInstanced(geo, mat, count, opts) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = !!opts.shadow; mesh.frustumCulled = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 6) {
      tries++;
      const a = Math.random() * 6.28, rr = opts.rMin + Math.pow(Math.random(), opts.bias || 1) * (opts.rMax - opts.rMin);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = ground(x, z);
      if (y < DN.world.WATER_LEVEL + 0.5) continue;
      if (nearColony(x, z)) continue;
      const sc = opts.sMin + Math.random() * (opts.sMax - opts.sMin);
      e.set(0, Math.random() * 6.28, 0); q.setFromEuler(e); s.set(sc, sc * (opts.sy || 1), sc); p.set(x, y, z);
      m.compose(p, q, s); mesh.setMatrixAt(placed, m); placed++;
    }
    mesh.count = placed; mesh.instanceMatrix.needsUpdate = true;
    return add(mesh);
  }

  F.dispose = function () {
    F._objs.forEach(o => { scene.remove(o); if (o.geometry) o.geometry.dispose(); });
    F._objs = []; F.windMats = []; F.treeMats = []; F.trees = [];
  };

  // Remove individual trees + rocks AND hide instanced ground-cover
  // instances within radius of (x, z). Used by colony.foundColony so new
  // mounds don't spawn buried in forest.
  F.clearAround = function (x, z, radius) {
    const r2 = radius * radius;
    const survivors = [];
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
    const _zero = new THREE.Vector3(0, 0, 0);
    for (const o of F._objs) {
      if (o.isInstancedMesh) {
        // Hide per-instance: collapse matrices to zero-scale inside the
        // clearing. Cheap to do once per founding (~thousands of instances).
        let touched = false;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, _m);
          _m.decompose(_p, _q, _s);
          const dx = _p.x - x, dz = _p.z - z;
          if (dx * dx + dz * dz < r2 && _s.x > 0.001) {
            _m.compose(_p, _q, _zero);
            o.setMatrixAt(i, _m);
            touched = true;
          }
        }
        if (touched) o.instanceMatrix.needsUpdate = true;
        survivors.push(o);
        continue;
      }
      const dx = o.position.x - x, dz = o.position.z - z;
      if (dx * dx + dz * dz < r2) {
        scene.remove(o);
        if (o.geometry) o.geometry.dispose();
      } else {
        survivors.push(o);
      }
    }
    F._objs = survivors;
    if (F.trees) F.trees = F.trees.filter(t => {
      const dx = t.position.x - x, dz = t.position.z - z;
      return dx * dx + dz * dz >= r2;
    });
  };

  F.init = function (sceneRef) { if (sceneRef) scene = sceneRef; F.build(); return F; };
  F.rebuild = function () { F.dispose(); F.build(); };

  F.build = function () {
    const b = biome(), fb = b.flora, gb = b.ground;
    F.treeMats = [];
    const treeMat = makeTreeWindy(DN.util.voxelMat({ roughness: 0.78, flatShading: false }));
    F.trees = [];
    const RAD = (DN.world.SIZE * 0.5) - 60;
    const dens = Math.pow(DN.world.SIZE / 360, 2);
    const treeN = Math.round(fb.trees * dens * 0.72);
    for (let i = 0; i < treeN; i++) {
      const a = Math.random() * 6.28, rr = 56 + Math.pow(Math.random(), 0.82) * (RAD - 56);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = ground(x, z);
      if (y < DN.world.WATER_LEVEL + 1) { i--; continue; }
      if (nearColony(x, z)) { i--; continue; }
      const kind = 'pine';
      const tree = new THREE.Mesh(buildTree(2000 + i + b.id.length * 100, kind, fb), treeMat);
      const sc = 0.9 + Math.random() * 0.8;
      tree.scale.setScalar(sc); tree.position.set(x, y - 0.5, z); tree.rotation.y = Math.random() * 6.28;
      tree.rotation.x = (Math.random() - .5) * 0.05; tree.rotation.z = (Math.random() - .5) * 0.05;
      tree.castShadow = true; tree.receiveShadow = true;
      add(tree); F.trees.push(tree);
    }

    // bushes removed — only conifer silhouettes per request

    // ---- distant forest on the skirt: a stripped-down banded pine LOD that
    // matches the silhouette of the detailed buildTree('pine') but skips
    // per-frame wind shader work and trims segment counts. The horizon ring
    // is never inspected closely, so cheap geometry is fine. ----
    {
      const SKIRT_TREE_Y = -1.6; // matches world.js SKIRT_Y
      const inner = DN.world.SIZE * 0.50;
      const outer = 2200;
      // Cheap LOD pine: trunk + 5 banded cones at 6 radial segs (not 9),
      // no wind sway, single static material. Cuts vertex work substantially.
      function buildLodPine(seedOff) {
        const rng = mulberry(7000 + seedOff);
        const parts = [];
        const tH = 22 + rng() * 8;
        parts.push({ geo: new THREE.CylinderGeometry(tH * 0.04, tH * 0.09, tH * 0.36, 5), matrix: T(0, tH * 0.18, 0, 1), color: fb.trunkDark });
        const layers = 5;
        for (let i = 0; i < layers; i++) {
          const t = i / (layers - 1), r = 9.8 * (1 - t * 0.78) + 1.6, h = 6.2 * (1 - t * 0.12);
          const y = tH * 0.34 + i * (tH * 0.62 / layers);
          parts.push({ geo: new THREE.ConeGeometry(r, h, 6), matrix: T(0, y, 0, 1, 1.1, 1, rng() * 6.28), color: fb.foliage[i % fb.foliage.length] });
        }
        parts.push({ geo: new THREE.ConeGeometry(1.4, 3.4, 6), matrix: T(0, tH + 1.2, 0, 1), color: fb.foliage[0] });
        const g = mergeGeos(parts); parts.forEach(p => p.geo.dispose());
        return applyTreeShade(g);
      }
      // Static material — no wind shader at distance.
      const distantMat = DN.util.voxelMat({ roughness: 0.85, flatShading: false });
      const variants = 4;
      const perVariant = 130;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
      for (let v = 0; v < variants; v++) {
        const treeGeo = buildLodPine(v * 31);
        const mesh = new THREE.InstancedMesh(treeGeo, distantMat, perVariant);
        mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
        let placed = 0;
        for (let i = 0; i < perVariant; i++) {
          const a = Math.random() * 6.28;
          const rr = inner + Math.pow(Math.random(), 1.3) * (outer - inner);
          const jx = Math.cos(a) * rr + (Math.random() - 0.5) * 22;
          const jz = Math.sin(a) * rr + (Math.random() - 0.5) * 22;
          const sc = 0.9 + Math.random() * 0.6;
          e.set(0, Math.random() * 6.28, 0); q.setFromEuler(e);
          sv.set(sc, sc * (0.94 + Math.random() * 0.14), sc);
          pv.set(jx, SKIRT_TREE_Y - 0.5, jz);
          m.compose(pv, q, sv);
          mesh.setMatrixAt(placed++, m);
        }
        mesh.count = placed; mesh.instanceMatrix.needsUpdate = true;
        add(mesh);
      }
    }

    // rocks (low-poly icos/dodeca)
    const rockMat = DN.util.voxelMat({ roughness: 1.0, flatShading: true });
    for (let i = 0; i < Math.round(fb.rocks * dens * 0.55); i++) {
      const a = Math.random() * 6.28, rr = 24 + Math.random() * (RAD - 10);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = ground(x, z);
      if (nearColony(x, z)) continue;
      const parts = []; const chunks = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < chunks; k++) { const s = 1.4 + Math.random() * 3.6; parts.push({ geo: (k % 2 ? new THREE.DodecahedronGeometry(s, 0) : new THREE.IcosahedronGeometry(s, 0)), matrix: T((Math.random() - .5) * 3, s * 0.4 + k * 0.7, (Math.random() - .5) * 3, 1, 0.7, 1, Math.random() * 6.28), color: [gb.rock, gb.rockLight, gb.rockDark][k % 3] }); }
      const g = mergeGeos(parts); parts.forEach(p => p.geo.dispose());
      const rock = new THREE.Mesh(g, rockMat); rock.position.set(x, y, z); rock.castShadow = true; rock.receiveShadow = true; add(rock);
    }

    // grass
    const grassMat = makeWindy(DN.util.voxelMat({ side: THREE.DoubleSide, roughness: 1.0 }), 0.16);
    F.grass = scatterInstanced(grassTuftGeo(gb), grassMat, Math.round(fb.grass * dens * 0.7), { rMin: 12, rMax: RAD, sMin: 0.5, sMax: 1.05, bias: 0.85 });

    // flowers
    const flowerCols = [0xE8C84A, 0xE2705A, 0xCF6FB0, 0xFFFFFF, 0xE89B3B];
    flowerCols.forEach(col => {
      const fbb = new DN.util.VoxelBuilder();
      fbb.box([0.18, 1.3, 0.18], [0, 0.65, 0], gb.grassDark); fbb.box([0.7, 0.35, 0.7], [0, 1.4, 0], col); fbb.box([0.32, 0.3, 0.32], [0, 1.55, 0], 0xFFE6A0);
      const fmat = makeWindy(DN.util.voxelMat({ side: THREE.DoubleSide }), 0.1);
      scatterInstanced(fbb.geometry(), fmat, Math.round(fb.flowers / 5 * dens) || 1, { rMin: 14, rMax: RAD * 0.92, sMin: 0.9, sMax: 1.7, bias: 0.9 });
    });

    // mushrooms (rounded caps)
    const mushCols = [0xD96E54, 0xE3A53C, 0xEDE6D2];
    mushCols.forEach(col => {
      const parts = [{ geo: new THREE.CylinderGeometry(0.22, 0.3, 0.7, 6), matrix: T(0, 0.35, 0, 1), color: 0xEDE6D2 }, { geo: new THREE.SphereGeometry(0.62, 8, 5, 0, 6.28, 0, 1.4), matrix: T(0, 0.7, 0, 1), color: col }];
      const g = mergeGeos(parts); parts.forEach(p => p.geo.dispose());
      scatterInstanced(g, DN.util.voxelMat({ flatShading: true }), Math.round(fb.mush / 3 * dens) || 1, { rMin: 26, rMax: RAD * 0.92, sMin: 0.7, sMax: 1.6, bias: 1.1 });
    });

    // ferns
    const fernMat = makeWindy(DN.util.voxelMat({ side: THREE.DoubleSide, roughness: 1.0 }), 0.12);
    scatterInstanced(grassTuftGeo(gb), fernMat, Math.round(fb.ferns * dens * 0.7), { rMin: 30, rMax: RAD, sMin: 1.8, sMax: 3.4, sy: 1.4, bias: 0.9 });
  };

  F.update = function (dt, elapsed) {
    for (const m of F.windMats) { const sh = m.userData.sh; if (sh) sh.uniforms.uTime.value = elapsed; }
    const wind = 1.0 + 0.45 * Math.sin(elapsed * 0.22) + 0.22 * Math.sin(elapsed * 0.07 + 1.3);
    for (const m of F.treeMats) { const sh = m.userData.sh; if (sh) { sh.uniforms.uTime.value = elapsed; sh.uniforms.uWind.value = wind; } }
  };

  return F;
})();
