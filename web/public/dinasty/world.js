// WorldColony — world: renderer, gradient sky, sunlight, fog, voxel terrain, water, atmosphere
window.DN = window.DN || {};

DN.world = (function () {
  const W = {};
  const SIZE = 880;
  const SEG = 320;
  const AMP = 34;
  const SCALE = 0.009;
  // Skirt plane parameters — a vast flat ground extending to the horizon
  // so the finite terrain never reveals the sky/void at its edges.
  const SKIRT_SIZE = 6000;
  const SKIRT_Y = -1.6;
  // Edge falloff thresholds (radius from world center) where the detailed
  // terrain smoothly melts down to the skirt level.
  const EDGE_START = SIZE * 0.34;
  const EDGE_END = SIZE * 0.49;
  let noise, fireflies, dust, cn, clouds, terrainDetail, critters;

  // ---- shared height field (metres-ish units) ----
  function heightAt(x, z) {
    const n = noise.fbm2(x * SCALE, z * SCALE, 5, 2.0, 0.5); // ~ -1..1
    let h = (n * 0.5 + 0.2) * AMP;
    // gentle terracing -> voxel feel
    const step = 2.2;
    h = h * 0.7 + (Math.round(h / step) * step) * 0.3;
    // flatten a central clearing so colonies + trails read clearly
    const r = Math.sqrt(x * x + z * z);
    const clearing = Math.max(0, 1 - r / 165);
    h *= 1 - clearing * clearing * 0.72;
    // a meandering shallow streambed
    const stream = Math.abs(Math.sin(x * 0.018 + Math.cos(z * 0.012) * 1.6) + z * 0.004);
    if (stream < 0.16) h -= (0.16 - stream) * 18;
    // edge falloff — smoothly drop to the surrounding skirt so the boundary
    // is invisible from any camera angle.
    const edgeR = Math.max(Math.abs(x), Math.abs(z));
    if (edgeR > EDGE_START) {
      const t = Math.min(1, (edgeR - EDGE_START) / (EDGE_END - EDGE_START));
      const smooth = t * t * (3 - 2 * t);
      h = h * (1 - smooth) + SKIRT_Y * smooth;
    }
    return h;
  }
  W.heightAt = heightAt;
  W.WATER_LEVEL = -3.2;

  function makeWaterMaterial(color) {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uFoam: { value: new THREE.Color(0xE9FFF0) }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorld;
        uniform float uTime;
        void main(){
          vUv = uv;
          vec3 p = position;
          float w1 = sin((p.x + uTime * 9.0) * 0.045 + sin(p.z * 0.035));
          float w2 = cos((p.z - uTime * 7.0) * 0.052 + p.x * 0.018);
          p.y += (w1 + w2) * 0.07;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vWorld;
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uFoam;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
          vec2 u=f*f*(3.-2.*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
        }
        void main(){
          float n = noise(vWorld.xz * 0.075 + vec2(uTime * 0.08, -uTime * 0.055));
          float ripple = sin(vWorld.x * 0.13 + uTime * 1.8) * cos(vWorld.z * 0.11 - uTime * 1.4);
          float vein = smoothstep(0.58, 0.96, n + ripple * 0.18);
          float foam = smoothstep(0.74, 0.98, noise(vWorld.xz * 0.16 - uTime * 0.10) + abs(ripple) * 0.22);
          vec3 col = mix(uColor * 0.72, uColor * 1.35, vein);
          col = mix(col, uFoam, foam * 0.16);
          float alpha = 0.30 + vein * 0.12 + foam * 0.08;
          gl_FragColor = vec4(col, alpha);
        }`
    });
  }

  function makeClouds(scene) {
    const g = new THREE.Group();
    g.name = 'atmospheric-clouds';
    const tex = DN.util.softSprite();
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: i % 3 === 0 ? 0xFFF4DA : 0xEAF5FF,
        transparent: true,
        opacity: 0.055 + Math.random() * 0.045,
        depthWrite: false
      });
      const sp = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2;
      const r = 520 + Math.random() * 1180;
      sp.position.set(Math.cos(a) * r, 220 + Math.random() * 115, Math.sin(a) * r);
      sp.scale.set(160 + Math.random() * 180, 32 + Math.random() * 30, 1);
      sp.userData = { drift: 1.6 + Math.random() * 2.6, phase: Math.random() * 6.28, baseY: sp.position.y };
      g.add(sp);
    }
    scene.add(g);
    return g;
  }

  function makeTerrainDetail(scene) {
    const root = new THREE.Group();
    root.name = 'terrain-detail-overlay';
    const bladeGeo = new THREE.ConeGeometry(0.18, 1.15, 4);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x5E8D38, roughness: 1.0, metalness: 0.0, flatShading: true });
    const count = 720;
    const mesh = new THREE.InstancedMesh(bladeGeo, bladeMat, count);
    mesh.name = 'terrain-detail-overlay-grass';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
    let placed = 0;
    for (let i = 0; i < count * 2 && placed < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 18 + Math.pow(Math.random(), 0.72) * (SIZE * 0.43);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = heightAt(x, z);
      if (y < W.WATER_LEVEL + 1.0) continue;
      e.set((Math.random() - 0.5) * 0.34, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.34);
      q.setFromEuler(e);
      const sc = 0.55 + Math.random() * 0.95;
      sv.set(sc, sc * (0.75 + Math.random() * 0.8), sc);
      pv.set(x, y + 0.42 * sv.y, z);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);

    const pebGeo = new THREE.DodecahedronGeometry(0.75, 0);
    const pebMat = new THREE.MeshStandardMaterial({ color: 0x8D887B, roughness: 1.0, metalness: 0.0, flatShading: true });
    const pebbles = new THREE.InstancedMesh(pebGeo, pebMat, 180);
    pebbles.name = 'terrain-detail-overlay-pebbles';
    for (let i = 0; i < 180; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 24 + Math.random() * (SIZE * 0.40);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = heightAt(x, z);
      e.set(Math.random() * 0.7, Math.random() * Math.PI * 2, Math.random() * 0.7);
      q.setFromEuler(e);
      const sc = 0.28 + Math.random() * 0.62;
      sv.set(sc * (1.1 + Math.random() * 0.8), sc * 0.42, sc);
      pv.set(x, y + 0.12, z);
      m.compose(pv, q, sv);
      pebbles.setMatrixAt(i, m);
    }
    pebbles.instanceMatrix.needsUpdate = true;
    root.add(pebbles);
    scene.add(root);
    return root;
  }

  function makeLivingCritters(scene) {
    const root = new THREE.Group();
    root.name = 'living-critters';
    const count = 140;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const base = new Float32Array(count * 3);
    const ph = new Float32Array(count);
    const palette = [new THREE.Color(0xFFE36E), new THREE.Color(0xFF9E6E), new THREE.Color(0xB8F56B), new THREE.Color(0x9AE7FF), new THREE.Color(0xF2D8FF)];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.pow(Math.random(), 0.65) * (SIZE * 0.38);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = heightAt(x, z) + 2.2 + Math.random() * 8.0;
      base[i * 3] = pos[i * 3] = x;
      base[i * 3 + 1] = pos[i * 3 + 1] = y;
      base[i * 3 + 2] = pos[i * 3 + 2] = z;
      ph[i] = Math.random() * Math.PI * 2;
      const c = palette[i % palette.length];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.4,
      map: DN.util.softSprite(),
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'living-critters-points';
    points.frustumCulled = false;
    root.add(points);
    root.userData = { points, base, ph };
    scene.add(root);
    return root;
  }

  function makeSky(scene) {
    const geo = new THREE.SphereGeometry(4800, 64, 40);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(DN.palette.skyTop) },
        mid: { value: new THREE.Color(DN.palette.skyMid) },
        bot: { value: new THREE.Color(DN.palette.horizon) },
        sunCol: { value: new THREE.Color(DN.palette.sun) },
        sunDir: { value: new THREE.Vector3(-0.5, 0.5, 0.4).normalize() }
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);}`,
      fragmentShader: `
        varying vec3 vDir; uniform vec3 top,mid,bot,sunCol,sunDir;
        void main(){
          float h = normalize(vDir).y;
          vec3 col = mix(bot, top, clamp(h*0.55+0.4, 0.0, 1.0));
          col = mix(col, mid, pow(1.0 - clamp(abs(h*1.4),0.0,1.0), 3.0)*0.6);
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += sunCol * (pow(s, 480.0)*0.7 + pow(s, 9.0)*0.14);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    scene.add(sky);
    W.skyMat = mat;
  }

  W.init = function (canvas) {
    noise = new DNNoise(11);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DN.palette.horizon);
    // Subtle aerial perspective. Far terrain now fades into the horizon instead of
    // reading as a hard toy edge, while the skirt still hides the finite terrain.
    scene.fog = new THREE.Fog(DN.palette.horizon, 2400, 5200);

    // Wider FOV (was 60) makes the basin feel expansive — the world reads
    // as a big map instead of a cropped diorama. Camera pulled back a touch
    // for the same reason.
    const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.1, 8000);
    camera.position.set(46, 18, 82);

    // `default` lets the OS pick the integrated GPU on laptops. `high-performance`
    // pins the discrete GPU on for the whole session — a big battery drain for a
    // scene this light. Switch back to high-performance only if framerate suffers.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'default' });
    renderer.setPixelRatio(Math.min(1.35, window.devicePixelRatio || 1));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = false;
    renderer.outputEncoding = THREE.LinearEncoding;
    renderer.toneMapping = THREE.NoToneMapping;

    makeSky(scene);

    // ---- lighting: warm directional sun + sky hemi ----
    const hemi = new THREE.HemisphereLight(0xDCEBFF, 0x4A5A28, 0.45);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xFFEFC8, 1.5);
    sun.position.set(-110, 150, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 620;
    const sc = 260;
    sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
    sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);
    scene.add(sun.target);
    const amb = new THREE.AmbientLight(0xffffff, 0.16);
    scene.add(amb);

    // ---- terrain ----
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    cn = new DNNoise(91);
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, DN.util.voxelMat({ flatShading: false, roughness: 0.97 }));
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    scene.add(terrain);
    W.terrain = terrain;
    W.biome = DN.biomes[0];
    W.recolorTerrain(W.biome.ground);

    // ---- infinite ground skirt: huge plane that extends to the horizon ----
    // Slightly below the terrain edge so the falloff blends seamlessly.
    // Vertex-colored with subtle low-frequency tonal variation so it doesn't
    // read as a sterile flat plane in the distance.
    const skirtGeo = new THREE.PlaneGeometry(SKIRT_SIZE, SKIRT_SIZE, 32, 32);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirtPos = skirtGeo.attributes.position;
    const skirtColors = new Float32Array(skirtPos.count * 3);
    skirtGeo.setAttribute('color', new THREE.BufferAttribute(skirtColors, 3));
    // Subtle rolling undulation only well outside the terrain footprint so
    // the inner ring stays perfectly flat against the terrain falloff.
    const innerFlat = SIZE * 0.55;
    for (let i = 0; i < skirtPos.count; i++) {
      const x = skirtPos.getX(i), z = skirtPos.getZ(i);
      const r = Math.max(Math.abs(x), Math.abs(z));
      if (r > innerFlat) {
        const k = Math.min(1, (r - innerFlat) / (SKIRT_SIZE * 0.25));
        const undulation = noise.fbm2(x * 0.0025, z * 0.0025, 3, 2.0, 0.5);
        skirtPos.setY(i, undulation * 9 * k);
      }
    }
    skirtGeo.computeVertexNormals();
    const skirt = new THREE.Mesh(
      skirtGeo,
      DN.util.voxelMat({ flatShading: false, roughness: 0.98 })
    );
    skirt.position.y = SKIRT_Y;
    skirt.receiveShadow = true;
    skirt.name = 'skirt';
    // Render slightly before terrain so terrain sits on top where they overlap.
    skirt.renderOrder = -1;
    scene.add(skirt);
    W.skirt = skirt;
    W.recolorSkirt(W.biome.ground);

    // ---- water plane along the streambed / basin ----
    // Sized to inner terrain so water only shows where the streambed dips
    // below WATER_LEVEL — the skirt sits above water level out at the horizon.
    const waterGeo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = makeWaterMaterial(DN.palette.water);
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = W.WATER_LEVEL;
    water.receiveShadow = false;
    scene.add(water);

    // ---- atmospheric dust motes (sunbeam sparkle) ----
    const dn = 240;
    const dpos = new Float32Array(dn * 3), dph = new Float32Array(dn);
    for (let i = 0; i < dn; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * SIZE;
      dpos[i * 3 + 1] = 9 + Math.random() * 48;
      dpos[i * 3 + 2] = (Math.random() - 0.5) * SIZE;
      dph[i] = Math.random() * 6.28;
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dust = new THREE.Points(dgeo, new THREE.PointsMaterial({
      size: 0.45, map: DN.util.softSprite(), color: 0xFFFBEF,
      transparent: true, opacity: 0.22, depthWrite: false, sizeAttenuation: true
    }));
    dust.frustumCulled = false;
    scene.add(dust);
    W._dust = { pts: dust, base: dpos.slice(), ph: dph };

    // ---- fireflies (warm glowing motes near ground) ----
    const fn = 90;
    const fpos = new Float32Array(fn * 3), fph = new Float32Array(fn);
    for (let i = 0; i < fn; i++) {
      const a = Math.random() * 6.28, r = 30 + Math.random() * 120;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      fpos[i * 3] = x; fpos[i * 3 + 1] = heightAt(x, z) + 2 + Math.random() * 6; fpos[i * 3 + 2] = z;
      fph[i] = Math.random() * 6.28;
    }
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    fireflies = new THREE.Points(fgeo, new THREE.PointsMaterial({
      size: 1.5, map: DN.util.softSprite(), color: 0xFFE9A0,
      transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    fireflies.frustumCulled = false;
    scene.add(fireflies);
    W._fire = { pts: fireflies, base: fpos.slice(), ph: fph };

    clouds = makeClouds(scene);
    terrainDetail = makeTerrainDetail(scene);
    critters = makeLivingCritters(scene);

    W.scene = scene; W.camera = camera; W.renderer = renderer;
    W.terrain = terrain; W.sun = sun; W.water = water; W.hemi = hemi; W.amb = amb; W.clouds = clouds; W.terrainDetail = terrainDetail; W.critters = critters;
    W._sceneRevampV2 = true;
    W.SIZE = SIZE;

    addEventListener('resize', function () {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });
    return W;
  };

  // Dust/firefly point clouds update at ~30Hz instead of full FPS — the
  // motion is too slow for the difference to be perceptible and rewriting
  // 240+90 vec3 buffers every frame costs CPU + GPU upload.
  let _atmosTick = 0;
  W.update = function (dt, elapsed) {
    _atmosTick++;
    const updateAtmos = (_atmosTick & 1) === 0;
    if (!updateAtmos) {
      if (W.water && W.water.material.uniforms) W.water.material.uniforms.uTime.value = elapsed;
      return;
    }
    const d = W._dust;
    if (d) {
      const p = d.pts.geometry.attributes.position;
      for (let i = 0; i < d.ph.length; i++) {
        const ph = d.ph[i];
        p.array[i * 3] = d.base[i * 3] + Math.sin(elapsed * 0.1 + ph) * 5;
        p.array[i * 3 + 1] = d.base[i * 3 + 1] + Math.sin(elapsed * 0.16 + ph * 1.7) * 2.4;
        p.array[i * 3 + 2] = d.base[i * 3 + 2] + Math.cos(elapsed * 0.09 + ph) * 5;
      }
      p.needsUpdate = true;
    }
    const f = W._fire;
    if (f) {
      const p = f.pts.geometry.attributes.position;
      for (let i = 0; i < f.ph.length; i++) {
        const ph = f.ph[i];
        p.array[i * 3] = f.base[i * 3] + Math.sin(elapsed * 0.5 + ph) * 3;
        p.array[i * 3 + 1] = f.base[i * 3 + 1] + Math.sin(elapsed * 0.7 + ph * 2.1) * 1.6;
        p.array[i * 3 + 2] = f.base[i * 3 + 2] + Math.cos(elapsed * 0.45 + ph) * 3;
      }
      p.needsUpdate = true;
      // twinkle, stronger at dusk/night
      const night = W._night || 0;
      f.pts.material.opacity = (0.25 + Math.sin(elapsed * 2) * 0.1) * (0.2 + night * 0.9);
    }
    if (W.water && W.water.material.uniforms) W.water.material.uniforms.uTime.value = elapsed;
    if (W.clouds) {
      for (let i = 0; i < W.clouds.children.length; i++) {
        const c = W.clouds.children[i];
        c.position.x += dt * c.userData.drift;
        c.position.y = c.userData.baseY + Math.sin(elapsed * 0.08 + c.userData.phase) * 7;
        if (c.position.x > 1800) c.position.x = -1800;
      }
    }
    if (W.critters && W.critters.userData.points) {
      const u = W.critters.userData;
      const arr = u.points.geometry.attributes.position.array;
      for (let i = 0; i < u.ph.length; i++) {
        const ph = u.ph[i];
        const bx = u.base[i * 3], by = u.base[i * 3 + 1], bz = u.base[i * 3 + 2];
        arr[i * 3] = bx + Math.sin(elapsed * 0.75 + ph) * 3.8 + Math.sin(elapsed * 1.7 + ph * 2.0) * 0.9;
        arr[i * 3 + 1] = by + Math.sin(elapsed * 2.8 + ph) * 0.85 + Math.max(0, Math.sin(elapsed * 7.0 + ph)) * 0.42;
        arr[i * 3 + 2] = bz + Math.cos(elapsed * 0.62 + ph * 1.3) * 3.8;
      }
      u.points.geometry.attributes.position.needsUpdate = true;
      u.points.material.opacity = 0.42 + Math.sin(elapsed * 0.7) * 0.08;
    }
  };

  // time-of-day 0..1 (0 dawn, .5 midday, 1 dusk->night)
  // Skip work when t hasn't changed meaningfully — daylight is a smooth slow
  // signal, recomputing colors/light positions every frame is wasted CPU.
  let _lastDaylight = -2;
  W.setDaylight = function (t) {
    if (Math.abs(t - _lastDaylight) < 0.002) return;
    _lastDaylight = t;
    const b = W.biome || DN.biomes[0];
    const day = Math.sin(t * Math.PI); // 0 ends, 1 midday
    const night = Math.max(0, 1 - day * 1.4);
    W._night = night;
    if (W.sun) {
      W.sun.intensity = (0.36 + day * 1.0) * (b.sunBias || 1);
      const warm = new THREE.Color(0xFFD9A0).lerp(new THREE.Color(b.sky.sun), day);
      W.sun.color.copy(warm);
      const ang = 0.15 + t * (Math.PI - 0.3);
      W.sun.position.set(Math.cos(ang) * 150, 30 + day * 150, 80);
      if (W.skyMat) W.skyMat.uniforms.sunDir.value.copy(W.sun.position).normalize();
    }
    if (W.hemi) W.hemi.intensity = 0.26 + day * 0.26;
    if (W.amb) W.amb.intensity = (b.amb || 0.16);
    if (W.skyMat) {
      const duskTop = new THREE.Color(b.sky.top).lerp(new THREE.Color(0x2A3458), night * 0.6);
      const duskBot = new THREE.Color(b.sky.bot).lerp(new THREE.Color(0xE8A368), Math.max(0, Math.sin((t - 0.5) * Math.PI)) * 0.45);
      W.skyMat.uniforms.top.value.copy(duskTop);
      W.skyMat.uniforms.mid.value.set(b.sky.mid);
      W.skyMat.uniforms.bot.value.copy(duskBot);
      W.skyMat.uniforms.sunCol.value.set(b.sky.sun);
    }
  };

  // recolor the infinite ground skirt vertices to match the biome
  W.recolorSkirt = function (ground) {
    if (!W.skirt) return;
    const geo = W.skirt.geometry, pos = geo.attributes.position, colAttr = geo.attributes.color;
    const cGrass = new THREE.Color(ground.grass);
    const cGrassD = new THREE.Color(ground.grassDark);
    const cGrassL = new THREE.Color(ground.grassLight);
    const tmp = new THREE.Color();
    const tintN = cn || new DNNoise(91);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const tint = tintN.n2(x * 0.012, z * 0.012) * 0.5 + 0.5;
      const dark = tintN.n2(x * 0.004 + 7.1, z * 0.004 - 3.3) * 0.5 + 0.5;
      tmp.copy(cGrass).lerp(cGrassL, tint * 0.55);
      tmp.lerp(cGrassD, dark * 0.35);
      colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;
  };

  // recolor terrain vertices to a biome ground palette
  W.recolorTerrain = function (ground) {
    const geo = W.terrain.geometry, pos = geo.attributes.position, colAttr = geo.attributes.color;
    const cGrass = new THREE.Color(ground.grass), cGrassD = new THREE.Color(ground.grassDark), cGrassL = new THREE.Color(ground.grassLight), cDirt = new THREE.Color(ground.dirt), cSand = new THREE.Color(ground.sand), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = pos.getY(i);
      const hx = heightAt(x + 1.5, z) - heightAt(x - 1.5, z), hz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
      const slope = Math.min(1, Math.hypot(hx, hz) / 5);
      const tint = cn.n2(x * 0.05, z * 0.05) * 0.5 + 0.5;
      tmp.copy(cGrass).lerp(cGrassL, tint * 0.6); tmp.lerp(cGrassD, slope * 0.5);
      if (h < W.WATER_LEVEL + 1.6) tmp.lerp(cSand, Math.min(1, (W.WATER_LEVEL + 1.6 - h) / 2.2));
      else if (slope > 0.55) tmp.lerp(cDirt, (slope - 0.55) * 1.5);
      colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;
  };

  W.applyBiome = function (b) {
    W.biome = b;
    if (W.scene) {
      W.scene.background.set(b.bg);
      if (W.scene.fog) { W.scene.fog.color.set(b.bg); W.scene.fog.near = b.fog[0]; W.scene.fog.far = b.fog[1]; }
    }
    if (W.hemi) { W.hemi.color.set(b.hemiSky); W.hemi.groundColor.set(b.hemiGround); }
    if (W.water) {
      if (W.water.material.uniforms && W.water.material.uniforms.uColor) W.water.material.uniforms.uColor.value.set(b.water);
      else if (W.water.material.color) W.water.material.color.set(b.water);
    }
    if (W.skyMat) { W.skyMat.uniforms.top.value.set(b.sky.top); W.skyMat.uniforms.mid.value.set(b.sky.mid); W.skyMat.uniforms.bot.value.set(b.sky.bot); W.skyMat.uniforms.sunCol.value.set(b.sky.sun); }
    W.recolorTerrain(b.ground);
    W.recolorSkirt(b.ground);
  };

  return W;
})();
