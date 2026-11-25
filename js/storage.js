// storage.js — 写真と置いた場所を、このブラウザの中（IndexedDB）に保存して次回復元する
//   写真はネットには上がりません。位置は Quest の「アンカー（部屋の目印）」からの相対位置で保存するので、
//   次にVRに入ったとき、部屋の同じ場所に戻ります。
import * as THREE from 'three';

const A = window.APP;
const { photos, renderer } = A;

// ---------- VRに入るとき「アンカー」機能も使わせてもらう ----------
if (navigator.xr && navigator.xr.requestSession){
  const orig = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = (mode, init = {}) => {
    init.optionalFeatures = [...new Set([...(init.optionalFeatures || []), 'anchors'])];
    return orig(mode, init);
  };
}
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

// ---------- IndexedDB の小さな道具 ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('popPhotoRoom', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('photos', mode);
    const out = fn(t.objectStore('photos'));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
  });
};
const dbPut = rec => tx('readwrite', s => s.put(rec));
const dbDel = id => tx('readwrite', s => s.delete(id));
const dbAll = () => tx('readonly', s => s.getAll());
const dbGet = id => tx('readonly', s => s.get(id));
const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));

// ---------- 部屋の目印（アンカー） ----------
const ANCHOR_KEY = 'popPhotoAnchor';
const Ma = new THREE.Matrix4();      // アンカーの位置（なければ原点）
const MaInv = new THREE.Matrix4();
let anchor = null, anchorReady = false;

renderer.xr.addEventListener('sessionstart', () => {
  anchor = null; anchorReady = false;
  // 復元した写真がある（自動で並べたままではない）なら、自動の並べ直しはしない
  if (photos.length && !A.autoArranged) setTimeout(() => { A.arrangeWait = -1; }, 0);
  const session = renderer.xr.getSession();
  let asked = false;
  const tick = (t, frame) => {
    if (!renderer.xr.isPresenting) return;
    const ref = renderer.xr.getReferenceSpace();
    if (!asked && ref){ asked = true; getAnchor(session, frame, ref); }
    if (anchor && ref){
      const pose = frame.getPose(anchor.anchorSpace, ref);
      if (pose){
        Ma.fromArray(pose.transform.matrix); MaInv.copy(Ma).invert();
        if (!anchorReady){ anchorReady = true; placeFromSaved(); }
      }
    }
    session.requestAnimationFrame(tick);
  };
  session.requestAnimationFrame(tick);
});

async function getAnchor(session, frame, ref){
  const uuid = localStorage.getItem(ANCHOR_KEY);
  if (uuid && session.restorePersistentAnchor){
    try { anchor = await session.restorePersistentAnchor(uuid); A.note('部屋の目印を見つけました'); return; }
    catch (e) { A.note('前の部屋の目印が見つからないので、作り直します'); }
  }
  if (!frame.createAnchor){ A.note('このブラウザは部屋の目印に未対応です（位置は大まかに復元）'); return; }
  try {
    // 自分の今の床の位置（原点）に目印を置く
    anchor = await frame.createAnchor(new XRRigidTransform(), ref);
    if (anchor.requestPersistentHandle){
      const h = await anchor.requestPersistentHandle();
      if (uuid && session.deletePersistentAnchor) session.deletePersistentAnchor(uuid).catch(() => {});
      localStorage.setItem(ANCHOR_KEY, h);
    }
    // 目印を作り直したときは、今見えている位置を新しい目印からの位置として保存し直す
    MaInv.identity();
    photos.forEach(m => m.userData.saveKey = '');
  } catch (e) { A.note('部屋の目印を作れませんでした：' + (e.message || e)); }
}

// 保存してあった「目印からの位置」に写真を置く
function placeFromSaved(){
  const M = new THREE.Matrix4();
  for (const m of photos){
    if (!m.userData.rel) continue;
    M.fromArray(m.userData.rel).premultiply(Ma);
    M.decompose(m.position, m.quaternion, m.scale);
    m.updateMatrixWorld(true);
  }
}

// ---------- 新しい写真ができたら保存 ----------
let restoring = false;
const origArrange = A.arrangeAround;
A.arrangeAround = (...args) => { if (!restoring) origArrange(...args); };

