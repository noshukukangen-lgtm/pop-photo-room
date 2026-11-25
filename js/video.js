// video.js — Colabで作った「〜_loop.webm」（背景透明）を読み込んで、立体の写真として再生し続ける
//   ・奥行きは最初のコマからブラウザのAIで作る（動きが小さいので1枚分で十分）
//   ・切り抜きは動画そのものの透明度を使う
//   ・動画はこのブラウザの中に保存し、次に開いたときも動く（ネットには上がりません）
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

// VRに入ったとき、止まっている動画があれば再生し直す
renderer.xr.addEventListener('sessionstart', () => {
  for (const m of photos) if (m.userData.video) m.userData.video.play().catch(() => {});
});

$('videos').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  for (let i = 0; i < files.length; i++){
    try {
      await loadLoopVideo(files[i], `動画 ${i+1} 本目`);
      A.note(`動画 ${i+1} 本目：完了`);
    } catch (err) {
      showErr(`動画 ${i+1} 本目（${files[i].name}）で失敗：${err && err.message ? err.message : err}`);
    }
  }
  if (files.length) status.textContent = `合計 ${photos.length} 枚 準備完了。START AR を押してください。`;
  e.target.value = '';
});
