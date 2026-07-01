// WorldColony — knowledge crystal: a single procedural icosahedron at the
// world origin that grows as scouts return findings. Owned by the
// lifecycle controller; not visible until DN.crystal.show() is called.
window.DN = window.DN || {};

DN.crystal = (function () {
  const C = { _scene: null, _mesh: null, _halo: null, _deposits: 0, _scale: 0 };
  const POSITION = new THREE.Vector3(0, 0, 0); // world origin
  const PEAK_RADIUS = 8.0;      // ← smaller so converging ants visually dominate
  const HALO_PEAK = 45;         // ← halo proportional to the smaller crystal
  const GROW_TAU = 14; // deposits to reach ~63% growth (1-exp)
  const ROT_SPEED = 0.35; // rad/sec

  C.init = function (scene, opts) {
    if (C._mesh) return C;
    C._scene = scene;
    opts = opts || {};
    const accent = opts.accent || 0x9EE9C4;
    // ---- inner crystal: faceted icosahedron, lightly emissive ----
    const geo = new THREE.IcosahedronGeometry(PEAK_RADIUS, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 0.6,
      roughness: 0.22, metalness: 0.15,
      flatShading: true, transparent: true, opacity: 0.85
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(POSITION);
    // Lift just above ground at world origin
    mesh.position.y = Math.max(2, (DN.world && DN.world.heightAt) ? DN.world.heightAt(0, 0) + 2 : 2);
    mesh.scale.setScalar(0);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.visible = false;
    scene.add(mesh);
    C._mesh = mesh;
    // sync canonical position to actual world Y
    POSITION.copy(mesh.position);

    // ---- additive halo sprite that scales with the crystal ----
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: (DN.util && DN.util.softSprite) ? DN.util.softSprite() : null,
      color: accent, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    halo.position.copy(mesh.position);
    halo.scale.set(0, 0, 1);
    halo.visible = false;
    scene.add(halo);
    C._halo = halo;

    return C;
  };

  C.position = function () { return POSITION.clone(); };

  C.show = function () {
    if (!C._mesh) return;
    C._mesh.visible = true;
    C._halo.visible = true;
    C._deposits = 0;
    C._scale = 0;
  };

  C.hide = function () {
    if (!C._mesh) return;
    C._mesh.visible = false;
    C._halo.visible = false;
    C._mesh.scale.setScalar(0);
    C._halo.scale.set(0, 0, 1);
    C._halo.material.opacity = 0;
  };

  C.depositOne = function () {
    C._deposits += 1;
  };
  // Inverse of depositOne — called when a converging ant "picks up" a
  // shard. Reducing _deposits feeds the logistic growth target, so the
  // crystal smoothly shrinks instead of popping.
  C.takeOne = function (amount) {
    const a = amount || 1;
    C._deposits = Math.max(0, C._deposits - a);
  };

  C.setAccent = function (hex) {
    if (!C._mesh) return;
    C._mesh.material.color.setHex(hex);
    C._mesh.material.emissive.setHex(hex);
    C._halo.material.color.setHex(hex);
  };

  C.update = function (dt, elapsed) {
    if (!C._mesh || !C._mesh.visible) return;
    // logistic-ish growth → 0 → 1 as deposits grow
    const target = 1 - Math.exp(-C._deposits / GROW_TAU);
    C._scale += (target - C._scale) * Math.min(1, dt * 2.4);
    const s = C._scale;
    C._mesh.scale.setScalar(Math.max(0.001, s));
    // slow rotation always
    C._mesh.rotation.y += ROT_SPEED * dt;
    C._mesh.rotation.x += ROT_SPEED * 0.5 * dt;
    // halo grows alongside, with a subtle pulse
    const halo = HALO_PEAK * s * (1 + 0.08 * Math.sin(elapsed * 2.2));
    C._halo.scale.set(halo, halo, 1);
    C._halo.material.opacity = 0.18 + 0.55 * s;
  };

  return C;
})();
