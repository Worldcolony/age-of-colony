// WorldColony — KG view: lightweight live graph overlay for scouting/KG events.
window.DN = window.DN || {};

DN.kgview = (function () {
  const K = {};
  let root = null;
  let svg = null;
  let statusEl = null;
  let detailEl = null;
  let legendEl = null;
  let nodes = new Map();
  let edges = [];
  let selectedId = null;
  let renderQueued = false;
  let replayTimers = [];
  const nodeActivity = new Map();
  const colors = {
    match: '#3FA89F',
    team: '#E8A23D',
    scout: '#8E79C4',
    finding: '#D96E54',
    evidence_claim: '#4E7E2A',
    source: '#5E5440',
    player: '#B07E1C',
    club: '#4F8FA8',
    position: '#6C8F3D',
    default: '#2C2820',
  };
  const groupDefs = [
    // Layout: upstream's granular groups (players + clubs split from
    // teams) + my brighter dark-mode palette so categories pop on the
    // dark amber panel background.
    { id: 'matches', label: 'Matches', types: ['match', 'match_result'], x: 470, y: 220, color: '#66E0FF' },
    { id: 'teams', label: 'Teams', types: ['team', 'team_match_profile'], x: 210, y: 230, color: '#FFD988' },
    { id: 'players', label: 'Players', types: ['player', 'player_match_profile', 'player_stat_line'], x: 390, y: 345, color: '#E89B3B' },
    { id: 'clubs', label: 'Clubs', types: ['club'], x: 650, y: 230, color: '#5DB0E8' },
    { id: 'scouts', label: 'Scouts', types: ['scout', 'scout_match_profile', 'prediction', 'predictor', 'genome'], x: 735, y: 345, color: '#B47EE0' },
    { id: 'evidence', label: 'Evidence', types: ['finding', 'evidence_claim', 'debate_claim', 'scouting_topic', 'team_scouting_topic', 'scouting_gap'], x: 470, y: 115, color: '#FF8B6B' },
    { id: 'sources', label: 'Sources', types: ['source', 'source_domain', 'source_domain_profile', 'source_kind', 'source_quality', 'source_recency'], x: 800, y: 115, color: '#FFB060' },
    { id: 'context', label: 'Context', types: ['venue', 'group', 'stage', 'claim_type', 'claim_impact', 'claim_quality', 'metric', 'formation', 'position', 'availability_event', 'availability_status', 'body_part'], x: 150, y: 115, color: '#6DD68A' },
  ];
  const groupByType = {};
  groupDefs.forEach((group) => group.types.forEach((type) => { groupByType[type] = group; }));

  function ensure() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'kg-overlay';
    root.className = 'panel';
    root.innerHTML =
      '<div class="kg-head">' +
        '<div><div class="kg-k">Knowledge Graph</div><div class="kg-title" id="kg-title">KG stream</div></div>' +
        '<button class="kg-close" id="kg-close">×</button>' +
      '</div>' +
      '<div class="kg-status" id="kg-status">Waiting for graph events...</div>' +
      '<div class="kg-legend" id="kg-legend"></div>' +
      '<svg id="kg-svg" viewBox="0 0 940 460" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<div class="kg-detail" id="kg-detail">Click a node for details.</div>';
    document.body.appendChild(root);
    svg = root.querySelector('#kg-svg');
    statusEl = root.querySelector('#kg-status');
    detailEl = root.querySelector('#kg-detail');
    legendEl = root.querySelector('#kg-legend');
    root.querySelector('#kg-close').addEventListener('click', () => root.classList.remove('show'));
    svg.addEventListener('click', (event) => {
      const nodeEl = event.target.closest && event.target.closest('.kg-node');
      if (!nodeEl) return;
      selectNode(decodeURIComponent(nodeEl.getAttribute('data-node')));
    });
    svg.addEventListener('keydown', (event) => {
      const nodeEl = event.target.closest && event.target.closest('.kg-node');
      if (!nodeEl || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      selectNode(decodeURIComponent(nodeEl.getAttribute('data-node')));
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function labelFor(entity) {
    return entity.name || entity.entity_id || entity.id || 'node';
  }

  function typeFor(entity) {
    return entity.entity_type || entity.type || 'default';
  }

  function groupFor(entity) {
    return groupByType[typeFor(entity)] || { id: 'other', label: 'Other', x: 470, y: 95, color: colors.default };
  }

  function shortLabel(value) {
    const label = String(value || '');
    return label.length > 30 ? label.slice(0, 28) + '...' : label;
  }

  function relationLabel(value) {
    return String(value || 'related_to').replace(/_/g, ' ');
  }

  function compactValue(value) {
    if (value == null || value === '') return 'n/a';
    if (Array.isArray(value)) return value.join(' - ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function slug(value) {
    return String(value || 'node')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'node';
  }

  function nodeUrl(id) {
    return '#kg/' + encodeURIComponent(id);
  }

  function attributesFor(node) {
    const attrs = node.attributes || {};
    return Object.keys(attrs)
      .filter((key) => attrs[key] != null && attrs[key] !== '')
      .slice(0, 8)
      .map((key) => ({ key, value: compactValue(attrs[key]) }));
  }

  function relatedFor(id) {
    return edges
      .map((edge) => {
        const sourceId = edge.source_id || edge.source;
        const targetId = edge.target_id || edge.target;
        if (sourceId !== id && targetId !== id) return null;
        const neighborId = sourceId === id ? targetId : sourceId;
        const node = nodes.get(neighborId);
        if (!node) return null;
        return {
          edge,
          node,
          id: neighborId,
          outgoing: sourceId === id,
          relation: relationLabel(edge.relation_type),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aMatch = typeFor(a.node) === 'match' ? 0 : 1;
        const bMatch = typeFor(b.node) === 'match' ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return labelFor(a.node).localeCompare(labelFor(b.node));
      });
  }

  function describeNode(node, related) {
    const type = typeFor(node);
    if (type === 'team') {
      const matches = related.filter((item) => typeFor(item.node) === 'match');
      const home = related.filter((item) => item.edge.relation_type === 'plays_home_in').length;
      const away = related.filter((item) => item.edge.relation_type === 'plays_away_in').length;
      return matches.length + ' linked matches · ' + home + ' home · ' + away + ' away';
    }
    if (type === 'match') {
      const attrs = node.attributes || {};
      const teams = related.filter((item) => typeFor(item.node) === 'team').map((item) => labelFor(item.node));
      return [teams.join(' vs '), attrs.date, attrs.time, attrs.ground].filter(Boolean).join(' · ');
    }
    if (type === 'evidence_claim' || type === 'finding') {
      return related.length + ' linked KG nodes';
    }
    return related.length + ' connected nodes';
  }

  function contextMatchMarkup(node, related) {
    const type = typeFor(node);
    if (!['stage', 'venue', 'group', 'tournament'].includes(type)) return '';
    const matches = related.filter((item) => typeFor(item.node) === 'match');
    if (!matches.length) return '';
    return '<div class="kg-subhead">Context data from linked matches</div>' +
      '<div class="kg-links">' +
      matches.slice(0, 8).map((item) => {
        const attrs = item.node.attributes || {};
        const bits = [attrs.date, attrs.time, attrs.ground].filter(Boolean).join(' · ');
        return '<a href="' + nodeUrl(item.id) + '" data-kg-jump="' + encodeURIComponent(item.id) + '">' +
          '<i>match</i>' +
          '<span>' + escapeHtml(shortLabel(labelFor(item.node))) + (bits ? ' · ' + escapeHtml(bits) : '') + '</span>' +
          '<em>open</em>' +
        '</a>';
      }).join('') +
      (matches.length > 8 ? '<div class="kg-more">+' + (matches.length - 8) + ' more matches in this context</div>' : '') +
      '</div>';
  }

  function renderDetail(id) {
    const node = nodes.get(id);
    if (!node || !detailEl) return;
    const attrs = attributesFor(node);
    const related = relatedFor(id);
    const visibleRelated = related.slice(0, 14);
    const hiddenCount = Math.max(0, related.length - visibleRelated.length);
    const attrMarkup = attrs.length
      ? '<div class="kg-attrs">' + attrs.map((item) =>
        '<div><span>' + escapeHtml(item.key.replace(/_/g, ' ')) + '</span><b>' + escapeHtml(item.value) + '</b></div>'
      ).join('') + '</div>'
      : '';
    const linksMarkup = visibleRelated.length
      ? '<div class="kg-links">' + visibleRelated.map((item) =>
        '<a href="' + nodeUrl(item.id) + '" data-kg-jump="' + encodeURIComponent(item.id) + '">' +
          '<i>' + escapeHtml(typeFor(item.node).replace(/_/g, ' ')) + '</i>' +
          '<span>' + escapeHtml(shortLabel(labelFor(item.node))) + '</span>' +
          '<em>' + escapeHtml((item.outgoing ? '-> ' : '<- ') + item.relation) + '</em>' +
        '</a>'
      ).join('') + (hiddenCount ? '<div class="kg-more">+' + hiddenCount + ' more linked nodes</div>' : '') + '</div>'
      : '<div class="kg-more">No loaded links yet.</div>';
    const contextMarkup = contextMatchMarkup(node, related);

    detailEl.innerHTML =
      '<div class="kg-detail-head">' +
        '<div><b>' + escapeHtml(typeFor(node).replace(/_/g, ' ')) + '</b><strong>' + escapeHtml(labelFor(node)) + '</strong></div>' +
        '<a class="kg-url" href="' + nodeUrl(id) + '" data-kg-jump="' + encodeURIComponent(id) + '">' + escapeHtml('kg://' + id) + '</a>' +
      '</div>' +
      '<p>' + escapeHtml(describeNode(node, related)) + '</p>' +
      attrMarkup +
      contextMarkup +
      '<div class="kg-subhead">Linked nodes</div>' +
      linksMarkup;

    detailEl.querySelectorAll('[data-kg-jump]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        selectNode(decodeURIComponent(link.getAttribute('data-kg-jump')));
      });
    });
  }

  function selectNode(id) {
    if (!nodes.has(id)) return;
    selectedId = id;
    renderDetail(id);
    requestRender();
  }

  // Throttle SVG rebuilds to 2 fps. innerHTML is replaced wholesale
  // per render, so this is the single biggest knob for fixing the
  // KG-overlay lag. 500 ms still feels live (graph visibly grows) while
  // leaving the 3D scene the vast majority of its frame budget.
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      render();
    }, 500);
  }

  function clearReplay() {
    replayTimers.forEach((timer) => clearTimeout(timer));
    replayTimers = [];
  }

  function flashNode(id, action) {
    if (!id || action === 'loaded') return;
    nodeActivity.set(id, { action, expires: Date.now() + 3600 });
    setTimeout(() => {
      const active = nodeActivity.get(id);
      if (active && active.expires <= Date.now()) {
        nodeActivity.delete(id);
        requestRender();
      }
    }, 3700);
  }

  function activityFor(id) {
    const active = nodeActivity.get(id);
    if (!active) return '';
    if (active.expires <= Date.now()) {
      nodeActivity.delete(id);
      return '';
    }
    return active.action === 'updated' ? ' updated' : ' new';
  }

  function addNode(entity, silent) {
    if (!entity) return;
    const id = entity.entity_id || entity.id;
    if (!id) return;
    const existed = nodes.has(id);
    nodes.set(id, entity);
    const action = existed ? 'updated' : 'new';
    if (!silent) flashNode(id, action);
    if (!silent) requestRender();
    return {
      action,
      id,
      label: labelFor(entity),
      type: typeFor(entity),
    };
  }

  function addEdge(relationship, silent) {
    if (!relationship) return;
    const sourceId = relationship.source_id || relationship.source;
    const targetId = relationship.target_id || relationship.target;
    const relation = relationship.relation_type || relationship.relation || 'related_to';
    const existed = edges.some((edge) =>
      (edge.source_id || edge.source) === sourceId &&
      (edge.target_id || edge.target) === targetId &&
      (edge.relation_type || edge.relation || 'related_to') === relation
    );
    edges.push(relationship);
    if (!silent) requestRender();
    return {
      action: existed ? 'updated_link' : 'new_link',
      source: sourceId,
      target: targetId,
      relation,
    };
  }

  function compactGroup(group) {
    const centers = {
      matches: { x: 470, y: 220 },
      teams: { x: 280, y: 235 },
      players: { x: 420, y: 340 },
      clubs: { x: 670, y: 235 },
      evidence: { x: 470, y: 120 },
      sources: { x: 720, y: 120 },
      scouts: { x: 660, y: 345 },
      context: { x: 220, y: 120 },
      other: { x: 470, y: 120 },
    };
    const center = centers[group.id] || centers.other;
    return Object.assign({}, group, center);
  }

  function isFixtureOnly(values) {
    if (!values.length || values.length > 6) return false;
    const counts = {};
    values.forEach((node) => {
      const type = typeFor(node);
      counts[type] = (counts[type] || 0) + 1;
    });
    return (counts.match || 0) === 1 && (counts.team || 0) >= 2 && values.every((node) => ['match', 'team'].includes(typeFor(node)));
  }

  function positionedNodes() {
    const values = Array.from(nodes.values());
    if (isFixtureOnly(values)) {
      const match = values.find((node) => typeFor(node) === 'match');
      const teams = values.filter((node) => typeFor(node) === 'team');
      const placed = [];
      if (teams[0]) placed.push({ node: teams[0], group: groupFor(teams[0]), groupIndex: 0, compact: false, focused: true, fixture: true, x: 300, y: 230 });
      if (match) placed.push({ node: match, group: groupFor(match), groupIndex: 0, compact: false, focused: true, fixture: true, x: 470, y: 230 });
      if (teams[1]) placed.push({ node: teams[1], group: groupFor(teams[1]), groupIndex: 1, compact: false, focused: true, fixture: true, x: 640, y: 230 });
      teams.slice(2).forEach((node, index) => {
        placed.push({ node, group: groupFor(node), groupIndex: index + 2, compact: false, focused: true, fixture: true, x: 360 + index * 110, y: 330 });
      });
      return { nodes: placed, compact: false, focused: true, fixture: true };
    }
    const grouped = {};
    values.forEach((node) => {
      const group = groupFor(node);
      grouped[group.id] = grouped[group.id] || [];
      grouped[group.id].push(node);
    });
    const focused = values.length > 0 && values.length <= 140;
    const compact = values.length > 0 && values.length <= 32;
    const placed = [];
    Object.keys(grouped).forEach((groupId) => {
      const groupNodes = grouped[groupId];
      const baseGroup = groupFor(groupNodes[0]);
      const group = focused ? compactGroup(baseGroup) : baseGroup;
      const count = Math.max(groupNodes.length, 1);
      groupNodes.forEach((node, index) => {
        const angle = index * 2.399963229728653;
        const radius = count < 2 ? 0 : 12 + Math.sqrt(index / count) * (focused ? Math.min(92, 26 + count * 4.6) : Math.min(96, 18 + count * 2.1));
        placed.push({
          node,
          group,
          groupIndex: index,
          compact,
          focused,
          x: group.x + Math.cos(angle) * radius,
          y: group.y + Math.sin(angle) * radius,
        });
      });
    });
    return { nodes: placed, compact, focused, fixture: false };
  }

  function renderLegend() {
    if (!legendEl) return;
    const counts = {};
    Array.from(nodes.values()).forEach((node) => {
      const group = groupFor(node);
      counts[group.id] = (counts[group.id] || 0) + 1;
    });
    legendEl.innerHTML = groupDefs
      .filter((group) => counts[group.id])
      .map((group) =>
        '<span class="kg-chip"><i style="background:' + group.color + '"></i>' +
        escapeHtml(group.label) + ' <b>' + counts[group.id] + '</b></span>'
      )
      .join('');
  }

  function relationBands(byId) {
    const bands = new Map();
    edges.forEach((edge) => {
      const source = byId.get(edge.source_id || edge.source);
      const target = byId.get(edge.target_id || edge.target);
      if (!source || !target || source.group.id === target.group.id) return;
      const ids = [source.group.id, target.group.id].sort();
      const key = ids.join(':');
      const existing = bands.get(key) || { a: source.group, b: target.group, count: 0 };
      existing.count += 1;
      bands.set(key, existing);
    });
    return Array.from(bands.values()).sort((a, b) => b.count - a.count).slice(0, 14);
  }

  function groupBackgrounds(placed, compact) {
    if (placed.some((item) => item.fixture)) return '';
    const byGroup = {};
    placed.forEach((item) => {
      byGroup[item.group.id] = byGroup[item.group.id] || { group: item.group, count: 0 };
      byGroup[item.group.id].count += 1;
    });
    return Object.keys(byGroup).map((groupId) => {
      const group = byGroup[groupId].group;
      const count = byGroup[groupId].count;
      if (!count) return '';
      const radius = compact ? Math.min(190, 92 + Math.sqrt(count) * 22) : Math.min(150, 56 + Math.sqrt(count) * 10);
      return '<g class="kg-group">' +
        '<circle cx="' + group.x + '" cy="' + group.y + '" r="' + radius + '" style="--kg-color:' + group.color + '"></circle>' +
        '<text x="' + group.x + '" y="' + (group.y - radius - 11) + '">' + escapeHtml(group.label) + ' · ' + count + '</text>' +
      '</g>';
    }).join('');
  }

  function render() {
    if (!svg) return;
    renderLegend();
    const layout = positionedNodes();
    const placed = layout.nodes;
    const byId = new Map(placed.map((item) => [item.node.entity_id || item.node.id, item]));
    const selectedRelatedIds = selectedId ? new Set(relatedFor(selectedId).map((item) => item.id).concat(selectedId)) : null;
    const selectedLines = selectedId ? relatedFor(selectedId).slice(0, 28).map((item) => {
      const a = byId.get(selectedId);
      const b = byId.get(item.id);
      if (!a || !b) return '';
      return '<line class="kg-selected-edge" x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>';
    }).join('') : '';
    const bandMarkup = relationBands(byId).map((band) => {
      if (layout.fixture) return '';
      const mx = (band.a.x + band.b.x) / 2;
      const my = (band.a.y + band.b.y) / 2 - 48;
      const width = Math.min(14, 2 + Math.sqrt(band.count));
      return '<path class="kg-band" d="M ' + band.a.x + ' ' + band.a.y + ' Q ' + mx + ' ' + my + ' ' + band.b.x + ' ' + band.b.y + '" stroke-width="' + width + '"></path>';
    }).join('');
    const nodeMarkup = placed.map((item) => {
      const node = item.node;
      const id = node.entity_id || node.id;
      const type = typeFor(node);
      const color = colors[type] || item.group.color || colors.default;
      const radius = layout.fixture
        ? (type === 'match' ? 28 : 24)
        : layout.compact
        ? (type === 'match' ? 24 : type === 'team' ? 21 : type === 'player' ? 17 : type === 'club' ? 16 : 14)
        : layout.focused
          ? (type === 'match' ? 15 : type === 'team' ? 13 : type === 'player' ? 9 : type === 'club' ? 9 : 7)
          : (type === 'match' ? 8 : type === 'team' ? 7 : 5);
      const label = (layout.fixture || layout.compact || (layout.focused && (type === 'match' || type === 'team' || (['player', 'club'].includes(type) && item.groupIndex < 10))) || (item.groupIndex < 3 && (type === 'match' || type === 'team')))
        ? '<text y="' + (radius + (layout.fixture ? 26 : layout.compact ? 26 : layout.focused ? 17 : 13)) + '">' + escapeHtml(shortLabel(labelFor(node))) + '</text>'
        : '';
      const classes = 'kg-node' +
        (layout.fixture ? ' fixture' : '') +
        (layout.focused ? ' focused' : '') +
        (layout.compact ? ' compact' : '') +
        (id === selectedId ? ' selected' : '') +
        (selectedRelatedIds && !selectedRelatedIds.has(id) ? ' dim' : '') +
        activityFor(id);
      return '<g class="' + classes + '" data-node="' + encodeURIComponent(id) + '" tabindex="0" role="button" transform="translate(' + item.x + ' ' + item.y + ')">' +
        '<circle r="' + radius + '" fill="' + color + '"></circle>' +
        label +
      '</g>';
    }).join('');
    const fixtureNote = layout.fixture
      ? '<text class="kg-empty-note" x="470" y="330">No roster/player KG stored for this fixture yet. Run Scout to generate players and clubs.</text>'
      : '';
    svg.innerHTML = groupBackgrounds(placed, layout.focused) + bandMarkup + selectedLines + nodeMarkup + fixtureNote;
  }

  K.reset = function (title) {
    ensure();
    clearReplay();
    nodes = new Map();
    edges = [];
    selectedId = null;
    nodeActivity.clear();
    root.querySelector('#kg-title').textContent = title || 'KG stream';
    statusEl.textContent = 'Waiting for graph events...';
    legendEl.innerHTML = '';
    detailEl.innerHTML = '<span>Click a node for details.</span>';
    svg.innerHTML = '';
    root.classList.add('show');
  };

  K.status = function (text) {
    ensure();
    statusEl.textContent = text;
    root.classList.add('show');
  };

  K.ingest = function (event) {
    ensure();
    if (!event || !event.event_type) return;
    if (event.event_type === 'kg_stage') {
      const entities = event.entity_count != null ? ' · ' + event.entity_count + ' entities' : '';
      const links = event.relationship_count != null ? ' · ' + event.relationship_count + ' links' : '';
      K.status(String(event.stage || 'kg_stage').replace(/_/g, ' ') + entities + links);
    } else if (event.event_type === 'kg_entity') {
      const change = addNode(event.entity);
      K.status(nodes.size + ' entities streamed · ' + edges.length + ' links');
      return change;
    } else if (event.event_type === 'kg_relationship') {
      const change = addEdge(event.relationship);
      K.status(nodes.size + ' entities streamed · ' + edges.length + ' links');
      return change;
    } else if (event.event_type === 'kg_manifest') {
      const manifest = event.manifest || {};
      K.status('Manifest ready · ' + (manifest.entity_count || nodes.size) + ' entities · ' + (manifest.relationship_count || edges.length) + ' links');
    } else if (event.event_type === 'scouting_audit') {
      K.status('Scouting audit ready · backlog ' + (event.backlog_count == null ? 'n/a' : event.backlog_count));
    }
  };

  K.showGraph = function (graph, title) {
    K.reset(title || 'World Cup KG');
    (graph.entities || []).forEach((entity) => addNode(entity, true));
    (graph.relationships || []).forEach((relationship) => addEdge(relationship, true));
    render();
    K.status((graph.entity_count || nodes.size) + ' KG entities · ' + (graph.relationship_count || edges.length) + ' links');
  };

  K.replayGraph = function (graph, title, opts) {
    opts = opts || {};
    const allEntities = graph.entities || [];
    const allRels = graph.relationships || [];

    let entities = allEntities;
    let relationships = allRels;
    if (opts.maxNodes && allEntities.length > opts.maxNodes) {
      const byGroup = {};
      for (const e of allEntities) {
        const g = (e && (e.entity_type || e.type)) || 'misc';
        (byGroup[g] = byGroup[g] || []).push(e);
      }
      const groupKeys = Object.keys(byGroup);
      entities = [];
      let gIdx = 0, exhausted = 0;
      while (entities.length < opts.maxNodes && exhausted < groupKeys.length) {
        const list = byGroup[groupKeys[gIdx % groupKeys.length]];
        if (list && list.length) { entities.push(list.shift()); exhausted = 0; }
        else exhausted++;
        gIdx++;
      }
      const keepIds = new Set(entities.map((e) => e && (e.entity_id || e.id)).filter(Boolean));
      relationships = allRels.filter((r) => {
        const s = r && (r.source_id || r.source);
        const t = r && (r.target_id || r.target);
        return keepIds.has(s) && keepIds.has(t);
      });
    }

    const entityChunk = opts.entityChunk || 6;
    const relationshipChunk = opts.relationshipChunk || 18;
    const delayMs = opts.delayMs || 220;
    let entityIndex = 0;
    let relationshipIndex = 0;

    K.reset(title || 'World Cup KG');
    K.status('Streaming KG · 0 / ' + entities.length + ' entities');

    function schedule(fn, ms) {
      const timer = setTimeout(fn, ms);
      replayTimers.push(timer);
    }

    function replayEntities() {
      const end = Math.min(entityIndex + entityChunk, entities.length);
      for (; entityIndex < end; entityIndex++) addNode(entities[entityIndex], true);
      requestRender();
      K.status('Mining KG entities · ' + entityIndex + ' / ' + entities.length);
      if (entityIndex < entities.length) {
        schedule(replayEntities, delayMs);
      } else {
        schedule(replayRelationships, delayMs);
      }
    }

    function replayRelationships() {
      const end = Math.min(relationshipIndex + relationshipChunk, relationships.length);
      for (; relationshipIndex < end; relationshipIndex++) addEdge(relationships[relationshipIndex], true);
      requestRender();
      K.status('Linking KG · ' + nodes.size + ' entities · ' + relationshipIndex + ' / ' + relationships.length + ' links');
      if (relationshipIndex < relationships.length) {
        schedule(replayRelationships, delayMs);
      } else {
        render();
        K.status(nodes.size + ' KG entities · ' + edges.length + ' links');
        if (typeof opts.onComplete === 'function') opts.onComplete();
      }
    }

    if (entities.length) replayEntities();
    else replayRelationships();
  };

  K.showScoutingProgress = function (opts) {
    opts = opts || {};
    const match = opts.match || 'Selected fixture';
    const matchId = opts.matchId || 'scout:' + slug(match);
    const home = opts.team || (match.includes(' vs ') ? match.split(' vs ')[0] : '');
    const away = opts.opponent || (match.includes(' vs ') ? match.split(' vs ')[1] : '');
    K.reset('Live scouting KG');
    addNode({
      entity_id: matchId,
      entity_type: 'match',
      name: match,
      attributes: { status: 'scouting', team1: home, team2: away },
    }, true);
    if (home) {
      addNode({ entity_id: 'team:' + slug(home), entity_type: 'team', name: home, attributes: { role: 'selected' } }, true);
      addEdge({ source_id: 'team:' + slug(home), target_id: matchId, relation_type: 'plays_in' }, true);
    }
    if (away) {
      addNode({ entity_id: 'team:' + slug(away), entity_type: 'team', name: away, attributes: { role: 'opponent' } }, true);
      addEdge({ source_id: 'team:' + slug(away), target_id: matchId, relation_type: 'plays_in' }, true);
    }
    addNode({ entity_id: 'scout:coordinator:' + slug(match), entity_type: 'scout', name: 'Scout coordinator', attributes: { match } }, true);
    addEdge({ source_id: 'scout:coordinator:' + slug(match), target_id: matchId, relation_type: 'scouting' }, true);
    render();
    K.status('Scouting process started · waiting for KG stream');
  };

  return K;
})();
