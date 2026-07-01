// WorldColony — bottom log terminal. Streams every ant action as a
// timestamped, color-coded console row. Multi-line scrollback, clickable
// ant IDs that re-select via DN.app.selectAnt.
window.DN = window.DN || {};

DN.logTerm = (function () {
  const T = {};
  const MAX_ROWS = 2000;
  let root, scroller, toggleBtn, visible = true;
  let initialized = false;

  // tag → CSS color
  // darkened so each tag stays legible on the warm parchment terminal
  const TAG_COLORS = {
    SPEAK:     '#B07E1C',
    DISPUTE:   '#C2502E',
    INFLUENCE: '#7B4FB0',
    FORECAST:  '#1E84A8',
    SCOUT:     '#5A4A94',
    KG:        '#2E7E76',
    STAKE:     '#3F9E5A',
    CONTRACT:  '#1E84A8',
    TX:        '#2E8C9E',
    CHAIN:     '#1E84A8',
    X402:      '#B07E1C',
    SETTLE:    '#5A8A2E',
    BIRTH:     '#B07E1C',
    DEATH:     '#6E5A3A',
    FOUND:     '#C07C1E',
    MIGRATE:   '#2E6FB0',
    SYSTEM:    '#6E655A'
  };

  // simple inline CSS injection — no edits to styles.css
  const CSS = `
    #ant-log {
      position: fixed; left: 14px; bottom: 14px; width: min(440px, 38vw); height: 150px;
      background: rgba(243, 235, 211, 0.95);
      border: 2px solid var(--gold-deep, #876012);
      border-radius: 6px; padding: 9px 12px;
      font-family: var(--mono, ui-monospace), monospace; font-size: 11px;
      color: var(--ink, #2C2820);
      overflow: hidden; backdrop-filter: blur(5px) saturate(1.05);
      -webkit-backdrop-filter: blur(5px) saturate(1.05);
      z-index: 4; pointer-events: auto;
      display: flex; flex-direction: column;
      box-shadow:
        inset 0 2px 0 rgba(255,252,224,.85),
        inset 0 -4px 0 rgba(120,84,24,.28),
        inset 2px 0 0 rgba(255,250,230,.45),
        inset -2px 0 0 rgba(120,84,24,.28),
        3px 4px 0 rgba(40,26,6,.45),
        0 10px 20px -12px rgba(40,26,6,.55);
    }
    #ant-log .log-head {
      display: flex; align-items: center; gap: 8px;
      padding-bottom: 6px; border-bottom: 1px solid rgba(74,58,30,.18);
      font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
      color: var(--ink-faint, #8C7E60); font-weight: 700;
    }
    #ant-log .log-head .dot {
      width: 7px; height: 7px; border-radius: 999px;
      background: #4E7E2A; box-shadow: 0 0 6px rgba(78,126,42,.8);
    }
    #ant-log .log-clear {
      margin-left: auto; cursor: pointer; padding: 3px 9px;
      color: #2a1d08; font-weight: 700; letter-spacing: 1px;
      border: 2px solid var(--gold-deep, #876012); border-radius: 5px;
      background: linear-gradient(180deg, #F6ECCB 0%, #E7D7AE 100%);
      box-shadow: inset 0 2px 0 rgba(255,252,224,.95), inset 0 -3px 0 rgba(120,84,24,.45), 2px 3px 0 rgba(40,26,6,.5);
      transition: transform .1s ease, filter .14s ease;
    }
    #ant-log .log-clear:hover { filter: brightness(1.06); transform: translateY(-1px); }
    #ant-log .log-clear:active { transform: translateY(1px); background: linear-gradient(180deg,#E0A828,#B07E1C); }
    #ant-log .log-scroll {
      flex: 1; overflow-y: auto; padding: 4px 4px 4px 0;
      scroll-behavior: smooth;
    }
    #ant-log .log-scroll::-webkit-scrollbar { width: 6px; }
    #ant-log .log-scroll::-webkit-scrollbar-thumb {
      background: rgba(135,96,18,.45); border-radius: 0;
    }
    #ant-log .log-row {
      display: flex; gap: 10px; padding: 2px 0;
      line-height: 1.45; opacity: 0; animation: log-in 240ms ease forwards;
    }
    @keyframes log-in {
      from { opacity: 0; transform: translateX(-4px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    #ant-log .log-ts {
      flex: none; width: 56px; color: var(--ink-faint, #8C7E60);
      font-variant-numeric: tabular-nums;
    }
    #ant-log .log-tag {
      flex: none; width: 76px; font-weight: 700; letter-spacing: 1px;
    }
    #ant-log .log-msg { flex: 1; word-break: break-word; color: var(--ink-soft, #5E5440); }
    #ant-log .log-msg .ant-ref {
      color: #876012; cursor: pointer;
      text-decoration: underline dotted rgba(135,96,18,.5);
    }
    #ant-log .log-msg .ant-ref:hover { color: #B07E1C; }
    #ant-log .log-msg .chain-ref {
      color: #1E6FA8;
      text-decoration: underline dotted rgba(30,111,168,.5);
    }
    #ant-log .log-msg .chain-ref:hover { color: #2E84C4; }
    #log-toggle {
      position: fixed; left: 14px; bottom: 174px;
      padding: 8px 14px; border-radius: 5px;
      background: linear-gradient(180deg, #F6ECCB 0%, #E7D7AE 100%);
      border: 2px solid var(--gold-deep, #876012);
      color: #2a1d08;
      font-family: var(--mono, ui-monospace), monospace;
      font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700;
      cursor: pointer; z-index: 5; pointer-events: auto;
      box-shadow: inset 0 2px 0 rgba(255,252,224,.95), inset 0 -3px 0 rgba(120,84,24,.45), 2px 3px 0 rgba(40,26,6,.5);
      transition: transform .1s ease, filter .14s ease;
    }
    #log-toggle:hover { filter: brightness(1.06); transform: translateY(-1px); }
    #log-toggle.on {
      background: linear-gradient(180deg, #E0A828 0%, #B07E1C 100%);
      border-color: var(--gold-deep, #876012); color: #2a1d08;
    }
  `;

  function fmtTime(d) {
    d = d || new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  // escape user-controlled text before injecting into the DOM
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Called after escapeHtml so the input is safe. Adds in-log affordances
  // for ant selection plus Arc contract / receipt URL inspection. We do
  // not auto-link 32-byte hashes as txs because market ids share the
  // same shape; tx links must arrive as explicit explorer URLs.
  function linkifyLogTokens(html) {
    return html.replace(/\b(https?:\/\/[^\s<]+|0x[a-fA-F0-9]{40}|ant[_-]\d{3,5}|[a-z0-9-]+\.colonny\.eth)\b/g, (m) => {
      if (/^https?:\/\//.test(m)) {
        return `<a class="chain-ref" href="${m}" target="_blank" rel="noreferrer">${m}</a>`;
      }
      if (/^0x[a-fA-F0-9]{40}$/.test(m)) {
        return `<a class="chain-ref" href="https://explorer.testnet.arc.network/address/${m}" target="_blank" rel="noreferrer">${m}</a>`;
      }
      if (/\.colonny\.eth$/.test(m)) {
        return `<span class="ant-ref" data-agent="${m}">${m}</span>`;
      }
      const id = m.replace('-', '_');
      return `<span class="ant-ref" data-agent="${id}">${m}</span>`;
    });
  }

  function onAntRefClick(ev) {
    const span = ev.target && ev.target.closest && ev.target.closest('.ant-ref');
    if (!span) return;
    const id = span.getAttribute('data-agent');
    if (!id || !DN.ants || !DN.ants.list) return;
    // Find an ant whose agentRecord matches the id (by agent_id or ens_name).
    const ant = DN.ants.list.find(a => a.agentRecord && (
      a.agentRecord.agent_id === id ||
      a.agentRecord.ens_name === id ||
      a.agentRecord.name === id
    )) || DN.ants.heroes.find(a => a.id === id) || null;
    if (ant && DN.app && DN.app.selectAnt) DN.app.selectAnt(ant);
  }

  function ensureUI() {
    if (initialized) return;
    initialized = true;
    const style = document.createElement('style');
    style.id = 'ant-log-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'ant-log';
    root.innerHTML =
      '<div class="log-head">' +
        '<span class="dot"></span><span>Colony Log · live</span>' +
        '<span class="log-clear" id="ant-log-clear">clear</span>' +
      '</div>' +
      '<div class="log-scroll" id="ant-log-scroll"></div>';
    document.body.appendChild(root);
    scroller = document.getElementById('ant-log-scroll');
    scroller.addEventListener('click', onAntRefClick);
    // Autoscroll = true by default. User pauses it by scrolling up
    // (wheel/touch/keyboard); resumes it by scrolling back to the
    // bottom. Programmatic scrollTop writes from flush() are excluded
    // via the _ignoreScroll flag.
    T._autoscroll = true;
    T._ignoreScroll = false;
    scroller.addEventListener('scroll', () => {
      if (T._ignoreScroll) return;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      T._autoscroll = atBottom;
    }, { passive: true });
    document.getElementById('ant-log-clear').addEventListener('click', () => T.clear());

    toggleBtn = document.createElement('button');
    toggleBtn.id = 'log-toggle';
    toggleBtn.textContent = 'Logs';
    toggleBtn.classList.add('on');
    toggleBtn.addEventListener('click', () => T.setVisible(!visible));
    document.body.appendChild(toggleBtn);

    // restore preference
    try {
      const saved = localStorage.getItem('ant-log-visible');
      if (saved === '0') T.setVisible(false);
    } catch (_) { /* ignore */ }

    // welcome row
    T.push('SYSTEM', 'Colony log initialised. Streaming live agent activity.');
  }

  T.init = function () { ensureUI(); return T; };

  // Buffered queue: pushes synchronously enqueue, then a single rAF flush
  // appends everything as one DocumentFragment so 60 push() calls in a row
  // cause one reflow, not 60. Drops the cost of bulk log streams from
  // ~120ms to ~5ms on a typical laptop.
  const _queue = [];
  let _flushScheduled = false;
  function scheduleFlush() {
    if (_flushScheduled) return;
    _flushScheduled = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb => setTimeout(cb, 16)))(flush);
  }
  function flush() {
    _flushScheduled = false;
    if (!_queue.length || !scroller) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < _queue.length; i++) {
      const item = _queue[i];
      const row = document.createElement('div');
      row.className = 'log-row';
      row.innerHTML =
        `<span class="log-ts">${item.ts}</span>` +
        `<span class="log-tag" style="color:${item.color}">${escapeHtml(item.level)}</span>` +
        `<span class="log-msg">${item.safe}</span>`;
      frag.appendChild(row);
    }
    _queue.length = 0;
    scroller.appendChild(frag);
    let overflow = scroller.children.length - MAX_ROWS;
    while (overflow-- > 0) scroller.removeChild(scroller.firstChild);
    if (T._autoscroll) {
      T._ignoreScroll = true;
      scroller.scrollTop = scroller.scrollHeight;
      // clear flag on next tick — the scroll event fires async
      setTimeout(() => { T._ignoreScroll = false; }, 0);
    }
  }

  // Append a row. opts can include { color, ts, antIds }.
  T.push = function (level, message, opts) {
    ensureUI();
    opts = opts || {};
    const ts = opts.ts ? fmtTime(new Date(opts.ts)) : fmtTime();
    const color = opts.color || TAG_COLORS[level] || '#FFD988';
    const safe = linkifyLogTokens(escapeHtml(message));
    _queue.push({ ts, color, level, safe });
    scheduleFlush();
  };

  T.clear = function () { if (scroller) scroller.innerHTML = ''; };

  T.setVisible = function (on) {
    visible = !!on;
    if (root) root.style.display = visible ? 'flex' : 'none';
    if (toggleBtn) toggleBtn.classList.toggle('on', visible);
    try { localStorage.setItem('ant-log-visible', visible ? '1' : '0'); } catch (_) { /* ignore */ }
  };

  return T;
})();
