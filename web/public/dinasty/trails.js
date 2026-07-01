// WorldColony — pheromone trails: ground-hugging ribbons with scrolling flow
window.DN = window.DN || {};

DN.trails = (function () {
  const T = { ribbons: [] };
  let scene, stripeTex;
  function ground(x, z) { return DN.world.heightAt(x, z); }

  function makeStripe() {
    if (stripeTex) return stripeTex;
    const c = document.createElement('canvas'); c.width = 16; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 16, 64);
    // soft worn band + brighter dashes for flow
    const g = ctx.createLinearGradient(0, 0, 16, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 64);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = 'rgba(255,255,255,' + (0.5) + ')'; ctx.fillRect(4, i * 11 + 2, 8, 5); }
    stripeTex = new THREE.CanvasTexture(c);
    stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
    return stripeTex;
  }

  function buildRibbon(a, b, accent, width) {
    const N = 36;
    const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    const perp = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
    const bend = (Math.random() - 0.5) * 18;
    mid.addScaledVector(perp, bend);
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(a.x, 0, a.z), mid, new THREE.Vector3(b.x, 0, b.z)
    );
    const pts = curve.getPoints(N);
    const pos = [], uv = [], idx = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const t = i / (pts.length - 1);
      const tan = (i < pts.length - 1 ? pts[i + 1] : p).clone().sub(i > 0 ? pts[i - 1] : p);
      const pr = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      const half = width * (0.7 + Math.sin(t * Math.PI) * 0.5);
      const y = ground(p.x, p.z) + 0.18;
      const l = p.clone().addScaledVector(pr, half), r = p.clone().addScaledVector(pr, -half);
      pos.push(l.x, ground(l.x, l.z) + 0.18, l.z, r.x, ground(r.x, r.z) + 0.18, r.z);
      uv.push(0, t * 6, 1, t * 6);
      if (i < pts.length - 1) {
        const o = i * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = makeStripe().clone(); tex.needsUpdate = true;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: accent, transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 2;
    scene.add(mesh);
    return { mesh, tex, speed: 0.6 + Math.random() * 0.5 };
  }

  T.init = function (sceneRef, colonies) {
    scene = sceneRef;
    T.colonies = colonies;
    T.rebuild();
    return T;
  };

  T.rebuild = function () {
    T.ribbons.forEach(r => scene.remove(r.mesh));
    T.ribbons = [];
    T.colonies.forEach(col => {
      // ribbon to the 2 nearest resources
      const sorted = DN.resources.list.filter(r => !r.depleted)
        .map(r => ({ r, d: col.pos.distanceTo(r.pos) })).sort((a, b) => a.d - b.d).slice(0, 2);
      sorted.forEach(({ r }) => {
        T.ribbons.push(buildRibbon(col.entrance, r.pos, col.accent, 1.5));
      });
    });
  };

  let acc = 0;
  T.update = function (dt, elapsed) {
    acc += dt;
    for (const r of T.ribbons) {
      r.tex.offset.y -= dt * r.speed;
      r.mesh.material.opacity = 0.6 + Math.sin(elapsed * 1.5) * 0.14;
    }
    if (acc > 6) { acc = 0; T.rebuild(); }
  };

  return T;
})();
