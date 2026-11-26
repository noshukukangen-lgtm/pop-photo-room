// video.js — Colabで作った「〜_loop.webm」（背景透明）を読み込んで、立体の写真として再生し続ける
//   ・奥行きは最初のコマからブラウザのAIで作る（動きが小さいので1枚分で十分）
//   ・切り抜きは動画そのものの透明度を使う
//   ・動画はこのブラウザの中に保存し、次に開いたときも動く（ネットには上がりません）
//   ・「〜_vr180_loop.webm」（左に左目・右に右目）は、自分を囲む半球に左右の目それぞれ映す
//     （撮ったときのカメラ位置から見る形。つかんで動かすことはできない）
import * as THREE from 'three';

const A = window.APP;
const { $, status, photos, renderer } = A;

// ---------- 動画の保存場所（写真とは別のデータベース） ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('popPhotoRoomVideo', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('videos', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('videos', mode);
    const out = fn(t.objectStore('videos'));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
  });
};
const vPut = rec => tx('readwrite', s => s.put(rec));
const vGet = id => tx('readonly', s => s.get(id));

// ---------- 動画要素を作る ----------
function makeVideo(blob){
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    v.addEventListener('loadeddata', () => {
      // 顔を見つける処理などが大きさを読めるように、元の大きさを設定しておく
      v.width = v.videoWidth; v.height = v.videoHeight;
      resolve(v);
    }, { once: true });
    v.addEventListener('error', () => reject(new Error('動画を読み込めませんでした（形式が未対応の可能性）')), { once: true });
  });
}

// 写真の見た目を動画に差し替える（透明度は動画のものを使う）
function useVideo(m, v){
  const vt = new THREE.VideoTexture(v);
  vt.colorSpace = THREE.SRGBColorSpace;
  vt.minFilter = THREE.LinearFilter;
  vt.magFilter = THREE.LinearFilter;
  vt.generateMipmaps = false;
  for (const mat of [m.material, m.userData.back.material]){
    mat.uniforms.map.value = vt;
    mat.fragmentShader = mat.fragmentShader.replace('texture2D(maskMap, vUv).r', 'texture2D(map, vUv).a');
    mat.needsUpdate = true;
  }
  m.userData.video = v;
  v.play().catch(() => {});
}

// ---------- 新しく読み込んだ動画から、立体の写真を作る ----------
async function loadLoopVideo(file, label){
  status.textContent = `${label}：動画を開いています…`;
  const v = await makeVideo(file);
  v.currentTime = 0;
  await new Promise(r => v.readyState >= 2 ? r() : v.addEventListener('loadeddata', r, { once: true }));
  const w = v.videoWidth, h = v.videoHeight;

  // 最初のコマ
  const frame = document.createElement('canvas');
  frame.width = w; frame.height = h;
  const fctx = frame.getContext('2d', { willReadFrequently: true });
  fctx.drawImage(v, 0, 0, w, h);

  // 透明度 → 白黒の切り抜きマスク
  const id = fctx.getImageData(0, 0, w, h);
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w; maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  const md = mctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++){
    const a = id.data[i*4 + 3];
    md.data[i*4] = md.data[i*4+1] = md.data[i*4+2] = a; md.data[i*4+3] = 255;
  }
  mctx.putImageData(md, 0, 0);

  // 奥行き（最初のコマから）
  status.textContent = `${label}：奥行きを推定中…`;
  const depthModel = await A.loadDepthModel();
  const blob = await new Promise(r => frame.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(blob);
  let depthRaw;
  try { depthRaw = (await depthModel(url)).depth; } finally { URL.revokeObjectURL(url); }

  const [gw, gh] = A.fitSize(w, h, A.GRID);
  const G = A.canvasToGrid(depthRaw.toCanvas(), gw, gh);
  const M = A.canvasToGrid(maskCanvas, gw, gh);

  A.buildPhotoMesh({ src: frame, width: w, height: h, G, M, gw, gh, maskCanvas, videoFile: file, videoEl: v });
}

