// library.js — VRの中の「動画ライブラリ」パネル
//   これまでに読み込んだ動画が並ぶ。押すと自分の正面に出る／もう一度押すとしまう（ライブラリには残る）
//   右上の × を2回押すと、ライブラリからも消す。「ファイルから追加」で、VRの中から新しい動画を選べる
import * as THREE from 'three';

const A = window.APP;
const { scene, renderer } = A;

const PW = 1024, HEAD = 110, TW = 316, TH = 300, GAP = 12, COLS = 3, ROWS = 2, PER = COLS * ROWS;
const FOOT_Y = HEAD + ROWS * (TH + GAP) + 6, FOOT_H = 84, PH = FOOT_Y + FOOT_H + 70;
const KIND = { dv: '立体', loop: 'ループ', vr180: 'VR180' };

const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH;
const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
const W = 0.62;
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, W * PH / PW),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
mesh.renderOrder = 999;
mesh.visible = false;
scene.add(mesh);

let items = [], placed = new Set(), page = 0, busy = null, msg = '', armDel = { id: null, t: 0 };
const bitmaps = new Map();
const panelObj = { mesh, hoverIds: [null, null] };

function rr(g, x, y, w, h, r){
  g.beginPath();
  g.moveTo(x+r, y); g.arcTo(x+w, y, x+w, y+h, r); g.arcTo(x+w, y+h, x, y+h, r);
  g.arcTo(x, y+h, x, y, r); g.arcTo(x, y, x+w, y, r); g.closePath();
}
const shortName = n => {
  n = (n || '').replace(/\.[^.]+$/, '').replace(/_(loop_3d|loop|full|3d|vr180_packed|vr180)$/i, '');
  return n.length > 13 ? n.slice(0, 12) + '…' : (n || '（名前なし）');
};

function buttons(){
  const list = [];
  const pages = Math.max(1, Math.ceil(items.length / PER));
  page = Math.min(page, pages - 1);
  items.slice(page * PER, page * PER + PER).forEach((it, k) => {
    const x0 = 24 + (k % COLS) * (TW + GAP), y0 = HEAD + Math.floor(k / COLS) * (TH + GAP);
    // × は先に（タイルより優先）
    list.push({ id: 'del-' + it.id, x0: x0 + TW - 70, x1: x0 + TW - 6, y0: y0 + 6, y1: y0 + 62, del: true, it,
      act: () => {
        if (armDel.id === it.id && performance.now() - armDel.t < 3000){
          armDel = { id: null, t: 0 };
          A.videoLib.remove(it.id).then(refresh).catch(e => { msg = '消せませんでした：' + (e.message || e); draw(); });
        } else { armDel = { id: it.id, t: performance.now() }; setTimeout(draw, 3100); }
        draw();
      } });
    list.push({ id: 'tile-' + it.id, x0, x1: x0 + TW, y0, y1: y0 + TH, tile: true, it, act: () => toggle(it) });
  });
  const fy0 = FOOT_Y + 8, fy1 = FOOT_Y + FOOT_H - 8;
  list.push({ id: 'prev', x0: 24, x1: 164, y0: fy0, y1: fy1, text: '◀', act: () => { if (page > 0){ page--; draw(); } } });
  list.push({ id: 'next', x0: 178, x1: 318, y0: fy0, y1: fy1, text: '▶', act: () => { if (page < pages - 1){ page++; draw(); } } });
  list.push({ id: 'file', x0: 332, x1: 716, y0: fy0, y1: fy1, text: 'ファイルから追加', act: () => {
    msg = 'ファイルを選ぶ画面を開きます（出ないときは、VRを出てから選んでください）';
    draw();
    try { document.getElementById('videos').click(); } catch (e) {}
  } });
  list.push({ id: 'close', x0: 730, x1: 1000, y0: fy0, y1: fy1, text: '閉じる', act: close });
  return list;
}

