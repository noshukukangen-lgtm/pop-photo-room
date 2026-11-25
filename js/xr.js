// xr.js — VRの中の調整パネル、コントローラー操作、毎フレームの処理
import * as THREE from 'three';

const A = window.APP;
const { PARAMS, settings, photos, scene, camera, renderer } = A;

// =====================================================================
// VRの中の調整パネル
// =====================================================================
const PW = 1024, HEAD = 110, ROWH = 80;
const panelRows = [
  ...PARAMS.map(p => ({ type: p.options ? 'cycle' : 'num', p })),
  { type:'cutall' },
  { type:'arrange' },
  { type:'clear' },
  { type:'footer' },
];
let clearArmed = 0;   // 「全部消す」の確認待ち（押した時刻）
const PH = HEAD + panelRows.length * ROWH + 24;
const pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace;
const PANEL_W = 0.62;
const panel = new THREE.Mesh(
  new THREE.PlaneGeometry(PANEL_W, PANEL_W * PH / PW),
  new THREE.MeshBasicMaterial({ map: ptex, transparent: true, depthTest: false })
);
panel.renderOrder = 999;
panel.visible = false;
scene.add(panel);

function rowButtons(r, i){
  const y = HEAD + i*ROWH, y0 = y + 10, y1 = y + ROWH - 10;
  if (r.type === 'num') return [
    { x0:660, x1:810, y0, y1, text:'−', act:() => A.setParam(r.p.key, settings[r.p.key] - r.p.step) },
    { x0:850, x1:1000, y0, y1, text:'+', act:() => A.setParam(r.p.key, settings[r.p.key] + r.p.step) },
  ];
  if (r.type === 'cycle') return [
    { x0:660, x1:1000, y0, y1, text: r.p.names[settings[r.p.key]], act:() => {
      const o = r.p.options; A.setParam(r.p.key, o[(o.indexOf(settings[r.p.key]) + 1) % o.length]);
    }},
  ];
  if (r.type === 'cutall') return [
    { x0:660, x1:1000, y0, y1, text: A.allCut ? 'ON' : 'OFF', act:() => {
      A.allCut = !A.allCut; photos.forEach(m => A.setCut(m, A.allCut)); A.drawPanel();
    }},
  ];
  if (r.type === 'arrange') return [
    { x0:660, x1:1000, y0, y1, text:'取り囲む', act:() => { A.arrangeAround(); A.drawPanel(); } },
  ];
  if (r.type === 'clear'){
    const armed = performance.now() - clearArmed < 3000;
    return [
      { x0:660, x1:1000, y0, y1, text: armed ? 'もう一度で消去' : '全部消す', danger:true, act:() => {
        if (performance.now() - clearArmed < 3000){ clearArmed = 0; removeAllPhotos(); }
        else { clearArmed = performance.now(); setTimeout(A.drawPanel, 3100); }
        A.drawPanel();
      }},
    ];
  }
  return [
    { x0:30,  x1:500,  y0, y1, text:'初期値に戻す', act:() => A.resetParams() },
    { x0:530, x1:1000, y0, y1, text:'閉じる', act:() => { panel.visible = false; } },
  ];
}

function rr(g, x, y, w, h, r){
  g.beginPath();
  g.moveTo(x+r, y); g.arcTo(x+w, y, x+w, y+h, r); g.arcTo(x+w, y+h, x, y+h, r);
  g.arcTo(x, y+h, x, y, r); g.arcTo(x, y, x+w, y, r); g.closePath();
}

A.drawPanel = () => {
  const g = pc.getContext('2d');
  g.clearRect(0, 0, PW, PH);
  g.fillStyle = 'rgba(18,22,30,0.92)'; rr(g, 0, 0, PW, PH, 40); g.fill();
  g.textBaseline = 'middle';
  g.fillStyle = '#fff'; g.font = 'bold 50px sans-serif'; g.textAlign = 'left';
  g.fillText('見え方の調整', 36, HEAD/2 + 4);
  g.fillStyle = '#8ab'; g.font = '28px sans-serif'; g.textAlign = 'right';
  g.fillText(`認識した面：${A.planes.length}`, PW - 32, HEAD/2 + 4);

  panelRows.forEach((r, i) => {
    const cy = HEAD + i*ROWH + ROWH/2;
    g.textAlign = 'left'; g.fillStyle = '#eee'; g.font = '36px sans-serif';
    if (r.type === 'num' || r.type === 'cycle') g.fillText(r.p.label, 36, cy);
    if (r.type === 'cutall') g.fillText('切り抜き（全部）', 36, cy);
    if (r.type === 'arrange') g.fillText('並べ直す（人の大きさ）', 36, cy);
    if (r.type === 'clear') g.fillText(`写真（${photos.length} 枚）`, 36, cy);
    if (r.type === 'num'){
      g.textAlign = 'right'; g.fillStyle = '#7cf'; g.font = 'bold 38px sans-serif';
      g.fillText(r.p.fmt(settings[r.p.key]), 640, cy);
    }
    for (const b of rowButtons(r, i)){
      g.fillStyle = b.danger ? '#7a2630' : '#2d3a4f'; rr(g, b.x0, b.y0, b.x1-b.x0, b.y1-b.y0, 18); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.font = (b.text === '+' || b.text === '−') ? 'bold 52px sans-serif' : 'bold 34px sans-serif';
      g.fillText(b.text, (b.x0+b.x1)/2, (b.y0+b.y1)/2 + 2);
    }
  });
  ptex.needsUpdate = true;
};

