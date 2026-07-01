// WorldColony — minimap: top-down compass that lets the player locate
// their own colony at a glance and click any colony dot to fly there.
// Pure 2D canvas — no Three.js scene cost. Refreshed by App when the
// colony list changes (e.g. after createUserColony / foundColony).
window.DN = window.DN || {};

DN.minimap = (function () {
  const M = {};
  // World half-extent in scene units. Colonies live within ~ ±170 units of
  // the origin (see colony.js DEFS), so 220 keeps a healthy margin.
  const WORLD_HALF = 220;
  let root, canvas, ctx, locateBtn;
  let dpr = 1, size = 0;
  let t0 = 0;
  let raf = 0;
  let lastHover = -1;
  let mountAttempted = false;

  function $$(id) { return document.getElementById(id); }

  function ensureMounted() {
    if (root) return root;
    if (mountAttempted && !document.body) return null;
    mountAttempted = true;
    root = document.createElement('div');
    root.id = 'minimap';
    root.className = 'panel';
    root.innerHTML = (
      '<div class="mm-head">' +
      '  <span class="mm-title">Compass</span>' +
      '  <button id="mm-locate" type="button" disabled>Locate me</button>' +
      '</div>' +
      '<div class="mm-canvas-wrap">' +
      '  <canvas id="mm-canvas" width="200" height="200" aria-label="World minimap"></canvas>' +
      '  <div class="mm-legend"><span class="mm-dot mm-dot-mine"></span>You · <span class="mm-dot mm-dot-other"></span>Others</div>' +
      '</div>'
    );
    document.body.appendChild(root);
    canvas = $$('mm-canvas');
    ctx = canvas.getContext('2d');
    locateBtn = $$('mm-locate');
    locateBtn.addEventListener('click', flyToMine);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', () => { lastHover = -1; canvas.style.cursor = 'default'; });
    resize();
    addEventListener('resize', resize);
    return root;
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    size = Math.min(rect.width, rect.height) || 200;
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width  = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
  }

  // World (x,z) -> minimap canvas px (centered, north = -z = up).
  function worldToMap(wx, wz) {
    const half = size / 2;
    const k = (size * 0.46) / WORLD_HALF;     // scale: leaves a margin ring
    return { x: half + wx * k, y: half + wz * k };
  }

  function mineColony() {
    const w = window.DN && DN.wallet;
    if (!w || !w.connected || !w.pubkey || !DN.colony) return null;
    return DN.colony.list.find(c => c.owner === w.pubkey) || null;
  }

  function colonyAt(px, py) {
    if (!DN.colony || !DN.colony.list) return null;
    const RADIUS = 12;
    for (let i = 0; i < DN.colony.list.length; i++) {
      const c = DN.colony.list[i];
      const m = worldToMap(c.pos.x, c.pos.z);
      if (Math.hypot(px - m.x, py - m.y) <= RADIUS) return c;
    }
    return null;
  }

  function onClick(e) {
    const r = canvas.getBoundingClientRect();
    const c = colonyAt(e.clientX - r.left, e.clientY - r.top);
    if (c && DN.app && DN.app.selectColony) DN.app.selectColony(c);
  }
  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const c = colonyAt(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = c ? 'pointer' : 'default';
    const id = c ? DN.colony.list.indexOf(c) : -1;
    if (id !== lastHover) { lastHover = id; }
  }

  function flyToMine() {
    const mine = mineColony();
    if (!mine) return;
    if (DN.app && DN.app.selectColony) DN.app.selectColony(mine);
  }

  function hex(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (!ctx) return;
    if (!t0) t0 = now;
    const t = (now - t0) / 1000;

    ctx.save();
    ctx.scale(dpr, dpr);
    const S = size;
    // soft parchment radial background
    const bg = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.55);
    bg.addColorStop(0, 'rgba(60, 44, 18, 0.92)');
    bg.addColorStop(1, 'rgba(28, 18, 6, 0.94)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, S);

    // outer ring
    ctx.strokeStyle = 'rgba(232, 197, 138, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2); ctx.stroke();

    // mid ring
    ctx.strokeStyle = 'rgba(232, 197, 138, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.30, 0, Math.PI * 2); ctx.stroke();

    // crosshair
    ctx.strokeStyle = 'rgba(232, 197, 138, 0.18)';
    ctx.beginPath();
    ctx.moveTo(S / 2, S * 0.06); ctx.lineTo(S / 2, S * 0.94);
    ctx.moveTo(S * 0.06, S / 2); ctx.lineTo(S * 0.94, S / 2);
    ctx.stroke();

    // N / E / S / W ticks
    ctx.fillStyle = 'rgba(255, 220, 150, 0.85)';
    ctx.font = '600 9px Silkscreen, Pixelify Sans, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', S / 2, 8);
    ctx.fillText('S', S / 2, S - 8);
    ctx.fillText('W', 8, S / 2);
    ctx.fillText('E', S - 8, S / 2);

    // colony dots
    const mine = mineColony();
    if (DN.colony && DN.colony.list) {
      for (let i = 0; i < DN.colony.list.length; i++) {
        const c = DN.colony.list[i];
        const m = worldToMap(c.pos.x, c.pos.z);
        const isMine = c === mine;
        const accent = hex(c.accent || 0xE8A23D);
        // halo for selected / mine
        if (isMine || c.selected) {
          const pulse = 1 + Math.sin(t * 3) * 0.25;
          ctx.fillStyle = isMine ? 'rgba(255, 220, 150, 0.30)' : 'rgba(255, 220, 150, 0.20)';
          ctx.beginPath(); ctx.arc(m.x, m.y, 9 * pulse, 0, Math.PI * 2); ctx.fill();
        }
        // dot
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(m.x, m.y, isMine ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
        // outline
        ctx.strokeStyle = isMine ? '#FFE7A8' : 'rgba(28, 18, 6, 0.7)';
        ctx.lineWidth = isMine ? 1.6 : 1;
        ctx.stroke();
      }
    }

    // center marker (world origin / camera anchor)
    ctx.fillStyle = 'rgba(255, 220, 150, 0.7)';
    ctx.beginPath(); ctx.arc(S / 2, S / 2, 1.6, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // locate button gating
    if (locateBtn) {
      const has = !!mineColony();
      locateBtn.disabled = !has;
      locateBtn.classList.toggle('ready', has);
    }
  }

  M.refresh = function () { /* no-op — redraws every frame */ };

  let isOpen = false;
  function startLoop() { if (!raf) raf = requestAnimationFrame(draw); }
  function stopLoop()  { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  // Hidden by default. Players ask for it via the toolbar; we auto-close
  // it once they've used "Locate me" to fly to their colony.
  M.toggle = function (force) {
    ensureMounted();
    isOpen = (typeof force === 'boolean') ? force : !isOpen;
    root.classList.toggle('show', isOpen);
    document.querySelectorAll('#tool-map').forEach(el => el.classList.toggle('active', isOpen));
    if (isOpen) startLoop(); else stopLoop();
  };
  M.isOpen = function () { return isOpen; };
  M.close = function () { M.toggle(false); };

  // Override flyToMine to auto-close after locating.
  function flyToMineAndClose() {
    const mine = mineColony();
    if (!mine) return;
    if (DN.app && DN.app.selectColony) DN.app.selectColony(mine);
    setTimeout(() => M.toggle(false), 350);
  }

  M.init = function () {
    ensureMounted();
    // Replace the placeholder click handler with one that closes the map.
    if (locateBtn) {
      const fresh = locateBtn.cloneNode(true);
      locateBtn.parentNode.replaceChild(fresh, locateBtn);
      locateBtn = fresh;
      locateBtn.addEventListener('click', flyToMineAndClose);
    }
    // Hidden until user toggles it on.
    root.classList.remove('show');
    return M;
  };

  return M;
})();
