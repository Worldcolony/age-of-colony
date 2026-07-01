// WorldColony — on-chain TX table. Small dark amber panel pinned to the
// right of the bottom log terminal. Lifecycle pushes Arc forecast-market
// transactions (create-market / fund / stake / settle / claim) here as
// they happen.
window.DN = window.DN || {};

DN.txTable = (function () {
  const T = {};
  const MAX_ROWS = 60;
  let root, listEl, countEl, initialized = false;

  const CSS = `
    #tx-table {
      display: none;
      position: fixed; right: 14px; bottom: 14px;
      width: 270px; height: 188px;
      background: rgba(12, 8, 4, 0.86);
      border: 1px solid rgba(196, 142, 68, 0.35);
      border-radius: 10px; padding: 8px 10px;
      font-family: var(--mono, ui-monospace), monospace; font-size: 10px;
      color: rgba(241, 216, 168, 0.82);
      overflow: hidden; backdrop-filter: blur(8px) saturate(1.05);
      -webkit-backdrop-filter: blur(8px) saturate(1.05);
      z-index: 4; pointer-events: auto;
      display: flex; flex-direction: column;
    }
    #tx-table .tx-head {
      display: flex; align-items: center; gap: 8px;
      padding-bottom: 6px; border-bottom: 1px solid rgba(196, 142, 68, 0.18);
      font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
      color: rgba(241, 216, 168, 0.55); font-weight: 700;
    }
    #tx-table .tx-head .tx-dot {
      width: 7px; height: 7px; border-radius: 999px;
      background: #8BE9FD; box-shadow: 0 0 6px #8BE9FD;
    }
    #tx-table .tx-count {
      margin-left: auto; color: rgba(241,216,168,0.45);
    }
    #tx-table .tx-list {
      flex: 1; overflow-y: auto; padding: 4px 4px 4px 0;
    }
    #tx-table .tx-list::-webkit-scrollbar { width: 5px; }
    #tx-table .tx-list::-webkit-scrollbar-thumb {
      background: rgba(196, 142, 68, 0.3); border-radius: 3px;
    }
    #tx-table .tx-row {
      display: flex; gap: 6px; padding: 3px 0;
      border-bottom: 1px dashed rgba(196, 142, 68, 0.08);
      opacity: 0; animation: tx-in 240ms ease forwards;
      line-height: 1.35;
    }
    @keyframes tx-in {
      from { opacity: 0; transform: translateY(-2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #tx-table .tx-act {
      flex: none; width: 60px; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    #tx-table .tx-act.create   { color: #8BE9FD; }
    #tx-table .tx-act.fund     { color: #FFB060; }
    #tx-table .tx-act.stake    { color: #6DD68A; }
    #tx-table .tx-act.settle   { color: #FFD988; }
    #tx-table .tx-act.claim    { color: #B47EE0; }
    #tx-table .tx-act.tx       { color: rgba(241,216,168,0.6); }
    #tx-table .tx-meta {
      flex: 1; min-width: 0;
      color: rgba(241,216,168,0.55);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #tx-table .tx-hash {
      flex: none; color: #FFD988; font-weight: 700;
      cursor: pointer; text-decoration: none;
    }
    #tx-table .tx-hash:hover { color: #FFE9A0; text-decoration: underline; }
    #tx-table .tx-empty {
      padding: 12px 0; color: rgba(241,216,168,0.35);
      text-align: center; font-size: 10px;
    }
  `;

  function shortHash(h) {
    const s = String(h || '');
    if (s.length < 12) return s;
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  function actClass(action) {
    const a = String(action || '').toLowerCase();
    if (a.includes('create')) return 'create';
    if (a.includes('fund') || a.includes('transfer')) return 'fund';
    if (a.includes('stake')) return 'stake';
    if (a.includes('settle')) return 'settle';
    if (a.includes('claim')) return 'claim';
    return 'tx';
  }

  function actLabel(action) {
    const a = String(action || 'tx');
    if (a.length > 9) return a.slice(0, 9);
    return a;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function ensureUI() {
    if (initialized) return;
    initialized = true;
    const style = document.createElement('style');
    style.id = 'tx-table-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'tx-table';
    root.innerHTML =
      '<div class="tx-head">' +
        '<span class="tx-dot"></span><span>Arc TX</span>' +
        '<span class="tx-count" id="tx-count">0</span>' +
      '</div>' +
      '<div class="tx-list" id="tx-list">' +
        '<div class="tx-empty">No on-chain transactions yet.</div>' +
      '</div>';
    document.body.appendChild(root);
    listEl = document.getElementById('tx-list');
    countEl = document.getElementById('tx-count');
  }

  let _count = 0;

  T.push = function (tx) {
    ensureUI();
    if (!tx || !tx.hash) return;
    // remove empty placeholder if present
    const empty = listEl.querySelector('.tx-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'tx-row';
    const action = tx.action || 'tx';
    const cls = actClass(action);
    const label = actLabel(action);
    const meta = [
      tx.agent_id || '',
      tx.amount_usdc ? tx.amount_usdc + ' USDC' : '',
      tx.outcome || ''
    ].filter(Boolean).join(' · ');
    const url = tx.explorer_url || '';
    const hashHtml = url
      ? '<a class="tx-hash" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="' + escapeHtml(tx.hash) + '">' + escapeHtml(shortHash(tx.hash)) + '</a>'
      : '<span class="tx-hash" title="' + escapeHtml(tx.hash) + '">' + escapeHtml(shortHash(tx.hash)) + '</span>';
    row.innerHTML =
      '<span class="tx-act ' + cls + '">' + escapeHtml(label) + '</span>' +
      '<span class="tx-meta">' + escapeHtml(meta) + '</span>' +
      hashHtml;
    listEl.appendChild(row);

    _count++;
    if (countEl) countEl.textContent = String(_count);

    // ring-buffer trim
    let overflow = listEl.children.length - MAX_ROWS;
    while (overflow-- > 0) listEl.removeChild(listEl.firstChild);

    // autoscroll to newest
    listEl.scrollTop = listEl.scrollHeight;
  };

  T.clear = function () {
    ensureUI();
    _count = 0;
    if (countEl) countEl.textContent = '0';
    if (listEl) listEl.innerHTML = '<div class="tx-empty">No on-chain transactions yet.</div>';
  };

  T.init = function () { ensureUI(); };

  return T;
})();
