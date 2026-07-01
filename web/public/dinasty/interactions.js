// WorldColony — interactions: raycast hover/select, drop forage, room picking, tooltip
window.DN = window.DN || {};

DN.interactions = (function () {
  const I = { tool: 'inspect', hovered: null };
  let dom, ray, pointer, tooltipEl;

  I.init = function () {
    dom = DN.world.renderer.domElement;
    ray = new THREE.Raycaster();
    ray.params.Points = { threshold: 2 };
    pointer = new THREE.Vector2(-2, -2);
    tooltipEl = document.getElementById('tooltip');
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerleave', () => setHover(null));
    return I;
  };

  function cam() { return DN.app.view === 'underground' ? DN.underground.camera : DN.world.camera; }
  function ndc(e) { pointer.x = (e.clientX / innerWidth) * 2 - 1; pointer.y = -(e.clientY / innerHeight) * 2 + 1; }

  function hoverList() {
    if (DN.app.view === 'underground') return DN.underground.pickables();
    const arr = [];
    DN.colony.list.forEach(c => arr.push(c.pickTarget));
    DN.resources.pickables().forEach(p => arr.push(p));
    DN.ants.heroes.forEach(a => arr.push(a.pickTarget));
    return arr;
  }

  function onMove(e) {
    if (DN.camera.mode === 'explore') return;
    ndc(e); I._mx = e.clientX; I._my = e.clientY;
    if (I.tool === 'food' && DN.app.view === 'surface') { dom.style.cursor = 'crosshair'; setHover(null); return; }
    ray.setFromCamera(pointer, cam());
    const hits = ray.intersectObjects(hoverList(), false);
    if (hits.length) {
      const ud = hits[0].object.userData;
      const obj = ud.colony || ud.resource || ud.ant || (ud.room ? { room: ud.room } : null) || roomFromMesh(hits[0].object);
      setHover(obj); dom.style.cursor = 'pointer';
      // tunnel-glow feedback when hovering an underground chamber
      if (DN.app.view === 'underground' && obj && obj.room && DN.underground.setHoverRoom) {
        DN.underground.setHoverRoom(obj.room.id);
      } else if (DN.app.view === 'underground' && DN.underground.setHoverRoom) {
        DN.underground.setHoverRoom(null);
      }
    } else {
      setHover(null); dom.style.cursor = DN.app.view === 'underground' ? 'default' : 'grab';
      if (DN.app.view === 'underground' && DN.underground.setHoverRoom) DN.underground.setHoverRoom(null);
    }
  }

  function roomFromMesh(mesh) {
    // underground chamber inner disc: find parent group's _roomDef
    let p = mesh.parent;
    while (p && !p._roomDef) p = p.parent;
    return p && p._roomDef ? { room: p._roomDef } : null;
  }

  function setHover(obj) {
    if (I.hovered === obj) return;
    I.hovered = obj;
    if (!obj) { tooltipEl.classList.remove('show'); DN.hud.hideEnterBanner(); return; }
    renderTooltip(obj);
    tooltipEl.classList.add('show');
    if (obj.stats) DN.hud.showEnterBanner(obj); else DN.hud.hideEnterBanner();
  }

  function renderTooltip(obj) {
    let kicker, name, rows = [], accent = '#E8C24A';
    if (obj.stats) {
      kicker = 'Colony'; name = obj.name; accent = '#' + obj.accent.toString(16).padStart(6, '0');
      rows = [['Population', Math.round(obj.stats.population)], ['Forecast acc', obj.stats.accuracy + '%'], ['Directive', obj.directive.replace(/^./, c => c.toUpperCase())]];
    } else if (obj.role) {
      kicker = obj.role + (obj.hero ? '' : ' · worker'); name = obj.name || obj.col.name + ' agent'; accent = '#' + obj.col.accent.toString(16).padStart(6, '0');
      rows = [['Task', obj.state === 'out' ? 'Outbound' : 'Returning'], ['Carrying', obj.cargo ? 'Crystal' : '—']];
    } else if (obj.room) {
      kicker = 'Chamber'; name = obj.room.name; rows = [['Status', 'Active']];
    } else {
      kicker = 'Forage cache'; name = obj.kind === 'crystal' ? 'Data crystal' : 'Forage pile'; accent = '#E8C24A';
      rows = [['Yield', Math.round(obj.amount)], ['Reserve', Math.round((obj.amount / obj.max) * 100) + '%']];
    }
    tooltipEl.innerHTML = `<div class="tt-kicker" style="color:${accent}">${kicker}</div><div class="tt-name">${name}</div>` +
      '<div class="tt-rows">' + rows.map(r => `<div class="tt-row"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('') + '</div>';
  }

  function onDown(e) {
    if (e.button !== 0 || DN.camera.mode === 'explore') return;
    ndc(e);
    if (DN.app.view === 'underground') {
      ray.setFromCamera(pointer, cam());
      const hits = ray.intersectObjects(hoverList(), false);
      if (hits.length) {
        const r = roomFromMesh(hits[0].object) || (hits[0].object.userData.room && { room: hits[0].object.userData.room });
        if (r) {
          DN.hud.showRoom(r.room, DN.underground.col);
          if (DN.underground.focusRoom) DN.underground.focusRoom(r.room.id);
        }
      }
      return;
    }
    if (I.tool === 'food') {
      ray.setFromCamera(pointer, cam());
      const hit = ray.intersectObject(DN.world.terrain, false)[0];
      if (hit) DN.app.dropFood(hit.point);
      return;
    }
    if (I.tool === 'found') {
      ray.setFromCamera(pointer, cam());
      const hit = ray.intersectObject(DN.world.terrain, false)[0];
      if (hit) DN.app.createUserColony(hit.point);
      return;
    }
    ray.setFromCamera(pointer, cam());
    const hits = ray.intersectObjects(hoverList(), false);
    if (hits.length) {
      const ud = hits[0].object.userData;
      if (ud.colony) return DN.app.selectColony(ud.colony);
      if (ud.ant) return DN.app.selectAnt(ud.ant);
      if (ud.resource) return DN.camera.flyTo(ud.resource.pos, 26, 14);
    }
    // fall through: try to pick a generic worker from the instanced ant meshes
    const antHits = ray.intersectObjects(DN.ants.meshes, false);
    if (antHits.length && antHits[0].instanceId != null) {
      const a = DN.ants.antFromHit(antHits[0].object, antHits[0].instanceId);
      if (a) return DN.app.selectAnt(a);
    }
  }

  I.setTool = function (t) {
    I.tool = t;
    document.querySelectorAll('#tools .tool[data-tool]').forEach(el => el.classList.toggle('active', el.dataset.tool === t));
    dom.style.cursor = t === 'food' ? 'crosshair' : 'grab';
  };

  I.update = function () {
    if (!I.hovered || !tooltipEl.classList.contains('show')) return;
    const o = I.hovered; let wp;
    if (o.corePos) wp = o.corePos;
    else if (o.role) wp = DN.ants.heroPos ? DN.ants.heroPos(o) : new THREE.Vector3(o.x, 2, o.z);
    else if (o.room) { const g = DN.underground.rooms[o.room.id]; wp = new THREE.Vector3(g.position.x, g.position.y + o.room.r, g.position.z); }
    else if (o.pos) wp = o.pos.clone().setY(o.pos.y + 2);
    else return;
    const v = wp.clone().project(cam());
    tooltipEl.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
    tooltipEl.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    if (v.z > 1) tooltipEl.classList.remove('show');
  };

  return I;
})();
