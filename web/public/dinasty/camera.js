// WorldColony — dual camera: cinematic orbit/tour + WASD free-explore (pointer-lock look)
window.DN = window.DN || {};

DN.camera = (function () {
  const C = { mode: 'cinematic', followFn: null };
  let cam, controls, dom;
  const keys = {};
  let yaw = 0, pitch = -0.15;
  const vel = new THREE.Vector3();
  const EYE = 4.2;
  const tween = { active: false, t: 0, dur: 1.6, fromP: new THREE.Vector3(), toP: new THREE.Vector3(), fromT: new THREE.Vector3(), toT: new THREE.Vector3() };
  function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function ground(x, z) { return DN.world.heightAt(x, z); }

  C.init = function () {
    cam = DN.world.camera;
    dom = DN.world.renderer.domElement;
    controls = new THREE.OrbitControls(cam, dom);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.6;
    controls.minDistance = 6;
    controls.maxDistance = 760;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 2, 0);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    C.controls = controls;

    addEventListener('keydown', e => {
      keys[e.code] = true;
      if (e.code === 'Space' && C.mode === 'explore') e.preventDefault();
    });
    addEventListener('keyup', e => { keys[e.code] = false; });

    // pointer-lock mouse look in explore mode
    dom.addEventListener('click', () => {
      if (C.mode === 'explore' && document.pointerLockElement !== dom) dom.requestPointerLock();
    });
    // double-click on the world (cinematic) -> recenter to overview.
    dom.addEventListener('dblclick', (e) => {
      if (C.mode === 'cinematic' && (!DN.app || DN.app.view === 'surface')) {
        e.preventDefault();
        C.recenter();
      }
    });
    // right-click anywhere on the world -> recenter (cinematic). Killing
    // the default context menu makes this feel native.
    dom.addEventListener('contextmenu', (e) => {
      if (C.mode === 'cinematic' && (!DN.app || DN.app.view === 'surface')) {
        e.preventDefault();
        C.recenter();
      }
    });
    document.addEventListener('mousemove', e => {
      if (C.mode === 'explore' && document.pointerLockElement === dom) {
        yaw -= e.movementX * 0.0024;
        pitch -= e.movementY * 0.0024;
        pitch = Math.max(-1.3, Math.min(1.2, pitch));
      }
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === dom;
      document.body.classList.toggle('pl', locked);
      if (DN.hud) DN.hud.setExploreLocked(locked);
    });
    return C;
  };

  C.setMode = function (mode) {
    if (mode === C.mode) return;
    C.mode = mode;
    C.followFn = null;
    if (mode === 'explore') {
      controls.enabled = false;
      controls.autoRotate = false;
      // derive yaw/pitch from current view
      const dir = new THREE.Vector3().subVectors(controls.target, cam.position);
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = -0.18;
      // Trail-cam anchor sits at the queen if she exists; otherwise at
      // the camera's XZ projected to ground. The camera itself is
      // repositioned every frame by C.update().
      let ax = cam.position.x, az = cam.position.z;
      if (DN.queen && DN.queen.has && DN.queen.has() && DN.queen.position) {
        const qp = DN.queen.position();
        if (qp) { ax = qp.x; az = qp.z; }
      }
      C._anchor = new THREE.Vector3(ax, ground(ax, az), az);
      tween.active = false;
    } else {
      controls.enabled = true;
      if (document.pointerLockElement === dom) document.exitPointerLock();
      C._anchor = null;
      // set orbit target a little ahead of camera
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      controls.target.copy(cam.position).addScaledVector(fwd, 24).setY(4);
    }
    document.body.classList.toggle('explore-mode', mode === 'explore');
    if (DN.hud) DN.hud.setCameraMode(mode);
  };

  C.flyTo = function (target, dist, height, dur) {
    if (C.mode !== 'cinematic') C.setMode('cinematic');
    controls.autoRotate = false;
    const dir = new THREE.Vector3().subVectors(cam.position, controls.target).setY(0);
    if (dir.lengthSq() < 0.01) dir.set(0.6, 0, 1);
    dir.normalize();
    tween.fromP.copy(cam.position); tween.fromT.copy(controls.target);
    tween.toT.copy(target);
    tween.toP.copy(target).addScaledVector(dir, dist).setY(target.y + height);
    tween.t = 0; tween.dur = dur || 1.6; tween.active = true;
  };

  // fn returns the THREE.Vector3 target; offset (optional) sets the camera
  // position relative to the target. Default is a close inspection view
  // (+6 up, +14 back). Wider lifecycle shots should pass something like
  // (0, 50, 80) to pull the camera out.
  C.follow = function (fn, offset) { C.setMode('cinematic'); C.followFn = fn; C.followOffset = offset || null; controls.autoRotate = false; };
  C.stopFollow = function () { C.followFn = null; C.followOffset = null; };
  C.autoRotate = function (on) { if (C.mode === 'cinematic') controls.autoRotate = on; };

  C.update = function (dt) {
    if (C.mode === 'explore') {
      // Ant-view third-person: WASD moves the queen's ground anchor;
      // the camera trails behind and above her looking forward, so the
      // queen sits in the lower-centre of the frame and the world opens
      // up in front of you. Pure trail-cam — no flying, no first-person.
      if (!C._anchor) C._anchor = new THREE.Vector3().copy(cam.position);
      const anchor = C._anchor;
      const camFwd   = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const camRight = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
      const accel    = new THREE.Vector3();
      const sprint   = keys['ControlLeft'] || keys['ControlRight'] || keys['ShiftLeft'] || keys['ShiftRight'];
      const sp       = sprint ? 22 : 11;
      if (keys['KeyW'] || keys['ArrowUp'])    accel.add(camFwd);
      if (keys['KeyS'] || keys['ArrowDown'])  accel.sub(camFwd);
      if (keys['KeyD'] || keys['ArrowRight']) accel.add(camRight);
      if (keys['KeyA'] || keys['ArrowLeft'])  accel.sub(camRight);
      if (accel.lengthSq() > 0) accel.normalize().multiplyScalar(sp);
      vel.lerp(accel, Math.min(1, dt * 10));
      anchor.addScaledVector(vel, dt);
      const lim = DN.world.SIZE * 0.5 - 6;
      anchor.x = Math.max(-lim, Math.min(lim, anchor.x));
      anchor.z = Math.max(-lim, Math.min(lim, anchor.z));
      anchor.y = ground(anchor.x, anchor.z);

      // Queen walks at the anchor, facing the camera-forward direction.
      if (DN.queen && DN.queen.has && DN.queen.has()) {
        DN.queen.moveTo(anchor.x, anchor.z, yaw + Math.PI);
      }

      // Trail-cam: eye sits BACK_DIST behind and CAM_LIFT above the queen.
      const BACK_DIST = 5.5;
      const CAM_LIFT  = 3.2;
      const eyeX = anchor.x + Math.sin(yaw) * BACK_DIST;
      const eyeZ = anchor.z + Math.cos(yaw) * BACK_DIST;
      const eyeY = ground(eyeX, eyeZ) + CAM_LIFT;
      cam.position.set(eyeX, eyeY, eyeZ);
      // Aim slightly past the queen so she frames at the lower-centre.
      // Pitch nudges the look point up/down with mouse-look.
      const lookX = anchor.x - Math.sin(yaw) * 2.4;
      const lookZ = anchor.z - Math.cos(yaw) * 2.4;
      const lookY = anchor.y + 0.7 + pitch * 4.0;
      cam.lookAt(lookX, lookY, lookZ);
      return;
    }
    // cinematic
    if (tween.active) {
      tween.t += dt / tween.dur;
      const k = ease(Math.min(1, tween.t));
      cam.position.lerpVectors(tween.fromP, tween.toP, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
      if (tween.t >= 1) tween.active = false;
    } else if (C.followFn) {
      const p = C.followFn();
      if (p) {
        controls.target.lerp(p, Math.min(1, dt * 3));
        const off = C.followOffset || new THREE.Vector3(0, 6, 14);
        const desired = p.clone().add(off);
        cam.position.lerp(desired, Math.min(1, dt * 1.6));
      }
    } else {
      // Game-feel orbit + plane pan. Q/E rotate the tactical camera
      // around its target, while arrows pan the whole view across the map.
      if (keys['KeyQ'] || keys['KeyE']) {
        controls.autoRotate = false;
        const dir = keys['KeyQ'] ? 1 : -1;
        if (controls.rotateLeft) controls.rotateLeft(dir * dt * 1.35);
      }
      const pressed = keys['ArrowUp'] || keys['ArrowDown'] || keys['ArrowLeft'] || keys['ArrowRight'];
      if (pressed) {
        controls.autoRotate = false;
        const forward = new THREE.Vector3().subVectors(controls.target, cam.position);
        forward.y = 0;
        if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1); else forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const sp = (keys['ShiftLeft'] || keys['ShiftRight']) ? 90 : 42;
        const move = new THREE.Vector3();
        if (keys['ArrowUp'])    move.add(forward);
        if (keys['ArrowDown'])  move.sub(forward);
        if (keys['ArrowRight']) move.add(right);
        if (keys['ArrowLeft'])  move.sub(right);
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(sp * dt);
          // clamp inside world to stay on the playable plane
          const lim = (DN.world && DN.world.SIZE ? DN.world.SIZE * 0.5 : 320) - 12;
          const nx = Math.max(-lim, Math.min(lim, controls.target.x + move.x));
          const nz = Math.max(-lim, Math.min(lim, controls.target.z + move.z));
          const realMove = new THREE.Vector3(nx - controls.target.x, 0, nz - controls.target.z);
          controls.target.add(realMove);
          cam.position.add(realMove);
        }
      }
    }
    controls.update();
  };

  // Recenter the camera to the world overview. Cancels any follow / tween.
  C.recenter = function () {
    C.followFn = null;
    tween.active = false;
    controls.autoRotate = true;
    C.flyTo(new THREE.Vector3(0, 4, 0), 300, 165, 1.6);
  };

  return C;
})();