function draw(){
  const g = cv.getContext('2d');
  g.clearRect(0, 0, PW, PH);
  g.fillStyle = 'rgba(18,22,30,0.94)'; rr(g, 0, 0, PW, PH, 40); g.fill();
  g.textBaseline = 'middle';
  g.fillStyle = '#fff'; g.font = 'bold 50px sans-serif'; g.textAlign = 'left';
  g.fillText('動画ライブラリ', 36, HEAD / 2 + 4);
  const pages = Math.max(1, Math.ceil(items.length / PER));
  g.fillStyle = '#8ab'; g.font = '30px sans-serif'; g.textAlign = 'right';
  g.fillText(`${items.length} 本・${page + 1} / ${pages}`, PW - 32, HEAD / 2 + 4);
  const hov = panelObj.hoverIds || [];
  const bs = buttons();
  if (!items.length){
    g.fillStyle = '#ccd'; g.font = '34px sans-serif'; g.textAlign = 'center';
    g.fillText('まだ動画がありません', PW / 2, HEAD + 220);
    g.font = '28px sans-serif';
    g.fillText('下の「ファイルから追加」か、VRを出た画面で動画を選んでください', PW / 2, HEAD + 280);
  }
  // タイルを先に描いて、その上に × を描く
  for (const b of [...bs.filter(b => b.tile), ...bs.filter(b => !b.tile)]){
    const hot = hov.includes(b.id);
    if (b.tile){
      const it = b.it, on = placed.has(it.id);
      g.fillStyle = on ? '#1f4a7a' : '#2a3242';
      rr(g, b.x0, b.y0, TW, TH, 20); g.fill();
      // 見本の絵
      const bm = bitmaps.get(it.id), ax = b.x0 + 10, ay = b.y0 + 10, aw = TW - 20, ah = 200;
      g.fillStyle = '#111'; rr(g, ax, ay, aw, ah, 12); g.fill();
      if (bm){
        const k = Math.min(aw / bm.width, ah / bm.height), w = bm.width * k, h = bm.height * k;
        g.drawImage(bm, ax + (aw - w) / 2, ay + (ah - h) / 2, w, h);
      } else {
        g.fillStyle = '#667'; g.font = '26px sans-serif'; g.textAlign = 'center';
        g.fillText('見本を作成中…', ax + aw / 2, ay + ah / 2);
      }
      g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = '30px sans-serif';
      g.fillText(shortName(it.name), b.x0 + 14, b.y0 + 236);
      g.font = 'bold 26px sans-serif';
      g.fillStyle = on ? '#7cf' : '#99a';
      const st = busy === it.id ? '読み込み中…' : on ? '● 出ています' : 'しまってあります';
      g.fillText(`${KIND[it.kind] || ''}　${st}`, b.x0 + 14, b.y0 + 274);
      if (hot){ g.strokeStyle = '#fff'; g.lineWidth = 6; rr(g, b.x0, b.y0, TW, TH, 20); g.stroke(); }
      continue;
    }
    if (b.del){
      const armed = armDel.id === b.it.id && performance.now() - armDel.t < 3000;
      g.fillStyle = hot || armed ? '#e04858' : 'rgba(60,20,28,0.85)';
      rr(g, armed ? b.x0 - 150 : b.x0, b.y0, armed ? b.x1 - b.x0 + 150 : b.x1 - b.x0, b.y1 - b.y0, 14); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 30px sans-serif';
      g.fillText(armed ? 'もう一度で消す' : '×', armed ? (b.x0 - 150 + b.x1) / 2 : (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 + 2);
      continue;
    }
    g.fillStyle = hot ? '#3d8bff' : '#2d3a4f';
    rr(g, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 18); g.fill();
    if (hot){ g.strokeStyle = '#fff'; g.lineWidth = 6; rr(g, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 18); g.stroke(); }
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 34px sans-serif';
    g.fillText(b.text, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 + 2);
  }
  g.textAlign = 'center'; g.font = '26px sans-serif'; g.fillStyle = msg ? '#fc8' : '#89a';
  g.fillText(msg || '押すと正面に出す／もう一度でしまう・× を2回でライブラリから消す',
             PW / 2, FOOT_Y + FOOT_H + 34);
  tex.needsUpdate = true;
}

function at(uv){
  const px = uv.x * PW, py = (1 - uv.y) * PH;
  return buttons().find(b => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) || null;
}

async function toggle(it){
  if (busy) return;
  msg = '';
  if (placed.has(it.id)){ A.videoLib.unplace(it.id); placed = A.videoLib.placed(); draw(); return; }
  busy = it.id; draw();
  try { await A.videoLib.place(it.id); }
  catch (e) { msg = '出せませんでした：' + (e && e.message ? e.message : e); }
  busy = null;
  placed = A.videoLib.placed();
  draw();
}

let thumbing = false;
async function refresh(){
  try { items = await A.videoLib.list(); } catch (e) { items = []; msg = 'ライブラリを読めませんでした'; }
  placed = A.videoLib.placed();
  for (const it of items) if (it.thumb && !bitmaps.has(it.id)){
    try { bitmaps.set(it.id, await createImageBitmap(it.thumb)); } catch (e) {}
  }
  draw();
  // 見本の絵がない動画（前の版で入れたもの）は、1本ずつ作る
  if (thumbing) return;
  thumbing = true;
  try {
    for (const it of items) if (!it.thumb && !bitmaps.has(it.id) && mesh.visible){
      try {
        const b = await A.videoLib.makeThumbFor(it.id);
        if (b) bitmaps.set(it.id, await createImageBitmap(b));
      } catch (e) {}
      draw();
    }
  } finally { thumbing = false; }
}

function close(){ mesh.visible = false; msg = ''; }

Object.assign(panelObj, {
  click: uv => { const b = at(uv); if (b) b.act(); },
  hover: uv => { const b = at(uv); return b ? b.id : null; },
  draw, close,
});
A.uiPanels.push(panelObj);

A.openLibrary = like => {
  A.showPanelAt(mesh, like);
  msg = '';
  refresh();
};
A.libraryChanged = () => { if (mesh.visible) refresh(); };

// 出ている・しまってあるの表示を、ほかの操作（つかんで消すなど）に合わせる
setInterval(() => {
  if (!mesh.visible) return;
  const p = A.videoLib.placed();
  if (p.size !== placed.size || [...p].some(id => !placed.has(id))){ placed = p; draw(); }
}, 1000);

// VRを出たらパネルは閉じる
renderer.xr.addEventListener('sessionend', close);
