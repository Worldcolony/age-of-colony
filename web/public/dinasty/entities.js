// WorldColony — colonies (clustered glowing nodes) + resources
window.DN = window.DN || {};

DN.entities = (function () {
  const E = { colonies: [], resources: [], _rid: 0 };
  let scene, group;

  const COLONY_DEFS = [
    { name: 'Verdana Prime', accent: 0x2EFF7A, angle: -0.5, dist: 62 },
    { name: 'Cobalt Reach', accent: 0x3ABEFF, angle: 2.2, dist: 78 },
    { name: 'Amberfall', accent: 0xFFB84D, angle: 3.7, dist: 58 },
    { name: 'Greywarren', accent: 0x9AA0A6, angle: 5.2, dist: 86 }
  ];

  function ground(x, z) { return DN.world.heightAt(x, z); }

  function makeColony(def, idx) {
    const cx = Math.cos(def.angle) * def.dist;
    const cz = Math.sin(def.angle) * def.dist;
    const cy = ground(cx, cz);
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);

    const accent = new THREE.Color(def.accent);

    // soft accent footprint on the ground so the colony reads from above
    const footGeo = new THREE.CircleGeometry(14, 48);
    footGeo.rotateX(-Math.PI / 2);
    const foot = new THREE.Mesh(footGeo, new THREE.MeshBasicMaterial({
      map: DN.util.softSprite(), color: accent, transparent: true,
      opacity: 0.14, depthWrite: false
    }));
    foot.position.y = cy + 0.4;
    foot.renderOrder = 1;
    g.add(foot);

    // central mound
    const moundGeo = new THREE.IcosahedronGeometry(7.2, 1);
    // squash to a dome + roughen
    moundGeo.scale(1, 0.62, 1);
    const mp = moundGeo.attributes.position;
    let mn = new DNNoise(100 + idx);
    for (let i = 0; i < mp.count; i++) {
      const x = mp.getX(i), y = mp.getY(i), z = mp.getZ(i);
      const f = 1 + mn.n3(x * 0.25, y * 0.25, z * 0.25) * 0.18;
      mp.setXYZ(i, x * f, y * f, z * f);
    }
    moundGeo.computeVertexNormals();
    const moundMat = new THREE.MeshStandardMaterial({ color: 0xB3A88E, roughness: 0.95, flatShading: true });
    const mound = new THREE.Mesh(moundGeo, moundMat);
    mound.position.y = cy + 1.6;
    mound.castShadow = true; mound.receiveShadow = true;
    g.add(mound);

    // glowing crater core
    const coreGeo = new THREE.CircleGeometry(2.6, 24);
    coreGeo.rotateX(-Math.PI / 2);
    const coreMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85 });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = cy + 5.4;
    g.add(core);
    // soft core glow sprite
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: DN.util.softSprite(), color: accent, transparent: true,
      opacity: 0.4, depthWrite: false, blending: THREE.NormalBlending
    }));
    glow.scale.set(13, 13, 1);
    glow.position.y = cy + 6;
    g.add(glow);

    // satellite nodes (the cluster)
    const nodes = [];
    const nodeMat = new THREE.MeshStandardMaterial({ color: 0xBBB096, roughness: 0.92, flatShading: true });
    const nNodes = 5 + (idx % 2);
    const nodeWorld = [];
    for (let i = 0; i < nNodes; i++) {
      const a = (i / nNodes) * Math.PI * 2 + idx;
      const rr = 11 + (i % 2) * 5 + Math.sin(i * 2.1) * 2;
      const nx = Math.cos(a) * rr, nz = Math.sin(a) * rr;
      const ny = ground(cx + nx, cz + nz);
      const sz = 1.5 + (i % 3) * 0.7;
      const nGeo = new THREE.IcosahedronGeometry(sz, 0);
      nGeo.scale(1, 0.7, 1);
      const nm = new THREE.Mesh(nGeo, nodeMat);
      nm.position.set(nx, ny + sz * 0.5, nz);
      nm.castShadow = true; nm.receiveShadow = true;
      g.add(nm);
      // little accent pip on top
      const pip = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 10, 10),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.7 })
      );
      pip.position.set(nx, ny + sz + 0.6, nz);
      g.add(pip);
      nodes.push(nm);
      nodeWorld.push(new THREE.Vector3(cx + nx, ny + sz, cz + nz));
    }

    // thin connections from centre to nodes
    const linePts = [];
    for (let i = 0; i < nodeWorld.length; i++) {
      linePts.push(new THREE.Vector3(cx, cy + 5, cz));
      linePts.push(nodeWorld[i].clone());
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.22 });
    const links = new THREE.LineSegments(lineGeo, lineMat);
    g.add(links);

    // expansion ring (shown when selected)
    const ringGeo = new THREE.RingGeometry(15, 16.2, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = cy + 0.6;
    g.add(ring);

    // invisible pick target
    const pickGeo = new THREE.SphereGeometry(14, 16, 16);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    const pick = new THREE.Mesh(pickGeo, pickMat);
    pick.position.y = cy + 5;
    g.add(pick);

    group.add(g);

    const colony = {
      id: 'col-' + idx,
      name: def.name,
      accent: def.accent,
      pos: new THREE.Vector3(cx, cy, cz),
      corePos: new THREE.Vector3(cx, cy + 6, cz),
      nodesWorld: nodeWorld,
      group: g, mound, core, glow, ring, links, lineMat,
      directive: 'forage',
      stats: {
        population: 120 + Math.round(Math.random() * 140),
        health: 72 + Math.round(Math.random() * 22),
        food: 40 + Math.round(Math.random() * 45),
        births: 0
      },
      selected: false,
      _t: Math.random() * 10
    };
    pick.userData.colony = colony;
    mound.userData.colony = colony;
    colony.pickTarget = pick;
    return colony;
  }

  E.init = function (sceneRef) {
    scene = sceneRef;
    group = new THREE.Group();
    scene.add(group);

    COLONY_DEFS.forEach((d, i) => E.colonies.push(makeColony(d, i)));

    // subtle inter-colony network (nearest neighbour links)
    const netPts = [];
    for (let i = 0; i < E.colonies.length; i++) {
      const a = E.colonies[i];
      let best = -1, bd = Infinity;
      for (let j = 0; j < E.colonies.length; j++) {
        if (i === j) continue;
        const d = a.pos.distanceTo(E.colonies[j].pos);
        if (d < bd) { bd = d; best = j; }
      }
      const b = E.colonies[best];
      netPts.push(new THREE.Vector3(a.pos.x, a.pos.y + 5, a.pos.z));
      netPts.push(new THREE.Vector3(b.pos.x, b.pos.y + 5, b.pos.z));
    }
    const netGeo = new THREE.BufferGeometry().setFromPoints(netPts);
    const netMat = new THREE.LineBasicMaterial({ color: DN.palette.ink, transparent: true, opacity: 0.08 });
    E.network = new THREE.LineSegments(netGeo, netMat);
    scene.add(E.network);

    // initial scattered resources
    const rNoise = new DNNoise(57);
    for (let i = 0; i < 7; i++) {
      const a = rNoise.n2(i * 2.1, 3.3) * Math.PI * 4;
      const d = 40 + Math.abs(rNoise.n2(i, i * 1.7)) * 70;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      E.spawnResource(x, z, 60 + Math.round(Math.random() * 60), true);
    }
    return E;
  };

  E.spawnResource = function (x, z, amount, silent) {
    const y = ground(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const amber = new THREE.Color(DN.palette.amber);
    // low-poly crystal cluster
    const nShards = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nShards; i++) {
      const h = 2.2 + Math.random() * 3.4;
      const geo = new THREE.ConeGeometry(0.9 + Math.random() * 0.6, h, 5);
      const mat = new THREE.MeshStandardMaterial({
        color: amber, roughness: 0.4, metalness: 0.1,
        emissive: amber, emissiveIntensity: 0.35, flatShading: true
      });
      const m = new THREE.Mesh(geo, mat);
      const a = (i / nShards) * Math.PI * 2;
      m.position.set(Math.cos(a) * 1.2, h * 0.5, Math.sin(a) * 1.2);
      m.rotation.z = (Math.random() - 0.5) * 0.5;
      m.castShadow = true;
      g.add(m);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: DN.util.softSprite(), color: amber, transparent: true,
      opacity: 0.4, depthWrite: false, blending: THREE.NormalBlending
    }));
    glow.scale.set(9, 9, 1);
    glow.position.y = 3;
    g.add(glow);
    // pick target
    const pick = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 12), new THREE.MeshBasicMaterial({ visible: false }));
    pick.position.y = 3;
    g.add(pick);

    group.add(g);
    const res = {
      id: 'res-' + (E._rid++),
      pos: new THREE.Vector3(x, y, z),
      topPos: new THREE.Vector3(x, y + 3, z),
      amount: amount, max: amount,
      group: g, glow, depleted: false,
      _spawnT: silent ? 1 : 0
    };
    pick.userData.resource = res;
    glow.userData.resource = res;
    res.pickTarget = pick;
    E.resources.push(res);
    return res;
  };

  // pickable meshes for raycasting
  E.pickables = function () {
    const arr = [];
    E.colonies.forEach(c => arr.push(c.pickTarget));
    E.resources.forEach(r => { if (!r.depleted) arr.push(r.pickTarget); });
    return arr;
  };

  E.update = function (dt, elapsed) {
    // colony breathing glow + selected ring pulse
    E.colonies.forEach(c => {
      c._t += dt;
      const pulse = 0.32 + Math.sin(c._t * 1.3) * 0.06;
      c.glow.material.opacity = c.selected ? pulse + 0.18 : pulse;
      const baseScale = c.selected ? 16 : 13;
      const s = baseScale + Math.sin(c._t * 1.3) * 1.0;
      c.glow.scale.set(s, s, 1);
      c.core.material.opacity = 0.7 + Math.sin(c._t * 2) * 0.12;
      if (c.selected) {
        c.ring.material.opacity = Math.min(0.5, c.ring.material.opacity + dt * 1.5);
        c.ring.rotation.y += dt * 0.3;
      } else {
        c.ring.material.opacity = Math.max(0, c.ring.material.opacity - dt * 2);
      }
      c.links.material.opacity = 0.18 + Math.sin(c._t * 1.1) * 0.06;
    });
    // resource grow-in + spin glow + depletion fade
    E.resources.forEach(r => {
      if (r._spawnT < 1) {
        r._spawnT = Math.min(1, r._spawnT + dt * 2);
        const e = 1 - Math.pow(1 - r._spawnT, 3);
        r.group.scale.setScalar(e);
      }
      r.glow.material.opacity = 0.35 + Math.sin(elapsed * 2 + r.pos.x) * 0.1;
      if (r.amount <= 0 && !r.depleted) {
        r.depleted = true;
      }
      if (r.depleted) {
        const s = r.group.scale.x;
        if (s > 0.001) r.group.scale.setScalar(Math.max(0, s - dt * 0.8));
        r.glow.material.opacity *= 0.9;
      } else {
        // scale shards with remaining amount a touch
        const frac = 0.55 + 0.45 * (r.amount / r.max);
        r.group.scale.setScalar(Math.max(r.group.scale.x, 0) ); // keep grow-in authoritative
      }
    });
    // clean up fully depleted
    E.resources = E.resources.filter(r => {
      if (r.depleted && r.group.scale.x <= 0.002) { group.remove(r.group); return false; }
      return true;
    });
  };

  // nearest active resource to a colony (for foraging)
  E.nearestResource = function (pos) {
    let best = null, bd = Infinity;
    E.resources.forEach(r => {
      if (r.depleted || r.amount <= 0) return;
      const d = pos.distanceTo(r.pos);
      if (d < bd) { bd = d; best = r; }
    });
    return best;
  };

  return E;
})();