// buildPhotoMesh を包んで、動画なら見た目を差し替え＆保存。復元した写真に動画があれば差し替え
const origBuild = A.buildPhotoMesh;
A.buildPhotoMesh = d => {
  origBuild(d);
  const m = photos[photos.length - 1];
  if (!m) return;
  if (d.videoEl){
    useVideo(m, d.videoEl);
    const save = () => {
      if (!m.userData.id) return setTimeout(save, 200);
      vPut({ id: m.userData.id, video: d.videoFile }).catch(e => showErr('動画を保存できませんでした：' + (e.message || e)));
    };
    save();
  } else if (d.saved){
    vGet(d.saved.id).then(async rec => {
      if (!rec || !photos.includes(m)) return;
      useVideo(m, await makeVideo(rec.video));
    }).catch(() => {});
  }
};

// =====================================================================
// VR180（左に左目・右に右目）— 自分を囲む半球に、左右の目それぞれの映像を映す
// =====================================================================
let vr = null;
const vrPos = new THREE.Vector3(), vrFwd = new THREE.Vector3();

function clearVR180(){
  if (!vr) return;
  A.scene.remove(vr.group);
  vr.group.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
  vr.tex.dispose();
  vr.v.pause();
  URL.revokeObjectURL(vr.v.src);
  vr = null;
}
A.clearVR180 = clearVR180;

async function loadVR180(file){
  status.textContent = 'VR180の動画を開いています…';
  const v = await makeVideo(file);
  clearVR180();
  const tex = new THREE.VideoTexture(v);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const group = new THREE.Group();
  [0, 1].forEach(eye => {
    // 正面（-Z）が映像の真ん中、左端〜右端が左90°〜右90°になる半球
    const geo = new THREE.SphereGeometry(20, 96, 48, -Math.PI, Math.PI);
    geo.scale(-1, 1, 1);                       // 内側から見る
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + eye * 0.5);   // 左目は左半分、右目は右半分
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.02 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.set(eye + 1);                  // three.js では 1＝左目だけ、2＝右目だけに見える
    mesh.renderOrder = -1;
    mesh.raycast = () => {};
    group.add(mesh);
  });
  A.scene.add(group);
  vr = { group, v, tex, needYaw: true };
  v.play().catch(() => {});
  status.textContent = 'VR180の動画を読み込みました。START AR を押すと、撮ったときの位置に人が見えます。';
  A.note('VR180の動画を読み込みました（左右の目で別々に表示）');
}

// 半球はいつも自分の頭の位置に。向きはVRに入ったときの正面に合わせる
const origRender = renderer.render.bind(renderer);
renderer.render = (scene, cam) => {
  if (vr){
    A.camera.getWorldPosition(vrPos);
    vr.group.position.copy(vrPos);
    if (vr.needYaw && renderer.xr.isPresenting){
      A.camera.getWorldDirection(vrFwd);
      vr.group.rotation.y = Math.atan2(-vrFwd.x, -vrFwd.z);
      vr.needYaw = false;
    }
  }
  origRender(scene, cam);
};

// VRに入ったとき、止まっている動画があれば再生し直す
renderer.xr.addEventListener('sessionstart', () => {
  for (const m of photos) if (m.userData.video) m.userData.video.play().catch(() => {});
  if (vr){ vr.v.play().catch(() => {}); vr.needYaw = true; }
});

const isVR180 = f => /vr180/i.test(f.name);

$('videos').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  for (let i = 0; i < files.length; i++){
    try {
      if (isVR180(files[i])) await loadVR180(files[i]);
      else {
        await loadLoopVideo(files[i], `動画 ${i+1} 本目`);
        A.note(`動画 ${i+1} 本目：完了`);
      }
    } catch (err) {
      showErr(`動画 ${i+1} 本目（${files[i].name}）で失敗：${err && err.message ? err.message : err}`);
    }
  }
  if (files.length && !files.every(isVR180)) status.textContent = `合計 ${photos.length} 枚 準備完了。START AR を押してください。`;
  e.target.value = '';
});
