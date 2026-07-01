// WorldColony — shared core: namespace, palette, voxel helpers, sprite textures
window.DN = window.DN || {};

// ---- warm Minecraft-style daylight palette ----
DN.palette = {
  skyTop: 0x6FA6DA,
  skyMid: 0x9FC9E8,
  horizon: 0xA7C57E,
  sun: 0xFFF3D2,

  grass: 0x5E9A35,
  grassDark: 0x42741F,
  grassLight: 0x7FB544,
  dirt: 0x8A6536,
  dirtDark: 0x654922,
  path: 0xB89A66,
  sand: 0xCBB682,

  rock: 0x9D988D,
  rockLight: 0xBAB4A7,
  rockDark: 0x7C776C,

  trunk: 0x6E4C2C,
  trunkDark: 0x533922,
  foliage: 0x4E8B38,
  foliage2: 0x3E7A2C,
  foliage3: 0x69A848,
  foliageWarm: 0xC98B33,

  water: 0x66BBD8,

  ant: 0x4A2C1C,
  antDark: 0x301a10,
  antLight: 0x6E4329,

  // faction accents — earthy jewel tones (no neon)
  factions: [0xE3A53C, 0x3FA89F, 0xD96E54, 0x8E79C4, 0xE26B8E, 0x5DB0E8, 0xB8C440],
  factionNames: ['Amberfall', 'Verdana Prime', 'Cobalt Reach', 'Greywarren', 'Crimson Pact', 'Aether Hold', 'Lichenstrand'],

  ink: 0x2B2A26
};

DN.util = (function () {
  const U = {};

  // soft radial sprite (white -> transparent)
  U.softSprite = (function () {
    let tex = null;
    return function () {
      if (tex) return tex;
      const s = 128, c = document.createElement('canvas');
      c.width = c.height = s;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.3, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      return tex;
    };
  })();

  // soft contact-shadow disc
  U.shadowSprite = (function () {
    let tex = null;
    return function () {
      if (tex) return tex;
      const s = 128, c = document.createElement('canvas');
      c.width = c.height = s;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(40,34,26,0.42)');
      g.addColorStop(0.55, 'rgba(40,34,26,0.16)');
      g.addColorStop(1, 'rgba(40,34,26,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      tex = new THREE.CanvasTexture(c);
      return tex;
    };
  })();

  // ---- voxel mesh builder ----
  // Accumulate axis-aligned boxes (optionally per-box rotation) into one
  // flat-shaded, vertex-colored BufferGeometry. Great for low-poly trees, ants, props.
  U.VoxelBuilder = function VoxelBuilder() {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this._c = new THREE.Color();
  };
  const FACES = [
    // dir, normal, 4 corners (unit cube centered at origin)
    [[ 0, 0, 1], [[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]]],
    [[ 0, 0,-1], [[.5,-.5,-.5],[-.5,-.5,-.5],[-.5,.5,-.5],[.5,.5,-.5]]],
    [[ 1, 0, 0], [[.5,-.5,.5],[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5]]],
    [[-1, 0, 0], [[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5],[-.5,.5,-.5]]],
    [[ 0, 1, 0], [[-.5,.5,.5],[.5,.5,.5],[.5,.5,-.5],[-.5,.5,-.5]]],
    [[ 0,-1, 0], [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]]]
  ];
  // box: size [w,h,d], position [x,y,z], color (hex), optional rotation {axis:'x'|'y'|'z', a:radians}
  U.VoxelBuilder.prototype.box = function (size, position, color, rot) {
    const c = this._c.set(color);
    const sx = size[0], sy = size[1], sz = size[2];
    const px = position[0], py = position[1], pz = position[2];
    let ra = 0, rax = 'y';
    if (rot) { ra = rot.a; rax = rot.axis; }
    const ca = Math.cos(ra), sa = Math.sin(ra);
    const rotate = (x, y, z) => {
      if (!ra) return [x, y, z];
      if (rax === 'y') return [x * ca + z * sa, y, -x * sa + z * ca];
      if (rax === 'x') return [x, y * ca - z * sa, y * sa + z * ca];
      return [x * ca - y * sa, x * sa + y * ca, z]; // z
    };
    for (let f = 0; f < 6; f++) {
      const nm = FACES[f][0], corners = FACES[f][1];
      const rn = rotate(nm[0], nm[1], nm[2]);
      const verts = corners.map(v => {
        const r = rotate(v[0] * sx, v[1] * sy, v[2] * sz);
        return [r[0] + px, r[1] + py, r[2] + pz];
      });
      const tri = [0, 1, 2, 0, 2, 3];
      for (let t = 0; t < 6; t++) {
        const v = verts[tri[t]];
        this.pos.push(v[0], v[1], v[2]);
        this.norm.push(rn[0], rn[1], rn[2]);
        this.col.push(c.r, c.g, c.b);
      }
    }
    return this;
  };
  U.VoxelBuilder.prototype.geometry = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.norm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    return g;
  };

  U.hex = function (n) { return '#' + n.toString(16).padStart(6, '0'); };

  // standard flat-shaded vertex-colored material
  U.voxelMat = function (opts) {
    return new THREE.MeshStandardMaterial(Object.assign({
      vertexColors: true, roughness: 0.92, metalness: 0.0, flatShading: true
    }, opts || {}));
  };

  return U;
})();