const tmpP = new THREE.Vector3(), tmpDir = new THREE.Vector3();
function togglePanel(){
  if (panel.visible){ panel.visible = false; return; }
  camera.getWorldPosition(tmpP);
  camera.getWorldDirection(tmpDir);
  tmpDir.y = 0;
  if (tmpDir.lengthSq() < 1e-4) tmpDir.set(0, 0, -1);
  tmpDir.normalize();
  panel.position.copy(tmpP).addScaledVector(tmpDir, 0.8);
  panel.position.y = tmpP.y - 0.15;
  panel.lookAt(tmpP.x, panel.position.y, tmpP.z);
  A.drawPanel();
  panel.visible = true;
}

function clickPanel(hit){
  const px = hit.uv.x * PW, py = (1 - hit.uv.y) * PH;
  panelRows.forEach((r, i) => {
    for (const b of rowButtons(r, i)){
      if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) b.act();
    }
  });
}

// =====================================================================
// コントローラー操作
// =====================================================================
const raycaster = new THREE.Raycaster();
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
const CYAN = 0x00ffff, YELLOW = 0xffcc00, GREEN = 0x33ff66;

function handDistance(){
  controllers[0].getWorldPosition(tmpA);
  controllers[1].getWorldPosition(tmpB);
  return tmpA.distanceTo(tmpB);
}
function setRay(c){
  const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0,0,-1).applyMatrix4(m);
}
function buzz(c){
  try { const h = c.userData.gamepad && c.userData.gamepad.hapticActuators; h && h[0] && h[0].pulse(0.6, 60); } catch (e) {}
}

const controllers = [0,1].map(i => {
  const c = renderer.xr.getController(i);
  const lineMat = new THREE.LineBasicMaterial({ color: CYAN });
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-1)]), lineMat);
  line.scale.z = 3;
  c.add(line);
  c.userData.lineMat = lineMat;
  c.userData.prevBtn = {};
  c.addEventListener('connected', e => c.userData.gamepad = e.data.gamepad);

  c.addEventListener('selectstart', () => {
    setRay(c);
    if (panel.visible){
      const ph = raycaster.intersectObject(panel, false)[0];
      if (ph){ clickPanel(ph); return; }
    }
    const hit = raycaster.intersectObjects(photos, false)[0];
    if (!hit) return;
    A.autoArranged = false;
    const other = controllers[1 - i];
    if (other.userData.held === hit.object){
      A.twoHand = { obj: hit.object, d0: handDistance(), s0: hit.object.scale.x };
      c.userData.scaler = true;
      c.userData.lineMat.color.set(YELLOW);
      other.userData.lineMat.color.set(YELLOW);
    } else {
      c.attach(hit.object);
      c.userData.held = hit.object;
    }
  });

  c.addEventListener('selectend', () => {
    const other = controllers[1 - i];
    if (c.userData.scaler){
      c.userData.scaler = false;
      A.twoHand = null;
    }
    const obj = c.userData.held;
    if (obj){
      scene.attach(obj);
      c.userData.held = null;
      A.twoHand = null;
      other.userData.scaler = false;
      // 壁・床・天井の近くで離したら、ピタッと吸い付く
      const s = A.findSnap(obj);
      if (s){ A.applySnap(obj, s); buzz(c); }
    }
    c.userData.lineMat.color.set(CYAN);
    other.userData.lineMat.color.set(CYAN);
  });

  scene.add(c);
  return c;
});

