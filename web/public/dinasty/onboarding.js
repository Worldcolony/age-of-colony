// WorldColony — first-run onboarding flow.
// Three-step coachmark sequence that guides a new player from "intro fades"
// → "connect wallet" → "pick Found tool & click the map" → "first colony
// founded". Each step renders a centred card + an animated arrow pointing
// at the relevant HUD element. Completion is persisted in localStorage so
// returning players are not pestered.
window.DN = window.DN || {};

DN.onboarding = (function () {
  const O = {};
  const KEY = 'dn:onboarding:done:v1';
  let root = null;       // overlay container
  let card = null;       // text card
  let pointer = null;    // arrow pointer
  let spotlight = null;  // soft halo around target
  let currentStep = 0;
  let unsubWallet = null;
  let pollTimer = null;
  let done = false;

  function alreadyDone() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
  }

  function mount() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'onboarding';
    root.innerHTML = (
      '<div class="ob-spotlight" id="ob-spotlight"></div>' +
      '<div class="ob-pointer" id="ob-pointer">' +
      '  <svg viewBox="0 0 80 80" aria-hidden="true">' +
      '    <defs>' +
      '      <linearGradient id="ob-grad" x1="0" y1="0" x2="1" y2="1">' +
      '        <stop offset="0%" stop-color="#FFE7A8"/>' +
      '        <stop offset="100%" stop-color="#B07E1C"/>' +
      '      </linearGradient>' +
      '    </defs>' +
      '    <path d="M40 6 L60 46 L42 40 L40 74 L38 40 L20 46 Z" fill="url(#ob-grad)" stroke="#2C2820" stroke-width="2" stroke-linejoin="round"/>' +
      '  </svg>' +
      '</div>' +
      '<div class="ob-card" id="ob-card">' +
      '  <div class="ob-step" id="ob-step">Step 1 of 3</div>' +
      '  <h2 id="ob-title">Welcome to WorldColony</h2>' +
      '  <p id="ob-body">A living civilization of forecasting ants.</p>' +
      '  <div class="ob-actions">' +
      '    <button class="ob-skip" id="ob-skip" type="button">Skip tour</button>' +
      '    <button class="ob-next" id="ob-next" type="button">Continue</button>' +
      '  </div>' +
      '  <div class="ob-dots"><span data-i="1"></span><span data-i="2"></span><span data-i="3"></span></div>' +
      '</div>'
    );
    document.body.appendChild(root);
    card = document.getElementById('ob-card');
    pointer = document.getElementById('ob-pointer');
    spotlight = document.getElementById('ob-spotlight');
    document.getElementById('ob-skip').addEventListener('click', finish);
    document.getElementById('ob-next').addEventListener('click', onNextClick);
    addEventListener('resize', () => positionFor(currentStep));
  }

  function pointAt(selector, side) {
    const el = document.querySelector(selector);
    if (!el) { hidePointer(); hideSpotlight(); return; }
    const r = el.getBoundingClientRect();
    // empty rect (display:none / off-screen / not laid out yet) — bail
    // rather than parking the arrow at (0,0).
    if (r.width === 0 && r.height === 0) { hidePointer(); hideSpotlight(); return; }
    pointer.classList.remove('ob-from-left', 'ob-from-right', 'ob-from-top', 'ob-from-bottom');
    // `side` = which side of the target the arrow SITS on (so it points
    // back toward the target from that side).
    side = side || 'right';
    pointer.classList.add('ob-from-' + side);
    const OFF = 60;
    const MARGIN = 36;        // keep the pointer inside the viewport
    let px = r.left + r.width / 2;
    let py = r.top + r.height / 2;
    if (side === 'right')  px = r.right + OFF;
    if (side === 'left')   px = r.left  - OFF;
    if (side === 'bottom') py = r.bottom + OFF;
    if (side === 'top')    py = r.top   - OFF;
    // clamp inside the viewport so the arrow is never hidden by the
    // browser chrome / canvas edge.
    const vw = innerWidth, vh = innerHeight;
    px = Math.max(MARGIN, Math.min(vw - MARGIN, px));
    py = Math.max(MARGIN, Math.min(vh - MARGIN, py));
    pointer.style.left = px + 'px';
    pointer.style.top  = py + 'px';
    pointer.classList.add('show');
    // spotlight halo on the target
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = Math.max(r.width, r.height) * 0.95 + 26;
    spotlight.style.left = (cx - rad) + 'px';
    spotlight.style.top  = (cy - rad) + 'px';
    spotlight.style.width  = (rad * 2) + 'px';
    spotlight.style.height = (rad * 2) + 'px';
    spotlight.classList.add('show');
  }
  function hidePointer() { pointer && pointer.classList.remove('show'); }
  function hideSpotlight() { spotlight && spotlight.classList.remove('show'); }

  function setCard(stepNum, title, body, opts) {
    opts = opts || {};
    document.getElementById('ob-step').textContent = 'Step ' + stepNum + ' of 3';
    document.getElementById('ob-title').textContent = title;
    document.getElementById('ob-body').innerHTML = body;
    document.getElementById('ob-next').textContent = opts.nextLabel || 'Continue';
    document.getElementById('ob-next').style.display = opts.hideNext ? 'none' : '';
    document.querySelectorAll('#ob-card .ob-dots span').forEach(d => {
      d.classList.toggle('active', parseInt(d.dataset.i, 10) === stepNum);
    });
    card.classList.remove('ob-pos-center', 'ob-pos-bottomleft', 'ob-pos-topright');
    const pos = opts.pos || 'ob-pos-center';
    card.classList.add(pos);
    // dim the world only for centered cards. Side cards leave the
    // tool/wallet panels they're pointing at fully visible.
    root.classList.toggle('ob-dim', pos === 'ob-pos-center');
    // tiny re-entry animation
    card.classList.remove('show');
    requestAnimationFrame(() => card.classList.add('show'));
  }

  // ---- steps ---------------------------------------------------------
  function step1() {
    currentStep = 1;
    setCard(
      1,
      'Welcome to WorldColony',
      'A living civilization of forecasting ants. ' +
      '<b>Connect your Phantom wallet</b> to claim your own colony and write your dynasty into the world.',
      { pos: 'ob-pos-center', nextLabel: 'Got it' }
    );
    hidePointer(); hideSpotlight();
  }
  function step2() {
    currentStep = 2;
    setCard(
      2,
      'Found your colony',
      'Pick the <b>Found</b> tool on the left rail, then click anywhere on the world to place your colony.',
      { pos: 'ob-pos-bottomleft', hideNext: true }
    );
    positionFor(2);
  }
  function step3() {
    currentStep = 3;
    setCard(
      3,
      'Your dynasty begins',
      'Your colony is breathing. Switch lenses with the bottom rail, drop forage caches, or dive underground to watch your agents reason in real-time.',
      { pos: 'ob-pos-center', nextLabel: 'Begin' }
    );
    hidePointer(); hideSpotlight();
  }

  function positionFor(n) {
    if (n === 2) pointAt('.tool[data-tool="found"]', 'bottom');
  }

  function onNextClick() {
    if (currentStep === 1) {
      // Step 2 will fire automatically when the wallet connects, but the
      // player may want to advance without connecting (e.g. they're already
      // connected). Detect that here.
      if (DN.wallet && DN.wallet.connected) goToStep2();
      else {
        // collapse the card into a small bottom-corner nudge while waiting.
        currentStep = 1.5;
        setCard(
          1,
          'Waiting for wallet…',
          'Tap the <b>Connect Phantom</b> button in the top-right.',
          { pos: 'ob-pos-bottomleft', hideNext: true }
        );
        pointAt('#wallet', 'left');
      }
    } else if (currentStep === 3) {
      finish();
    }
  }

  function goToStep2() { step2(); }
  function goToStep3() { step3(); }

  function watchWallet() {
    if (!DN.wallet || typeof DN.wallet.onChange !== 'function') {
      // Wallet module not present yet — retry briefly.
      pollTimer = setTimeout(watchWallet, 400);
      return;
    }
    unsubWallet = DN.wallet.onChange((snap) => {
      if (done) return;
      if (snap.connected && (currentStep === 1 || currentStep === 1.5)) {
        goToStep2();
      }
    });
    // If wallet already connected (page reload), jump straight to step 2.
    if (DN.wallet.connected && currentStep === 1) goToStep2();
  }

  function finish() {
    if (done) return;
    done = true;
    markDone();
    if (unsubWallet && typeof unsubWallet === 'function') { try { unsubWallet(); } catch (e) {} }
    if (pollTimer) clearTimeout(pollTimer);
    if (root) {
      root.classList.add('hide');
      setTimeout(() => { if (root && root.parentNode) root.parentNode.removeChild(root); root = null; }, 480);
    }
  }

  // ---- public --------------------------------------------------------
  // Called by App.createUserColony() on a successful founding so we can
  // celebrate + close the loop without coupling onboarding to colony.js.
  O.notifyColonyFounded = function () {
    if (done) return;
    goToStep3();
  };

  // Optional debug hook: clear the persisted flag.
  O.reset = function () { try { localStorage.removeItem(KEY); } catch (e) {} };

  O.start = function () {
    if (alreadyDone()) return;
    mount();
    // Wait for the intro splash to finish fading before greeting them.
    setTimeout(() => { if (!done) step1(); }, 2300);
    watchWallet();
  };

  return O;
})();
