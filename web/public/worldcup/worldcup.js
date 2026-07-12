/* ============================================================================
   WORLD CUP TEMP — predictions overlay logic + content render.
   Toggles the #wc-overlay layer and renders all content into #wc-content.
   Remove this file + its <script> (and the WORLD CUP TEMP blocks) after the cup.
   ============================================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- constants */
  var WALLET = '0xe9E32Ca24aa1eF725F650b5489281FE621363AA9';
  var TREASURY = '0xcc16bEC342794f35a32d4Ba2c76BF9D759C131eB';
  var ENS = 'worldcolony.eth';
  var LINK = {
    ens: 'https://app.ens.domains/' + ENS,
    etherscan: 'https://etherscan.io/address/' + WALLET,
    polygonscan: 'https://polygonscan.com/address/' + WALLET,
    polymarket: 'https://polymarket.com/@xi31ydqg4cnd?tab=activity',
    uma: 'https://oracle.uma.xyz/',
    clickhouse: 'https://ethglobalnyc-production-5ce3.up.railway.app',
    polygun: 'https://polygun.xyz',
    polymarketanalytics: 'https://polymarketanalytics.com'
  };
  function txUrl(h) { return 'https://polygonscan.com/tx/' + h; }
  function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }

  /* country name (as spelled in the KG) -> ISO-3166 alpha-2 for flagcdn */
  var TEAM_ISO = {
    'Algeria': 'dz', 'Argentina': 'ar', 'Australia': 'au', 'Austria': 'at', 'Belgium': 'be',
    'Bosnia & Herzegovina': 'ba', 'Brazil': 'br', 'Canada': 'ca', 'Cape Verde': 'cv',
    'Colombia': 'co', 'Croatia': 'hr', 'Curaçao': 'cw', 'Czech Republic': 'cz',
    'DR Congo': 'cd', 'Ecuador': 'ec', 'Egypt': 'eg', 'England': 'gb-eng', 'France': 'fr',
    'Germany': 'de', 'Ghana': 'gh', 'Haiti': 'ht', 'Iran': 'ir', 'Iraq': 'iq',
    'Ivory Coast': 'ci', 'Japan': 'jp', 'Jordan': 'jo', 'Mexico': 'mx', 'Morocco': 'ma',
    'Netherlands': 'nl', 'New Zealand': 'nz', 'Norway': 'no', 'Panama': 'pa', 'Paraguay': 'py',
    'Portugal': 'pt', 'Qatar': 'qa', 'Saudi Arabia': 'sa', 'Scotland': 'gb-sct', 'Senegal': 'sn',
    'South Africa': 'za', 'South Korea': 'kr', 'Spain': 'es', 'Sweden': 'se', 'Switzerland': 'ch',
    'Tunisia': 'tn', 'Turkey': 'tr', 'USA': 'us', 'Uruguay': 'uy', 'Uzbekistan': 'uz'
  };
  function flag(team, cls) {
    var iso = TEAM_ISO[team];
    if (iso) return '<img class="wc-flag ' + (cls || '') + '" loading="lazy" src="https://flagcdn.com/w80/' + iso + '.png" alt="' + esc(team) + '">';
    return '<span class="wc-flag wc-flag-tbd ' + (cls || '') + '">⚽</span>';
  }

  /* Bare predictions.json trades (#9-#12) carried only a polygun_market_id at execution time.
     Resolved 2026-06-23 by matching each trade's outcome_token_id against the ClickHouse
     markets catalog (default_v3.polymarket_markets_all). The trades' event/market_question/
     outcome are now also backfilled in predictions.json; this map is the confirmed registry
     (also supplies home/away + a date for the draw market, whose question has no date). */
  var MARKET_OVERRIDES = {
    '1897108': { home: 'Czech Republic', away: 'South Africa', date: '2026-06-18', pick: 'South Africa', question: 'Will South Africa win on 2026-06-18?' },
    '1897246': { home: 'Panama', away: 'Croatia', date: '2026-06-23', pick: 'Panama', question: 'Will Panama win on 2026-06-23?' },
    '1897121': { home: 'Scotland', away: 'Morocco', date: '2026-06-19', pick: 'Scotland', question: 'Will Scotland win on 2026-06-19?' },
    '1897171': { home: 'Belgium', away: 'Iran', date: '2026-06-21', kind: 'draw', question: 'Will Belgium vs. IR Iran end in a draw?' }
  };

  /* normalize team names so predictions.json strings match the KG fixtures */
  function normTeam(s) {
    if (!s) return '';
    var t = s.trim();
    var map = { 'Türkiye': 'Turkey', 'Turkiye': 'Turkey', "Côte d'Ivoire": 'Ivory Coast',
      "Cote d'Ivoire": 'Ivory Coast', 'USA': 'USA', 'United States': 'USA' };
    return map[t] || t;
  }

  /* ---------------------------------------------------------------- state */
  var S = { loaded: false, loading: false, predictions: null, simulated: null, games: null, error: null };

  function load() {
    if (S.loaded || S.loading) return Promise.resolve();
    S.loading = true;
    return Promise.all([
      fetch('/data/predictions.json').then(function (r) { return r.json(); }),
      fetch('/data/simulatedtransactions.json').then(function (r) { return r.json(); }),
      fetch('/data/worldcup-games.json').then(function (r) { return r.json(); })
    ]).then(function (res) {
      S.predictions = res[0]; S.simulated = res[1]; S.games = res[2];
      S.loaded = true; S.loading = false; S.error = null;
    }).catch(function (e) { S.error = String(e); S.loading = false; });
  }

  /* ---------------------------------------------------------------- helpers */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function usd(n) { return n == null ? '—' : '$' + Number(n).toFixed(2); }

  /* ---------------------------------------------------------------- render: hero */
  function hero() {
    return '' +
      '<header class="wc-hero">' +
        '<img class="wc-hero-ball" src="/worldcup/soccerball.svg" alt="">' +
        '<div class="wc-eyebrow">WorldColony · Ant Colony Forecasts</div>' +
        '<h1>World Cup Predictions</h1>' +
        '<p>A colony of autonomous AI “ants” forecasts World Cup matches, debates to ' +
        'consensus, and places real on-chain bets. Forecasting is the labor; the USDC market ' +
        'is the judge. Every trade below is verifiable on-chain — identity on Ethereum ' +
        '(<a href="' + LINK.ens + '" target="_blank" rel="noopener">' + ENS + '</a>), execution on Polygon.</p>' +
      '</header>';
  }

  /* ---------------------------------------------------------------- render: wallet */
  function walletCard() {
    var p = S.predictions || {};
    var tok = p.settlement_token || {};
    return '' +
      '<section class="wc-section"><h2>Trading Identity</h2>' +
      '<div class="wc-card wc-wallet">' +
        '<div>' +
          '<div class="wc-ens"><span class="wc-dot"></span>' + ENS + '<span class="wc-chain-tag">Ethereum · ENS</span></div>' +
          '<div class="wc-kv">' +
            '<div class="wc-row"><span class="wc-k">Resolves to / trades as</span><span class="wc-v">' + WALLET + '</span></div>' +
            '<div class="wc-row"><span class="wc-k">Treasury</span><span class="wc-v">' + TREASURY + '</span></div>' +
            '<div class="wc-row"><span class="wc-k">Settlement token</span><span class="wc-v">' +
              esc(tok.symbol || 'pUSD') + ' · ' + esc(tok.name || 'Polymarket USD') + ' · Polygon</span></div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="wc-strat"><span class="wc-tag">Verify on-chain</span></div>' +
          '<div class="wc-btns" style="margin-top:10px">' +
            btn(LINK.polygonscan, 'PolygonScan · trades', false) +
            btn(LINK.polymarket, 'Polymarket profile', false) +
            btn(LINK.ens, 'ENS', true) +
            btn(LINK.etherscan, 'Etherscan', true) +
          '</div>' +
          '<p style="margin-top:14px;font-size:11.5px;color:var(--ink-soft);line-height:1.6">' +
            'Identity lives on Ethereum mainnet as <b>' + ENS + '</b>; the same address executes ' +
            'trades on Polygon via our Polymarket rail (PolyGun). One address, two chains.</p>' +
        '</div>' +
      '</div></section>';
  }
  function btn(href, label, ghost) {
    return '<a class="wc-btn' + (ghost ? ' is-ghost' : '') + '" href="' + href + '" target="_blank" rel="noopener">' +
      esc(label) + ' <span class="wc-ext">↗</span></a>';
  }

  /* ---------------------------------------------------------------- prediction index */
  /* Parse predictions.json (real) + simulatedtransactions.json into per-match picks
     keyed for fixture lookup. Returns { perMatch:[...], outrights:[...] }. */
  function buildIndex() {
    var out = { perMatch: [], outrights: [] };
    var P = S.predictions || {}; var trades = P.trades || [];
    trades.forEach(function (t) {
      var ov = MARKET_OVERRIDES[String(t.polygun_market_id)];
      var mq = t.market_question || (ov && ov.question) || '';
      var ev = t.event || '';
      // outright / tournament-winner markets
      if (/world cup winner/i.test(ev) || /win the .*world cup/i.test(mq)) {
        out.outrights.push({ team: pickTeam(t, ov), trade: t });
        return;
      }
      var date = (mq.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || (ov && ov.date) || null;
      // draw markets ("...end in a draw?") don't name a winning team — pin them to the
      // fixture via the override's home/away teams instead of a team pick.
      var isDraw = (ov && ov.kind === 'draw') || /\bdraw\b/i.test(mq) || /\bdraw\b/i.test(t.outcome || '');
      if (isDraw && date) {
        out.perMatch.push({ date: date, pick: 'DRAW',
          teams: ov ? [normTeam(ov.home), normTeam(ov.away)] : null,
          side: t.side, price: t.avg_price, phase: t.bet_phase, method: t.method,
          placed_by: t.placed_by, status: t.status, tx: t.tx_hash, simulated: false, id: t.id });
        return;
      }
      var pick = pickTeam(t, ov);
      if (date && pick) {
        out.perMatch.push({ date: date, pick: normTeam(pick), side: t.side, price: t.avg_price,
          phase: t.bet_phase, method: t.method, placed_by: t.placed_by, status: t.status,
          tx: t.tx_hash, simulated: false, id: t.id });
      }
    });
    // simulated reads (study-only) — attach to their fixtures as "sim"
    var SM = S.simulated || {}; var ctx = SM.context || {};
    (SM.simulated_trades || []).forEach(function (st) {
      var pick = null, date = ctx.date || null;
      // map the known simulated reads onto a team in the relevant fixture
      var m = (st.market_question || '') + ' ' + (st.outcome || '') + ' ' + (st.event || '');
      if (/draw/i.test(m)) pick = 'DRAW';
      else if (/under/i.test(m)) pick = 'UNDER 2.5';
      else if (/australia/i.test(m)) { pick = 'Australia'; date = '2026-06-14'; }
      if (pick) out.perMatch.push({ date: date, pick: pick, simulated: true,
        note: st.market_question || st.outcome, status: st.status });
    });
    return out;
  }
  /* "claude" is just one ant — the autonomous engine is the whole swarm.
     Any named human placer is shown generically as "Human-Executed". */
  function placedByLabel(x) {
    if (!x) return '';
    if (String(x).toLowerCase() === 'claude') return 'ANT-AI Engine';
    return 'Human-Executed';
  }
  function pickTeam(t, ov) {
    if (ov && ov.pick) return ov.pick;
    var o = t.outcome || '';
    var m = o.match(/\(([^)]+)\)/);            // "Yes (Switzerland)" -> Switzerland
    if (m) return m[1];
    var q = (t.market_question || '').match(/Will ([\w .'’&-]+?) win/i);
    return q ? q[1] : null;
  }
  /* find the colony's pick(s) for a fixture */
  function betsFor(idx, g) {
    var teams = [normTeam(g.home_team), normTeam(g.away_team)];
    return idx.perMatch.filter(function (b) {
      if (b.date !== g.date) return false;
      if (b.pick === 'DRAW' || b.pick === 'UNDER 2.5') {
        // draw/over-under bets carry their own fixture teams when known (e.g. Belgium vs Iran);
        // otherwise fall back to the Qatar/Switzerland study reads.
        if (b.teams && b.teams.length === 2) {
          return teams.indexOf(b.teams[0]) >= 0 && teams.indexOf(b.teams[1]) >= 0;
        }
        return teams.indexOf('Switzerland') >= 0 && teams.indexOf('Qatar') >= 0;
      }
      return teams.indexOf(normTeam(b.pick)) >= 0;
    });
  }
  /* Live clock: derive past/upcoming from the viewer's real time vs each match's kickoff.
     Kickoff is built from the KG's date + "HH:MM UTC±N" string, so it's an absolute instant
     regardless of the viewer's timezone. Games with no parseable time fall back to a date
     compare against the viewer's local date. (Later: prefer a server `as_of` from
     /worldcup/feed over the client clock — see notes/handover/colony-api-worldcup-feed.md.) */
  function nowMs() { return Date.now(); }
  function localToday() {
    var n = new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate());
  }
  /* parse g.date ("2026-06-23") + g.time ("19:00 UTC-4") -> epoch ms, or null if no time.
     "UTC-4" means the local clock is 4h behind UTC, so the UTC instant is (local - offset). */
  function kickoffMs(g) {
    if (!g || !g.date) return null;
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(g.date);
    if (!dm) return null;
    var tm = /(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})/.exec(g.time || '');
    if (!tm) return null;
    return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], (+tm[1]) - (+tm[3]), +tm[2]);
  }
  /* sortable instant for ordering "next match"; date-only games sort at local noon */
  function whenMs(g) {
    var k = kickoffMs(g);
    if (k != null) return k;
    var dm = g && g.date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(g.date);
    if (dm) return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 12, 0);
    return Infinity;
  }
  function isPast(g) {
    var k = kickoffMs(g);
    if (k != null) return k < nowMs();        // timed match: compare to the real clock
    if (!g || !g.date) return false;          // undated TBD fixture -> treat as upcoming
    return g.date < localToday();             // dated but no time -> date compare
  }
  function isUpcoming(g) { return !isPast(g); }

  /* Knockout fixtures in the KG use unresolved bracket tokens for teams ("1C", "2F",
     "3A/B/C/D/F", "W73", "L101") because group results aren't recorded. Those aren't real
     matchups, so we skip them in the next-match + upcoming list until they resolve. */
  function isBracketToken(name) { return /[0-9]/.test(name || '') || String(name || '').indexOf('/') >= 0; }
  function isResolvedFixture(g) { return g && !isBracketToken(g.home_team) && !isBracketToken(g.away_team); }

  /* ---------------------------------------------------------------- render: matches */
  function matchesSection() {
    if (!S.loaded) return '<section class="wc-section" id="wc-matches"><h2>Match Schedule &amp; Colony Picks</h2>' +
      '<div class="wc-lead">The upcoming matches and the colony’s call on each.</div>' +
      '<div class="wc-loading">Loading matches…</div></section>';

    var games = (S.games && S.games.games) || [];
    var idx = buildIndex();
    // upcoming, real matchups only (skip unresolved knockout bracket slots), sorted by true
    // kickoff instant so "next" is correct regardless of viewer timezone
    var upcoming = games.filter(function (g) { return isUpcoming(g) && isResolvedFixture(g); })
      .slice().sort(function (a, b) { return whenMs(a) - whenMs(b); });
    var next = upcoming[0];
    // is there knockout action coming that just hasn't resolved to real teams yet?
    var bracketPending = games.some(function (g) { return isUpcoming(g) && !isResolvedFixture(g); });
    // games the colony actually weighed in on (real or simulated)
    var picked = games.filter(function (g) { return betsFor(idx, g).length > 0; });

    var html = '<section class="wc-section" id="wc-matches"><h2>Match Schedule &amp; Colony Picks</h2>' +
      '<div class="wc-lead">Matches come from the same World Cup knowledge graph the ants forecast ' +
      'against. A badge shows whether the colony has a position on each match.</div>';

    if (next) html += nextCard(next, betsFor(idx, next));
    else if (bracketPending) html += bracketPendingCard();

    if (picked.length) {
      html += '<h3 style="font-family:var(--display);font-size:12px;color:#FFE7A8;margin:26px 0 4px">Colony’s match picks</h3>' +
        '<div class="wc-fixtures">' + picked.map(function (g) { return fixCard(g, betsFor(idx, g)); }).join('') + '</div>';
    }

    var rail = upcoming.slice(0, 12);
    if (rail.length) {
      html += '<h3 style="font-family:var(--display);font-size:12px;color:#FFE7A8;margin:26px 0 4px">Upcoming matches</h3>' +
        '<div class="wc-fixtures">' + rail.map(function (g) { return fixCard(g, betsFor(idx, g)); }).join('') + '</div>';
    } else if (bracketPending && next == null) {
      // already showed the bracket-pending hero card above; no rail to render
    }

    return html + '</section>';
  }

  /* graceful state when every upcoming fixture is an unresolved knockout slot */
  function bracketPendingCard() {
    return '<div class="wc-card wc-next wc-bracket-pending" style="margin-top:18px">' +
      '<div class="wc-vs"><span class="wc-mid" style="font-size:30px">🏆</span></div>' +
      '<div class="wc-meta">' +
        '<div style="font-family:var(--mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-deep);font-weight:700">Next match</div>' +
        '<div style="margin-top:6px"><b>Group stage complete</b></div>' +
        '<div>Knockout bracket resolving — fixtures appear here once teams are set.</div>' +
      '</div>' +
      '<div></div>' +
    '</div>';
  }

  function kickoff(g) {
    var d = g.date || 'TBD';
    var t = g.time ? ' · ' + g.time : '';
    return d + t;
  }
  function badgeFor(g, bets) {
    if (!bets.length) return '<span class="wc-badge is-none">No position</span>';
    var real = bets.filter(function (b) { return !b.simulated; });
    var sim = bets.filter(function (b) { return b.simulated; });
    var parts = [];
    real.forEach(function (b) {
      var cls = 'is-bet', label = 'Colony: ' + esc(b.pick);
      if (g.played && b.pick !== 'DRAW' && b.pick !== 'UNDER 2.5') {
        var won = didPickWin(g, b.pick);
        if (won === true) { cls = 'is-win'; label = '✓ ' + esc(b.pick); }
        else if (won === false) { cls = 'is-loss'; label = '✗ ' + esc(b.pick); }
      }
      parts.push('<span class="wc-badge ' + cls + '">' + label + (b.price ? ' @ ' + Math.round(b.price * 100) + '¢' : '') + '</span>');
    });
    sim.forEach(function (b) { parts.push('<span class="wc-badge is-sim">sim: ' + esc(b.pick) + '</span>'); });
    return parts.join(' ');
  }
  /* crude: did the picked team win, from the KG score [home,away] ft */
  function didPickWin(g, pick) {
    if (!g.score || !g.score.ft) return null;
    var ft = g.score.ft; var h = ft[0], a = ft[1];
    var pickHome = normTeam(pick) === normTeam(g.home_team);
    var pickAway = normTeam(pick) === normTeam(g.away_team);
    if (!pickHome && !pickAway) return null;
    if (h === a) return false;              // draw -> a "win" pick loses
    var homeWon = h > a;
    return pickHome ? homeWon : !homeWon;
  }

  function nextCard(g, bets) {
    return '<div class="wc-card wc-next" style="margin-top:18px">' +
      '<div class="wc-vs">' +
        '<div class="wc-team">' + flag(g.home_team) + '<span class="wc-name">' + esc(g.home_team) + '</span></div>' +
        '<span class="wc-mid">vs</span>' +
        '<div class="wc-team">' + flag(g.away_team) + '<span class="wc-name">' + esc(g.away_team) + '</span></div>' +
      '</div>' +
      '<div class="wc-meta">' +
        '<div style="font-family:var(--mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-deep);font-weight:700">Next match</div>' +
        '<div style="margin-top:6px"><b>' + esc(kickoff(g)) + '</b></div>' +
        '<div>' + esc(g.group || g.stage || '') + (g.venue ? ' · ' + esc(g.venue) : '') + '</div>' +
      '</div>' +
      '<div style="text-align:right">' + badgeFor(g, bets) + '</div>' +
    '</div>';
  }

  function fixCard(g, bets) {
    var result = (g.played && g.score && g.score.ft) ? '<span class="wc-score">' + g.score.ft[0] + '–' + g.score.ft[1] + '</span>' : esc(g.time || '');
    return '<div class="wc-fix">' +
      '<div class="wc-fix-top"><span class="wc-fix-date">' + esc(g.date || 'TBD') + '</span>' + badgeFor(g, bets) + '</div>' +
      '<div class="wc-fix-teams">' + flag(g.home_team) + '<span>' + esc(g.home_team) + '</span>' +
        '<span class="wc-sep">v</span><span>' + esc(g.away_team) + '</span>' + flag(g.away_team) + '</div>' +
      '<div class="wc-fix-foot"><span>' + esc(g.group || g.stage || '') + '</span>' + result + '</div>' +
    '</div>';
  }

  /* ---------------------------------------------------------------- render: outright bets */
  function outrightSection() {
    if (!S.loaded) return '';
    var outs = buildIndex().outrights;
    if (!outs.length) return '';
    return '<section class="wc-section" id="wc-outright"><h2>Outright / Futures</h2>' +
      '<div class="wc-lead">Tournament-winner bets — not tied to a single match. The colony’s ' +
      'long-horizon call on who lifts the trophy.</div>' +
      '<div class="wc-outright">' + outs.map(function (o) {
        var t = o.trade;
        return '<div class="wc-card">' +
          '<div style="display:flex;align-items:center;gap:11px">' + flag(o.team) +
            '<div><div style="font-family:var(--display);font-size:13px;color:var(--ink)">' + esc(o.team) + ' — to win</div>' +
            '<div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:4px;text-transform:uppercase;letter-spacing:.1em">2026 FIFA World Cup</div></div></div>' +
          '<div class="wc-kv" style="margin-top:14px">' +
            kv('Entry', (t.avg_price != null ? Math.round(t.avg_price * 100) + '¢' : '—') + ' · ' + (t.shares != null ? Number(t.shares).toFixed(2) + ' sh' : '')) +
            kv('Cost', usd(t.pusd_total)) +
            kv('Status', esc((t.status || 'open').toUpperCase())) +
          '</div>' +
          (t.tx_hash ? '<div class="wc-btns" style="margin-top:12px">' + btn(txUrl(t.tx_hash), 'View tx', true) + '</div>' : '') +
        '</div>';
      }).join('') + '</div></section>';
  }
  function kv(k, v) { return '<div class="wc-row"><span class="wc-k">' + esc(k) + '</span><span class="wc-v">' + v + '</span></div>'; }

  /* ---------------------------------------------------------------- render: real trades */
  function tradeMatchLabel(t) {
    if (t.event) return esc(t.event);
    var ov = MARKET_OVERRIDES[String(t.polygun_market_id)];
    if (ov) return esc((ov.home || '') + ' vs ' + (ov.away || '') + (ov.date ? ' (' + ov.date + ')' : ''));
    return '<span style="color:var(--ink-faint)">Market #' + esc(t.polygun_market_id) + '</span>';
  }
  function tradesSection() {
    if (!S.loaded) return '<section class="wc-section" id="wc-trades"><h2>On-chain Ledger</h2>' +
      '<div class="wc-loading">Loading trades…</div></section>';
    var P = S.predictions || {}; var trades = (P.trades || []).slice();
    var idx = buildIndex();
    var outrightIds = {}; idx.outrights.forEach(function (o) { outrightIds[o.trade.id] = true; });
    var matchTrades = trades.filter(function (t) { return !outrightIds[t.id]; });
    // latest bets first
    matchTrades.sort(function (a, b) { return String(b.ts_utc || '').localeCompare(String(a.ts_utc || '')); });
    var unmapped = matchTrades.filter(function (t) { return !t.event && !MARKET_OVERRIDES[String(t.polygun_market_id)]; }).length;

    var rows = matchTrades.map(function (t) {
      var pick = pickTeam(t) || '—';
      var phase = t.bet_phase ? '<div style="font-family:var(--mono);font-size:8px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint);margin-top:3px">' + esc(t.bet_phase) + '</div>' : '';
      var by = '<span class="wc-method ' + (t.method === 'auto' ? 'is-auto' : 'is-manual') + '">' + esc(t.method || '') + '</span>';
      var size = (t.shares != null ? Number(t.shares).toFixed(2) + ' sh' : '') +
        (t.avg_price != null ? ' @ ' + Math.round(t.avg_price * 100) + '¢' : '') +
        '<div style="color:var(--ink-faint)">' + usd(t.pusd_total) + '</div>';
      var tx = t.tx_hash ? '<a class="wc-tx" href="' + txUrl(t.tx_hash) + '" target="_blank" rel="noopener">' + t.tx_hash.slice(0, 8) + '… ↗</a>' : '—';
      var note = t.note ? '<div class="wc-note">' + esc(t.note) + '</div>' : '';
      return '<tr>' +
        '<td><div class="wc-pick">' + tradeMatchLabel(t) + '</div>' + note + '</td>' +
        '<td class="wc-num">' + esc((t.ts_utc || '').slice(0, 10)) + '</td>' +
        '<td><span class="wc-pick">' + esc(pick) + '</span>' + phase + '</td>' +
        '<td>' + by + '<div style="font-size:10px;color:var(--ink-faint);margin-top:3px">' + esc(placedByLabel(t.placed_by)) + '</div></td>' +
        '<td class="wc-num">' + size + '</td>' +
        '<td>' + esc(t.status || '') + '</td>' +
        '<td>' + tx + '</td>' +
      '</tr>';
    }).join('');

    return '<section class="wc-section" id="wc-trades"><h2>On-chain Ledger</h2>' +
      '<div class="wc-lead">Real, executed trades — settled in <b>pUSD on Polygon</b>, verifiable by ' +
      'transaction hash. Picks come from the colony’s consensus, placed either with a human pressing ' +
      'the final button or fully autonomously by code — through our Polymarket execution layers ' +
      '(<a href="' + LINK.polygun + '" target="_blank" rel="noopener">PolyGun</a> and ' +
      '<a href="' + LINK.polymarketanalytics + '" target="_blank" rel="noopener">Polymarket Analytics</a>).</div>' +
      '<div class="wc-table-wrap"><table class="wc-table"><thead><tr>' +
        '<th>Match</th><th>Date</th><th>Pick</th><th>By</th><th>Size</th><th>Status</th><th>Tx</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (unmapped ? '<div class="wc-loading" style="font-size:11px">' + unmapped + ' trade(s) carry only a market id ' +
        '(no match metadata in predictions.json) — shown by market #. Map them in MARKET_OVERRIDES once confirmed from the Polymarket profile.</div>' : '') +
      '</section>';
  }

  /* ---------------------------------------------------------------- render: simulated */
  function simSection() {
    if (!S.loaded) return '<section class="wc-section" id="wc-sim"><h2>Counterfactual Ledger</h2><div class="wc-loading">Loading…</div></section>';
    var SM = S.simulated || {}; var ctx = SM.context || {};
    var cards = (SM.simulated_trades || []).map(function (st) {
      var pnl = st.hypothetical_net_pnl_usd;
      return '<div class="wc-card">' +
        '<div style="font-family:var(--display);font-size:12px;color:var(--ink);line-height:1.4">' + esc(st.market_question || st.outcome || '') + '</div>' +
        '<div class="wc-kv" style="margin-top:12px">' +
          kv('Outcome', esc(st.outcome || '')) +
          kv('Entry', (st.assumed_entry_price != null ? Math.round(st.assumed_entry_price * 100) + '¢' : '—') + (st.stake_usd ? ' · ' + usd(st.stake_usd) + ' stake' : '')) +
          kv('Hypothetical P&L', (pnl != null ? (pnl >= 0 ? '+' : '') + usd(pnl) : '—')) +
          kv('Status', esc((st.status || '').replace(/_/g, ' '))) +
        '</div>' +
        (st.why_not_executed ? '<p style="margin-top:12px;font-size:11.5px;color:var(--ink-soft);line-height:1.55">' + esc(st.why_not_executed) + '</p>' : '') +
      '</div>';
    }).join('');
    var lessons = (SM.lessons || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    return '<section class="wc-section" id="wc-sim"><h2>Counterfactual Ledger</h2>' +
      '<div style="margin:6px 0 14px"><span class="wc-sim-banner">⚠ Simulated — not executed · no funds moved</span></div>' +
      '<div class="wc-lead">Bets the colony <i>identified</i> but didn’t place in time — kept separate to study one ' +
      'question honestly: what would our edge have produced if execution speed matched our information? ' +
      'Context: <b>' + esc(ctx.event || '') + '</b> (' + esc(ctx.reported_final_score || '') + ').</div>' +
      '<div class="wc-outright" style="margin-top:16px">' + cards + '</div>' +
      (lessons ? '<h3 style="font-family:var(--display);font-size:12px;color:#FFE7A8;margin:26px 0 4px">Lessons</h3><ul class="wc-lessons">' + lessons + '</ul>' : '') +
    '</section>';
  }

  /* ---------------------------------------------------------------- render: strategy blurbs */
  function strategySection() {
    return '<section class="wc-section"><h2>Looking for Edges</h2>' +
      '<div class="wc-strategy">' +
        strat('Arbitrage', 'Bet the gap',
          'Our edge is the spread between the colony’s read and the live market price. When the ' +
          'colony saw Qatar–Switzerland heading for a 1–1 draw, the draw still traded at ~3.5¢ ' +
          'and the Under 2.5 at ~33¢ — both mispriced against the outcome we expected. The calls ' +
          'were right; we lost the edge to <b>speed and venue</b>, not a wrong prediction.', null, null) +
        strat('UMA Oracle', 'The oracle is ground truth',
          'Polymarket’s markets settle on UMA’s Optimistic Oracle — the resolution and dispute ' +
          'events we decode in ClickHouse. Reading the oracle tells us how a market <i>will</i> resolve ' +
          'before the crowd reprices, and where <b>not</b> to trade: you can’t scalp a 96-99¢ winner at ' +
          'the close.',
          LINK.uma, 'UMA Optimistic Oracle') +
        strat('Privileged Data', 'A metered knowledge plane',
          'The ants query a private ClickHouse API of Polymarket odds time-series + decoded UMA events. ' +
          'Three rules keep it honest: a <b>timestamp gate</b> (every query enforces ts ≤ as_of, no ' +
          'lookahead), <b>x402 metering</b> (pay-to-read in USDC — thinking costs money), and a ' +
          '<b>Worldcoin-verified tier</b> (proven humans get a discount). Priced, gated, hindsight-free.',
          LINK.clickhouse + '/config', 'ClickHouse API · /config') +
      '</div></section>';
  }
  function strat(tag, title, body, href, linkLabel) {
    return '<div class="wc-card wc-strat">' +
      '<span class="wc-tag">' + esc(tag) + '</span>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + body + '</p>' +
      (href ? '<div class="wc-btns">' + btn(href, linkLabel, true) + '</div>' : '') +
      '</div>';
  }

  function footer() {
    return '<footer class="wc-foot">' +
      'World Colony © 2026 · ' + ENS + ' · trades on Polygon, identity on Ethereum, settlement on Arc testnet.' +
      '</footer>';
  }

  /* ---------------------------------------------------------------- main render */
  function render() {
    var root = document.getElementById('wc-content');
    if (!root) return;
    if (S.error) { root.innerHTML = '<div class="wc-wrap"><div class="wc-loading">Failed to load data: ' + esc(S.error) + '</div></div>'; return; }
    root.innerHTML = '<div class="wc-wrap">' +
      hero() + walletCard() + matchesSection() + outrightSection() + tradesSection() + simSection() + strategySection() + footer() +
      '</div>';
  }

  /* ---------------------------------------------------------------- overlay toggle */
  var body = document.body;
  var cta = document.getElementById('wc-cta');
  var back = document.getElementById('wc-back');
  var overlay = document.getElementById('wc-overlay');
  function open(e) {
    if (e) e.preventDefault();
    body.classList.add('wc-open'); if (overlay) overlay.setAttribute('aria-hidden', 'false');
    load().then(render); render();
  }
  function close(e) { if (e) e.preventDefault(); body.classList.remove('wc-open'); if (overlay) overlay.setAttribute('aria-hidden', 'true'); }
  if (cta) cta.addEventListener('click', open);
  if (back) back.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && body.classList.contains('wc-open')) close(e); });

  window.WorldCup = { open: open, close: close, _state: S };
})();