// ===== 写真の削除 =====
function disposePhoto(m){
  m.parent && m.parent.remove(m);
  const texs = new Set();
  for (const mat of [m.material, m.userData.back.material]){
    for (const k of ['map','maskMap','depthMap']) texs.add(mat.uniforms[k].value);
    mat.dispose();
  }
  texs.forEach(t => t && t.dispose());
  m.geometry.dispose();
  const i = photos.indexOf(m);
  if (i >= 0) photos.splice(i, 1);
}
A.releaseAll = () => {
  A.twoHand = null;
  for (const c of controllers){
    if (c.userData.held) scene.attach(c.userData.held);
    c.userData.held = null;
    c.userData.scaler = false;
    c.userData.lineMat.color.set(CYAN);
  }
};
function deleteHeld(c){
  const m = c.userData.held;
  if (!m) return;
  for (const o of controllers) if (o.userData.held === m) o.userData.held = null;
  if (A.twoHand && A.twoHand.obj === m) A.releaseAll();
  c.userData.lineMat.color.set(CYAN);
  disposePhoto(m);
  A.drawPanel();
}
function removeAllPhotos(){
  A.releaseAll();
  [...photos].forEach(disposePhoto);
  A.status.textContent = '写真を全部消しました。';
  A.drawPanel();
}

// 手・コントローラーの位置（グリップ）
const grips = [0,1].map(i => { const g = renderer.xr.getControllerGrip(i); scene.add(g); return g; });
const handQ = new THREE.Quaternion();
function updateHands(){
  grips.forEach((g, i) => {
    const u = A.handU['uHand' + i].value;
    if (renderer.xr.isPresenting && g.visible) g.getWorldPosition(u);
    else u.copy(A.FAR);
    controllers[i].getWorldQuaternion(handQ);
    A.handU['uHandDir' + i].value.set(0, 0, -1).applyQuaternion(handQ).normalize();
  });
}

function pressed(c, idx){
  const gp = c.userData.gamepad;
  const now = !!(gp && gp.buttons[idx] && gp.buttons[idx].pressed);
  const was = !!c.userData.prevBtn[idx];
  c.userData.prevBtn[idx] = now;
  return now && !was;
}

// 斜めから見たときに薄くする
const camPos = new THREE.Vector3(), wq = new THREE.Quaternion(), wn = new THREE.Vector3(),
      wp = new THREE.Vector3(), toCam = new THREE.Vector3();
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t*t*(3 - 2*t); };
const fadeAt = ang => settings.fade >= 90 ? 1 : 1 - smooth01(settings.fade, settings.fade + 20, ang);

function updateFade(){
  camera.getWorldPosition(camPos);
  for (const m of photos){
    m.getWorldPosition(wp);
    m.getWorldQuaternion(wq);
    wn.set(0, 0, 1).applyQuaternion(wq);
    toCam.subVectors(camPos, wp).normalize();
    const ang = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, wn.dot(toCam)))));
    const front = settings.back === 'show' ? fadeAt(Math.min(ang, 180 - ang)) : fadeAt(ang);
    m.material.uniforms.uOpacity.value = front;
    m.userData.back.material.uniforms.uOpacity.value = fadeAt(180 - ang);
  }
}

// =====================================================================
// 毎フレームの処理
// =====================================================================
let planeTick = 0;
renderer.setAnimationLoop((time, frame) => {
  if (frame && planeTick++ % 30 === 0) A.updatePlanes(frame);
  if (A.arrangeWait >= 0 && renderer.xr.isPresenting && A.arrangeWait-- === 0) A.arrangeAround();

  for (const c of controllers){
    if (pressed(c, 3)){
      if (c.userData.held) deleteHeld(c);   // つかんでいれば その写真を削除
      else togglePanel();                   // つかんでいなければ 調整パネル
    }
    if (pressed(c, 4) && c.userData.held){
      const m = c.userData.held;
      A.setCut(m, !m.userData.cut);
    }
    if (pressed(c, 5)){
      A.allCut = !A.allCut;
      photos.forEach(m => A.setCut(m, A.allCut));
      A.drawPanel();
    }
  }

  if (A.geoDirty){
    A.geoDirty = false;
    photos.forEach(A.applyGeometry);
  }

  if (A.twoHand){
    const s = A.twoHand.s0 * handDistance() / A.twoHand.d0;
    A.twoHand.obj.scale.setScalar(Math.min(20, Math.max(0.05, s)));
  } else {
    for (const c of controllers){
      const obj = c.userData.held, gp = c.userData.gamepad;
      if (!obj) continue;
      if (gp && gp.axes.length >= 4) obj.scale.multiplyScalar(1 - gp.axes[3] * 0.02);
      // 離すと吸い付く場所にいるときは、光線が緑になる
      c.userData.lineMat.color.set(A.findSnap(obj) ? GREEN : CYAN);
    }
  }
  updateFade();
  updateHands();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

A.syncHtml();
A.drawPanel();
