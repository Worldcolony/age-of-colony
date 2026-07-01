// WorldColony — Queen ant: the player's avatar on the world map.
// Modeled after real ant queens (gynes): reddish chitin, dramatically
// enlarged segmented gaster, wing scars from her nuptial flight, three
// dorsal ocelli, royal pheromone aura, and a slow steady egg-laying
// cadence. Spawns on wallet connect with the wallet's accent crown.
window.DN = window.DN || {};

DN.queen = (function () {
  const Q = {
    group: null,
    target: new THREE.Vector3(0, 0, 0),
    facing: 0,
    targetFacing: 0,
    moving: false,
    wobble: 0,
    legSwing: 0,
    age: 0,
    lastEggT: 0,
    eggs: [],         // active visual egg sprites
    pheromones: [],   // active visual pheromone puffs
    stats: {
      caste: 'Queen',
      wings: 'Dealate',   // lost wings after the nuptial flight
      eggs: 0,
      pheromone: 0.92,    // [0..1] strength
      fertility: 1.0,
      ageSol: 0
    }
  };
  let scene = null;
  let accent = 0xE8C24A;

  function ground(x, z) {
    return DN.world && DN.world.heightAt ? DN.world.heightAt(x, z) : 0;
  }

  function flat(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color: color, roughness: 0.7, flatShading: true }, opts || {}));
  }

  function buildQueen(accentHex) {
    const g = new THREE.Group();
    // Real queens are mahogany/reddish-brown rather than the workers'
    // matte black. The palette below gives her that "Camponotus queen"
    // look while still reading clearly against the warm world.
    const carapace = 0x2A0F0A;        // primary chitin
    const carapaceDark = 0x150503;    // shadow / intersegment
    const carapaceLight = 0x4A1F1A;   // dorsal highlight
    const sheen = 0x7A3320;           // sunlit dorsal stripe
    const head = 0x230B07;
    const eyeGold = 0xFFE6A0;
    const ocelliGold = 0xFFD060;
    const wingScarMat = flat(0x0e0805, { roughness: 0.4, metalness: 0.15 });
    const crownMat = flat(accentHex, { emissive: new THREE.Color(accentHex), emissiveIntensity: 0.55, metalness: 0.25, roughness: 0.32 });
    const carapaceMat = flat(carapace);
    const carapaceDarkMat = flat(carapaceDark);
    const carapaceLightMat = flat(carapaceLight, { roughness: 0.55 });
    const sheenMat = flat(sheen, { roughness: 0.45 });
    const headMat = flat(head);
    const eyeMat = flat(eyeGold, { emissive: eyeGold, emissiveIntensity: 0.75, roughness: 0.25 });
    const ocelliMat = flat(ocelliGold, { emissive: ocelliGold, emissiveIntensity: 0.85 });
    const legMat = flat(carapaceDark);

    // -------- GASTER (abdomen) -------------------------------------
    // 4 stacked segments, each smaller toward the tip. Intersegmental
    // ridges (thin dark bands) sell the chitin look. This is what makes
    // queens *visually* queens — a real gyne's gaster is enormous.
    const segments = [
      { r: 1.55, z: -2.30, y: 1.15, color: carapaceMat,      scaleY: 1.05, scaleZ: 1.65 },
      { r: 1.45, z: -1.55, y: 1.20, color: carapaceMat,      scaleY: 1.05, scaleZ: 1.30 },
      { r: 1.30, z: -0.85, y: 1.25, color: carapaceLightMat, scaleY: 1.00, scaleZ: 1.10 },
      { r: 1.10, z: -0.30, y: 1.30, color: carapaceLightMat, scaleY: 0.95, scaleZ: 0.95 }
    ];
    segments.forEach((s, i) => {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(s.r, 14, 10), s.color);
      sphere.position.set(0, s.y, s.z);
      sphere.scale.set(1, s.scaleY, s.scaleZ);
      g.add(sphere);
      // intersegment ridge (thin dark torus between adjacent segments)
      if (i < segments.length - 1) {
        const ridge = new THREE.Mesh(new THREE.TorusGeometry(s.r * 0.7, 0.08, 4, 14), carapaceDarkMat);
        const next = segments[i + 1];
        const mz = (s.z + next.z) / 2;
        const my = (s.y + next.y) / 2;
        ridge.position.set(0, my, mz);
        ridge.rotation.x = Math.PI / 2;
        ridge.scale.set(1, 1, 0.18);
        g.add(ridge);
      }
    });
    // Dorsal sheen stripe down the back — catches the sun, reads royal.
    const sheenStripe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 3.6), sheenMat);
    sheenStripe.position.set(0, 2.05, -1.4);
    g.add(sheenStripe);

    // -------- PETIOLE & POSTPETIOLE -------------------------------
    // The thin waist segments that connect gaster to thorax.
    const petiole = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.55, 0.42), carapaceDarkMat);
    petiole.position.set(0, 1.20, 0.30);
    g.add(petiole);
    const postPetiole = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), carapaceDarkMat);
    postPetiole.position.set(0, 1.30, 0.65);
    g.add(postPetiole);

    // -------- THORAX (mesosoma) -----------------------------------
    // Bulkier than a worker's because of the wing-muscle attachment
    // points she kept from her flight days.
    const thorax = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.20, 1.30), carapaceMat);
    thorax.position.set(0, 1.45, 1.30);
    g.add(thorax);
    // Pronotal hump (sclerite ridge on top of thorax)
    const hump = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.30, 0.85), carapaceLightMat);
    hump.position.set(0, 2.10, 1.30);
    g.add(hump);

    // -------- WING SCARS ------------------------------------------
    // After mating, queens chew or rub their wings off. The scars
    // remain as polished darker plates on the thorax — a hallmark of
    // a dealate (post-nuptial) queen.
    function wingScar(side) {
      const scar = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.62), wingScarMat);
      scar.position.set(side * 0.46, 2.20, 1.30);
      scar.rotation.z = side * -0.18;
      scar.rotation.y = side * 0.20;
      return scar;
    }
    g.add(wingScar(-1));
    g.add(wingScar(1));

    // -------- HEAD ------------------------------------------------
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10), headMat);
    headM.position.set(0, 1.55, 2.40);
    headM.scale.set(1.10, 1.00, 1.20);
    g.add(headM);

    // Mandibles — small dark cones angled forward
    const mandibleMat = carapaceDarkMat;
    const m1 = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.50, 4), mandibleMat);
    m1.position.set(-0.22, 1.42, 3.10); m1.rotation.x = -Math.PI / 2; m1.rotation.z = 0.32;
    g.add(m1);
    const m2 = m1.clone(); m2.position.x = 0.22; m2.rotation.z = -0.32; g.add(m2);

    // Compound eyes — larger than a worker's, golden-amber glow
    const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), eyeMat);
    e1.position.set(-0.48, 1.70, 2.85); g.add(e1);
    const e2 = e1.clone(); e2.position.x = 0.48; g.add(e2);

    // OCELLI — three tiny simple-eyes in a triangle on top of head.
    // Many queens have them; workers usually don't. Crucial detail.
    function ocellus(x, z) {
      const o = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 5), ocelliMat);
      o.position.set(x, 2.05, z);
      return o;
    }
    g.add(ocellus( 0.00, 2.20));
    g.add(ocellus(-0.15, 2.45));
    g.add(ocellus( 0.15, 2.45));

    // -------- ANTENNAE -------------------------------------------
    function antenna(side) {
      const ag = new THREE.Group();
      const scape = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.10, 5), carapaceDarkMat);
      scape.position.set(0, 0.45, 0); scape.rotation.z = side * 0.35; scape.rotation.x = -0.5;
      ag.add(scape);
      const funicle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.85, 5), carapaceDarkMat);
      funicle.position.set(side * 0.40, 1.05, 0.55); funicle.rotation.z = side * 0.55; funicle.rotation.x = -0.95;
      ag.add(funicle);
      const club = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), crownMat);
      club.position.set(side * 0.62, 1.35, 0.95);
      ag.add(club);
      ag.position.set(side * 0.32, 1.85, 2.60);
      return ag;
    }
    g.add(antenna(-1)); g.add(antenna(1));

    // -------- CROWN ---------------------------------------------
    const crownBase = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.20, 12), crownMat);
    crownBase.position.set(0, 2.55, 2.30); g.add(crownBase);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.62, 4), crownMat);
      spike.position.set(Math.cos(a) * 0.46, 2.96, 2.30 + Math.sin(a) * 0.46);
      g.add(spike);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), crownMat);
    gem.position.set(0, 3.30, 2.30); gem.userData.gem = true;
    g.add(gem);

    // -------- ROYAL AURA (sprite) -------------------------------
    const auraTex = (DN.util && DN.util.softSprite) ? DN.util.softSprite() : null;
    if (auraTex) {
      const aura = new THREE.Sprite(new THREE.SpriteMaterial({
        map: auraTex, color: accentHex, transparent: true, opacity: 0.30,
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
      aura.scale.set(6.5, 6.5, 1);
      aura.position.set(0, 2.4, 0);
      g.add(aura);
      g.userData.aura = aura;
    }

    // -------- LEGS (6) ------------------------------------------
    const legs = [];
    for (let i = 0; i < 3; i++) {
      const z = 0.45 + i * 0.45;
      [-1, 1].forEach(side => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.5, 5), legMat);
        leg.position.set(side * 0.78, 0.75, z);
        leg.rotation.z = side * (0.45 + i * 0.05);
        leg.userData.basePos = leg.position.clone();
        leg.userData.side = side;
        leg.userData.phase = i / 3 + (side < 0 ? 0.5 : 0);
        g.add(leg);
        legs.push(leg);
      });
    }
    g.userData.legs = legs;
    g.userData.gem  = gem;
    g.userData.crown = crownBase;
    return g;
  }

  // ---------- egg + pheromone particle helpers -------------------
  function spawnEgg() {
    if (!Q.group || !scene) return;
    const eggMat = new THREE.MeshStandardMaterial({
      color: 0xFFF1C8, emissive: 0xFFE7A8, emissiveIntensity: 0.35,
      roughness: 0.35, flatShading: true
    });
    const egg = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), eggMat);
    egg.scale.set(0.85, 1.05, 0.85);
    // place egg just behind the queen at her current position
    const behind = new THREE.Vector3(Math.sin(Q.facing), 0, Math.cos(Q.facing)).multiplyScalar(1.6);
    egg.position.set(Q.group.position.x + behind.x, ground(Q.group.position.x + behind.x, Q.group.position.z + behind.z) + 0.22, Q.group.position.z + behind.z);
    egg._t = 0;
    egg._life = 7.0;
    scene.add(egg);
    Q.eggs.push(egg);
    Q.stats.eggs += 1;
    // little dust puff as if she just laid it
    spawnPheromone(egg.position.x, egg.position.z, 0xFFF1C8, 0.7);
  }

  function spawnPheromone(x, z, color, opacityBoost) {
    if (!scene) return;
    const tex = (DN.util && DN.util.softSprite) ? DN.util.softSprite() : null;
    if (!tex) return;
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: (color != null ? color : accent),
      transparent: true, opacity: 0.45 * (opacityBoost || 1),
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    puff.scale.set(2.6, 2.6, 1);
    puff.position.set(x, ground(x, z) + 0.7, z);
    puff._t = 0;
    puff._life = 1.4;
    scene.add(puff);
    Q.pheromones.push(puff);
  }

  // ---------- public API -----------------------------------------
  Q.spawn = function (sceneRef, accentHex) {
    scene = sceneRef;
    if (!scene) return Q;
    if (Q.group) { scene.remove(Q.group); Q.group = null; }
    accent = (accentHex != null) ? accentHex : 0xE8C24A;
    Q.group = buildQueen(accent);
    Q.group.scale.set(0.4, 0.4, 0.4);
    Q.group.position.set(0, ground(0, 0), 0);
    Q.target.copy(Q.group.position);
    scene.add(Q.group);
    // reset transient state
    Q.eggs.forEach(e => scene.remove(e)); Q.eggs.length = 0;
    Q.pheromones.forEach(p => scene.remove(p)); Q.pheromones.length = 0;
    Q.age = 0; Q.lastEggT = 0;
    Q.stats.eggs = 0; Q.stats.ageSol = 0;
    return Q;
  };

  Q.setVisible = function (v) { if (Q.group) Q.group.visible = !!v; };
  Q.position = function () { return Q.group ? Q.group.position : null; };
  Q.has = function () { return !!Q.group; };

  Q.moveTo = function (x, z, facing) {
    Q.target.set(x, ground(x, z), z);
    if (typeof facing === 'number') Q.targetFacing = facing;
    Q.moving = true;
  };

  Q.update = function (dt, elapsed) {
    if (!Q.group) return;
    Q.age += dt;
    Q.stats.ageSol = Q.age / 200; // matches App.S.DAY

    // ---- body motion ------------------------------------------
    const cur = Q.group.position;
    const prevX = cur.x, prevZ = cur.z;
    cur.lerp(Q.target, Math.min(1, dt * 6));
    cur.y = ground(cur.x, cur.z);
    Q.wobble += dt * 5;
    cur.y += Math.sin(Q.wobble) * 0.05;
    const moveDist = Math.hypot(cur.x - prevX, cur.z - prevZ);
    const speed = moveDist / Math.max(1e-4, dt);
    Q.moving = speed > 1.2;

    // smooth facing
    let df = Q.targetFacing - Q.facing;
    while (df >  Math.PI) df -= Math.PI * 2;
    while (df < -Math.PI) df += Math.PI * 2;
    Q.facing += df * Math.min(1, dt * 8);
    Q.group.rotation.y = Q.facing;

    // ---- leg gait ---------------------------------------------
    // Queens walk *slower* than workers — their gaster is heavy. We
    // tone the swing rate way down so the gait reads regal.
    const legs = Q.group.userData.legs || [];
    const swing = Q.moving ? 0.45 : 0.10;
    const rate  = Q.moving ? 7 : 2.2;
    Q.legSwing += dt * rate;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const ph = Q.legSwing + leg.userData.phase * Math.PI * 2;
      const offz = Math.sin(ph) * swing * 0.20;
      const offy = Math.max(0, Math.sin(ph) * swing * 0.13);
      leg.position.set(
        leg.userData.basePos.x,
        leg.userData.basePos.y + offy,
        leg.userData.basePos.z + offz
      );
    }
    // gem & crown twinkle
    const gem = Q.group.userData.gem;
    if (gem) gem.rotation.y = elapsed * 1.4;
    const aura = Q.group.userData.aura;
    if (aura) {
      aura.material.opacity = 0.22 + Math.sin(elapsed * 1.7) * 0.06;
    }

    // ---- egg laying -------------------------------------------
    // A real Camponotus queen can lay tens per day. We pace it to
    // ~one every 8 seconds of sim time so the world stays readable.
    if (Q.age - Q.lastEggT > 8.0) {
      Q.lastEggT = Q.age;
      spawnEgg();
    }
    // age out eggs
    for (let i = Q.eggs.length - 1; i >= 0; i--) {
      const e = Q.eggs[i]; e._t += dt;
      const k = e._t / e._life;
      e.material.opacity = 1.0;
      e.material.emissiveIntensity = 0.35 + Math.sin(e._t * 4) * 0.15;
      // settle and slowly fade after life is up
      if (k > 0.75) {
        e.scale.setScalar(0.85 * (1 - (k - 0.75) / 0.25));
      }
      if (e._t > e._life) {
        scene.remove(e); e.geometry.dispose(); e.material.dispose();
        Q.eggs.splice(i, 1);
      }
    }

    // ---- pheromone trail when walking -----------------------
    if (Q.moving && Math.random() < dt * 4) {
      spawnPheromone(cur.x, cur.z, accent, 0.9);
    }
    for (let i = Q.pheromones.length - 1; i >= 0; i--) {
      const p = Q.pheromones[i]; p._t += dt;
      const k = p._t / p._life;
      p.material.opacity = Math.max(0, (1 - k) * 0.45);
      p.scale.setScalar(2.6 + k * 1.4);
      p.position.y += dt * 0.4;
      if (p._t > p._life) {
        scene.remove(p); p.material.dispose();
        Q.pheromones.splice(i, 1);
      }
    }
  };

  // Exposed factory so remote-player ("ghost") queens can reuse the same
  // mesh template. Returns a fresh THREE.Group not bound to the singleton.
  Q.buildMesh = function (accentHex) { return buildQueen(accentHex); };

  return Q;
})();