const origBuild = A.buildPhotoMesh;
A.buildPhotoMesh = d => {
  origBuild(d);
  const m = photos[photos.length - 1];
  if (d.saved){
    m.userData.id = d.saved.id;
    m.userData.rel = d.saved.rel;
    m.userData.pinned = !!d.saved.pinned;
    if (d.saved.rel) new THREE.Matrix4().fromArray(d.saved.rel).decompose(m.position, m.quaternion, m.scale);
    A.setCut(m, !!d.saved.cut);
    m.userData.saveKey = keyOf(m);
    return;
  }
  m.userData.id = 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  saveNew(m).catch(e => showErr('写真を保存できませんでした：' + (e.message || e)));
};

async function saveNew(m){
  const u = m.userData;
  const photoCv = m.material.uniforms.map.value.image;
  const maskCv = m.material.uniforms.maskMap.value.image;
  const rec = {
    id: u.id,
    photo: await toBlob(photoCv, 'image/jpeg', 0.92),
    mask: await toBlob(maskCv, 'image/png'),
    width: photoCv.width, height: photoCv.height,
    G: u.G, M: u.M, gw: u.gw, gh: u.gh,
    cut: !!u.cut, pinned: !!u.pinned, rel: relOf(m), time: Date.now(),
  };
  await dbPut(rec);
  u.rel = rec.rel; u.saveKey = keyOf(m);
}

// ---------- 動かした・消したら保存（2秒ごとに確認） ----------
// こっちを向いて回っている分は保存せず、「置いた向き」（baseQ）で保存する
function poseOf(m){
  return new THREE.Matrix4().compose(m.position, m.userData.baseQ || m.quaternion, m.scale);
}
const relOf = m => new THREE.Matrix4().multiplyMatrices(MaInv, poseOf(m)).toArray();
const keyOf = m => poseOf(m).elements.map(v => v.toFixed(3)).join(',') +
  (m.userData.cut ? 'c' : '') + (m.userData.pinned ? 'p' : '');

const known = new Set();
setInterval(async () => {
  if (restoring) return;
  const canSave = !renderer.xr.isPresenting || anchorReady || !localStorage.getItem(ANCHOR_KEY);
  for (const m of photos){
    const u = m.userData;
    if (!u.id || m.parent !== A.scene) continue;   // つかんでいる間は保存しない
    const k = keyOf(m);
    if (!canSave || k === u.saveKey) continue;
    u.saveKey = k;
    const rec = await dbGet(u.id);
    if (!rec) continue;
    rec.rel = relOf(m); rec.cut = !!u.cut; rec.pinned = !!u.pinned;
    u.rel = rec.rel;
    await dbPut(rec);
  }
  // 消した写真は保存からも消す
  const ids = new Set(photos.map(m => m.userData.id));
  for (const id of known) if (!ids.has(id)){ known.delete(id); dbDel(id); }
  ids.forEach(id => id && known.add(id));
}, 2000);

// ---------- ページを開いたら、保存してある写真を復元 ----------
(async () => {
  let recs = [];
  try { recs = await dbAll(); } catch (e) { showErr('保存した写真を読めませんでした：' + (e.message || e)); return; }
  if (!recs.length) return;
  recs.sort((a, b) => a.time - b.time);
  A.status.textContent = `保存してある ${recs.length} 枚を復元中…`;
  restoring = true;
  for (const r of recs){
    try {
      const src = await createImageBitmap(r.photo);
      const mb = await createImageBitmap(r.mask);
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = mb.width; maskCanvas.height = mb.height;
      maskCanvas.getContext('2d').drawImage(mb, 0, 0);
      A.buildPhotoMesh({ src, width: r.width, height: r.height, G: r.G, M: r.M, gw: r.gw, gh: r.gh, maskCanvas, saved: r });
      known.add(r.id);
    } catch (e) { showErr('復元できない写真がありました：' + (e.message || e)); }
  }
  restoring = false;
  A.autoArranged = false;
  A.status.textContent = `保存してあった ${photos.length} 枚を復元しました。START AR を押すと、前に置いた場所に出ます。`;
  A.note(`保存から ${recs.length} 枚を復元`);
})();
