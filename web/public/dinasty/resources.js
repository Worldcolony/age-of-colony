// WorldColony — forage resources: voxel leaf/crystal caches the ants gather
window.DN = window.DN || {};

DN.resources = (function () {
  const R = { list: [], _id: 0 };
  let scene;
  const P = DN.palette;
  function ground(x, z) { return DN.world.heightAt(x, z); }

  function buildCache(kind, accent) {
    const b = new DN.util.VoxelBuilder();
    if (kind === 'crystal') {
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.28, h = 1.4 + Math.random() * 1.8;
        b.box([0.8, h, 0.8], [Math.cos(a) * 0.9, h * 0.5, Math.sin(a) * 0.9], accent, { axis: 'z', a: (Math.random() - .5) * 0.5 });
      }
    } else {
      // berry / leaf pile
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * 6.28, rr = Math.random() * 1.4;
        b.box([0.7, 0.7, 0.7], [Math.cos(a) * rr, 0.4 + Math.random() * 0.8, Math.sin(a) * rr], i % 2 ? P.foliage : 0xC23B3B);
      }
    }
    return b.geometry();
  }

  R.init = function (sceneRef) {
    scene = sceneRef;
    const nz = new DNNoise(57);
    for (let i = 0; i < 16; i++) {
      const a = nz.n2(i * 2.1, 3.3) * 6.28 * 2;
      const d = 56 + Math.abs(nz.n2(i, i * 1.7)) * 230;
      R.spawn(Math.cos(a) * d, Math.sin(a) * d, 60 + Math.round(Math.random() * 70), true);
    }
    return R;
  };

  R.spawn = function (x, z, amount, silent) {
    const y = ground(x, z);
    if (y < DN.world.WATER_LEVEL + 0.4) return null;
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const kind = Math.random() < 0.55 ? 'crystal' : 'leaf';
    const accent = [0x66C6E0, 0xE8C24A, 0xB07BD0][Math.floor(Math.random() * 3)];
    const mesh = new THREE.Mesh(buildCache(kind, accent), DN.util.voxelMat({ roughness: kind === 'crystal' ? 0.3 : 0.9, emissive: kind === 'crystal' ? new THREE.Color(accent) : new THREE.Color(0), emissiveIntensity: kind === 'crystal' ? 0.3 : 0 }));
    mesh.castShadow = true;
    g.add(mesh);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: DN.util.softSprite(), color: accent, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(7, 7, 1); glow.position.y = 2.2;
    g.add(glow);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(3.5, 12, 10), new THREE.MeshBasicMaterial({ visible: false }));
    pick.position.y = 2;
    g.add(pick);
    scene.add(g);
    const res = {
      id: 'res-' + (R._id++), pos: new THREE.Vector3(x, y, z),
      amount, max: amount, group: g, glow, mesh, depleted: false,
      pickTarget: pick, _grow: silent ? 1 : 0, kind, accent
    };
    pick.userData.resource = res;
    res.group.scale.setScalar(silent ? 1 : 0.01);
    R.list.push(res);
    return res;
  };

  R.nearest = function (pos) {
    let best = null, bd = Infinity;
    for (const r of R.list) {
      if (r.depleted || r.amount <= 0) continue;
      const d = pos.distanceTo(r.pos);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  };

  R.update = function (dt, elapsed) {
    for (const r of R.list) {
      if (r._grow < 1) { r._grow = Math.min(1, r._grow + dt * 2); r.group.scale.setScalar(1 - Math.pow(1 - r._grow, 3)); }
      r.glow.material.opacity = 0.35 + Math.sin(elapsed * 2 + r.pos.x) * 0.1;
      if (r.amount <= 0 && !r.depleted) r.depleted = true;
      if (r.depleted) { const s = r.group.scale.x; if (s > 0.01) r.group.scale.setScalar(Math.max(0, s - dt * 0.7)); r.glow.material.opacity *= 0.9; }
    }
    R.list = R.list.filter(r => {
      if (r.depleted && r.group.scale.x <= 0.02) { scene.remove(r.group); return false; }
      return true;
    });
  };

  R.pickables = function () { return R.list.filter(r => !r.depleted).map(r => r.pickTarget); };

  return R;
})();
