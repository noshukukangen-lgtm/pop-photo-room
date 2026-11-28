// video.js — Colabで作った「〜_loop.webm」（背景透明）を読み込んで、立体の写真として再生し続ける
//   ・奥行きは最初のコマからブラウザのAIで作る（動きが小さいので1枚分で十分）
//   ・切り抜きは動画そのものの透明度を使う
//   ・動画はこのブラウザの中に保存し、次に開いたときも動く（ネットには上がりません）
//   ・名前に「vr180」が入った動画（左に左目・右に右目）は、自分を囲む半球に左右の目それぞれ映す
//     （撮ったときのカメラ位置から見る形。つかんで動かすことはできない。音も出す）
//   ・「〜_vr180_packed.mp4」は型紙つきの普通の動画：上 2/3 が映像、下 1/3 が型紙（白＝人、黒＝背景）。
//     透明な動画より軽いので、元の画質のまま流せる
//   ・「〜_3d.mp4」（ループ動画・AI動画）は、上 2/3 が映像、下 1/3 の左 2/3 が切り抜き、右 1/3 の上が奥行き・下がふくらみ。
//     再生中のコマの奥行きで毎コマ形を作り直すので、全部のコマで立体になる
//   ・読み込んだ動画は「動画ライブラリ」に残る。VRの中のパネルから、出す・しまう・ライブラリから消すができる（library.js）
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
const vDel = id => tx('readwrite', s => s.delete(id));
const vAll = () => tx('readonly', s => s.getAll());

// 部屋に置いた写真（の id）が、ライブラリのどの動画かの対応表
const MAP_KEY = 'popPhotoVidMap';
const readMap = () => { try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}'); } catch (e) { return {}; } };
const writeMap = mp => { try { localStorage.setItem(MAP_KEY, JSON.stringify(mp)); } catch (e) {} };

// ---------- 動画要素を作る ----------
function makeVideo(blob){
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    // 30秒たっても再生の準備ができなければ、あきらめて理由を出す（大きすぎる・形式に未対応のとき、何も起きないことがある）
    const timer = setTimeout(() => reject(new Error(
      '30秒待っても動画を開けませんでした。このブラウザには大きすぎるか、形式（HEVC）に対応していない可能性があります。' +
      'Colabで画質を「軽め（H.264）」にして作り直してください')), 30000);
    v.addEventListener('loadeddata', () => {
      clearTimeout(timer);
      // 顔を見つける処理などが大きさを読めるように、元の大きさを設定しておく
      v.width = v.videoWidth; v.height = v.videoHeight;
      resolve(v);
    }, { once: true });
    v.addEventListener('error', () => clearTimeout(timer), { once: true });
    v.addEventListener('error', () => reject(new Error(
      '動画を読み込めませんでした（形式が未対応の可能性。VR180なら、Colabで画質を「軽め（H.264）」にして作り直してみてください）')), { once: true });
  });
}

const soundMeshes = new Set();
// 全部のコマで立体にする動画（〜_3d.mp4）用：再生中のコマの奥行き・ふくらみで形を作る
const DV_VERT = `
uniform sampler2D map;
uniform float uDepthS, uRelief, uInflate, uRef;
varying vec2 vUv;
varying vec3 vWorld;
float dvSRGB(float x){ return x < 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
void main(){
  vUv = uv;
  vec3 p = position;
  float d = dvSRGB(texture2D(map, vec2(2.0 / 3.0 + uv.x / 3.0, 1.0 / 6.0 + uv.y / 6.0)).r);
  float b = dvSRGB(texture2D(map, vec2(2.0 / 3.0 + uv.x / 3.0, uv.y / 6.0)).r) * 0.3;
  p.z = uDepthS * (uRef + (d - uRef) * uRelief) + uInflate * b;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
function use3D(m, v){
  const vt = new THREE.VideoTexture(v);
  vt.colorSpace = THREE.SRGBColorSpace;
  vt.minFilter = THREE.LinearFilter;
  vt.magFilter = THREE.LinearFilter;
  vt.generateMipmaps = false;
  for (const mat of [m.material, m.userData.back.material]){
    mat.uniforms.map.value = vt;
    mat.uniforms.uDepthS = { value: A.settings.depth };
    mat.uniforms.uRelief = { value: A.settings.relief };
    mat.uniforms.uInflate = { value: A.settings.inflate };
    mat.vertexShader = DV_VERT;
    mat.fragmentShader = mat.fragmentShader
      .replace('varying vec3 vWorld;', 'varying vec3 vWorld;\nfloat dvSRGB(float x){ return x < 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }')
      .replace('vec4 c = texture2D(map, vUv);', 'vec4 c = texture2D(map, vec2(vUv.x, 1.0 / 3.0 + vUv.y * (2.0 / 3.0)));')
      .replace('float a = texture2D(maskMap, vUv).r;', 'float a = dvSRGB(texture2D(map, vec2(vUv.x * (2.0 / 3.0), vUv.y / 3.0)).r);');
    mat.needsUpdate = true;
  }
  m.userData.video = v;
  m.userData.dv = true;
  // 長い動画（本物の動画を長いまま作ったもの）は、VRの中では音も出す
  m.userData.sound = v.duration > 15;
  if (m.userData.sound) soundMeshes.add(m);
  if (m.userData.sound && renderer.xr.isPresenting) playWithSound(v); else v.play().catch(() => {});
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

// 最初のコマが使える状態になるまで待つ（巻き戻すと、もう「読み込み完了」の合図が来ずに止まることがあるので、合図を待たずに確かめる）
async function firstFrame(v){
  if (v.currentTime > 0.001){
    await new Promise(r => {
      const t = setTimeout(r, 3000);
      v.addEventListener('seeked', () => { clearTimeout(t); r(); }, { once: true });
      v.currentTime = 0;
    });
  }
  for (let i = 0; i < 100 && v.readyState < 2; i++) await new Promise(r => setTimeout(r, 50));
}

// ---------- 全部のコマで立体になる動画（〜_3d.mp4）を読み込む ----------
async function load3DVideo(file, label, v, libId){
  await firstFrame(v);
  const W = v.videoWidth, Ht = v.videoHeight;
  const H = Math.round(Ht * 2 / 3), bh = Ht - H, mw = Math.round(W * 2 / 3), dw = W - mw, qh = Math.floor(bh / 2);
  // 最初のコマ：映像（上）、型紙（左下 2/3）、奥行き（右下の上半分）
  const frame = document.createElement('canvas');
  frame.width = W; frame.height = H;
  frame.getContext('2d').drawImage(v, 0, 0, W, H, 0, 0, W, H);
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = W; maskCanvas.height = H;
  const mctx = maskCanvas.getContext('2d');
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(v, 0, H, mw, bh, 0, 0, W, H);
  const depthCanvas = document.createElement('canvas');
  depthCanvas.width = dw; depthCanvas.height = qh;
  depthCanvas.getContext('2d').drawImage(v, mw, H, dw, qh, 0, 0, dw, qh);
  const [gw, gh] = A.fitSize(W, H, A.GRID);
  const G = A.canvasToGrid(depthCanvas, gw, gh);
  const M = A.canvasToGrid(maskCanvas, gw, gh);
  A.note(`${label}：全部のコマで立体になる動画です（${W}×${H}）`);
  A.buildPhotoMesh({ src: frame, width: W, height: H, G, M, gw, gh, maskCanvas, videoFile: file, videoEl: v, dv: true, libId });
}

// ---------- 新しく読み込んだ動画から、立体の写真を作る ----------
async function loadLoopVideo(file, label, opened, libId){
  status.textContent = `${label}：動画を開いています…`;
  const v = opened || await makeVideo(file);
  await firstFrame(v);
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

  A.buildPhotoMesh({ src: frame, width: w, height: h, G, M, gw, gh, maskCanvas, videoFile: file, videoEl: v, libId });
}

// buildPhotoMesh を包んで、動画なら見た目を差し替え＆ライブラリと結びつける。復元した写真に動画があれば差し替え
//   VRの中でライブラリから出したときは、全体を並べ直さずに、自分の正面に1つだけ置く
let placeNext = false, skipArrange = false;
const origArrange = A.arrangeAround;
A.arrangeAround = (...args) => { if (!skipArrange) origArrange(...args); };
const cPos = new THREE.Vector3(), cDir = new THREE.Vector3();
function placeInFront(m){
  const L = m.userData.layout, inXR = renderer.xr.isPresenting;
  A.camera.getWorldPosition(cPos);
  A.camera.getWorldDirection(cDir);
  const eyeY = inXR ? cPos.y : 1.5;
  if (!inXR){ cPos.set(0, 0, 0); cDir.set(0, 0, -1); }
  cDir.y = 0;
  if (cDir.lengthSq() < 1e-4) cDir.set(0, 0, -1);
  cDir.normalize();
  m.scale.setScalar(L.s);
  const y = (inXR && L.fullBody && A.floorY !== null) ? A.floorY - L.s * L.bottom : eyeY + 0.15 - L.s * L.top;
  m.position.set(cPos.x + cDir.x * 1.2, y, cPos.z + cDir.z * 1.2);
  m.lookAt(cPos.x, y, cPos.z);
  m.translateX(-L.s * L.cx);
  m.updateMatrixWorld(true);
}

const origBuild = A.buildPhotoMesh;
A.buildPhotoMesh = d => {
  const front = placeNext;
  placeNext = false;
  skipArrange = front;
  try { origBuild(d); } finally { skipArrange = false; }
  const m = photos[photos.length - 1];
  if (!m) return;
  if (front){
    A.autoArranged = false;
    placeInFront(m);
    // 顔に合わせた大きさが少しあとで決まるので、まだ動かしていなければ置き直す
    const p0 = m.position.clone();
    setTimeout(() => { if (photos.includes(m) && m.parent === A.scene && m.position.distanceTo(p0) < 1e-4) placeInFront(m); }, 1500);
  }
  if (d.videoEl){
    if (d.dv) use3D(m, d.videoEl); else useVideo(m, d.videoEl);
    m.userData.libId = d.libId;
    const link = () => {
      if (!m.userData.id) return setTimeout(link, 200);
      const mp = readMap(); mp[m.userData.id] = d.libId; writeMap(mp);
    };
    if (d.libId) link();
  } else if (d.saved){
    const libId = readMap()[d.saved.id] || d.saved.id;
    vGet(libId).then(async rec => {
      if (!rec || !photos.includes(m)) return;
      const v = await makeVideo(rec.video);
      m.userData.libId = libId;
      if (rec.dv) use3D(m, v); else useVideo(m, v);
    }).catch(() => {});
  }
};

// ---------- 動画ライブラリ ----------
// 小さな見本の絵（ライブラリのパネルに出す）。sw×sh の範囲を切り取る
async function makeThumb(v, sw, sh){
  const k = Math.min(1, 240 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(v, 0, 0, sw, sh, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
const thumbRect = (v, kind, packed) => {
  const W = v.videoWidth, H = v.videoHeight;
  if (kind === 'dv') return [W, Math.round(H * 2 / 3)];
  if (kind === 'vr180') return [Math.round(W / 2), packed ? Math.round(H * 2 / 3) : H];
  return [W, H];
};
async function addToLib(file, v, kind, packed){
  const id = 'v' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  let thumb = null;
  try { await firstFrame(v); thumb = await makeThumb(v, ...thumbRect(v, kind, packed)); } catch (e) {}
  // 大きな動画は保存に時間がかかるので、待たずに進める
  vPut({ id, video: file, dv: kind === 'dv', kind, packed: !!packed, name: file.name || '', thumb, time: Date.now() })
    .then(() => A.libraryChanged && A.libraryChanged())
    .catch(e => showErr('動画をライブラリに保存できませんでした：' + (e.message || e)));
  return id;
}
const kindOf = r => r.kind || (r.dv ? 'dv' : 'loop');

A.videoLib = {
  // ライブラリの一覧（古い順）。動画そのものは読み込まない
  async list(){
    const recs = await vAll();
    return recs.map(r => ({ id: r.id, name: r.name || '', kind: kindOf(r), thumb: r.thumb || null, time: r.time || 0 }))
               .sort((a, b) => a.time - b.time);
  },
  // 今、部屋に出ている動画の id
  placed(){
    const s = new Set(photos.map(m => m.userData.libId).filter(Boolean));
    if (vr && vr.libId) s.add(vr.libId);
    return s;
  },
  // 前の版で保存した動画には見本の絵がないので、あとから作る
  async makeThumbFor(id){
    const rec = await vGet(id);
    if (!rec || rec.thumb) return rec && rec.thumb;
    const v = await makeVideo(rec.video);
    try {
      await firstFrame(v);
      rec.thumb = await makeThumb(v, ...thumbRect(v, kindOf(rec), rec.packed));
      await vPut(rec);
    } finally { v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
    return rec.thumb;
  },
  // 部屋に出す（VRの中なら自分の正面に）
  async place(id){
    const rec = await vGet(id);
    if (!rec) throw new Error('ライブラリに見つかりません');
    const v = await makeVideo(rec.video);
    const kind = kindOf(rec), label = rec.name || '動画';
    if (kind === 'vr180'){ await loadVR180(rec.video, v, rec.name, id); return; }
    placeNext = true;
    try {
      if (kind === 'dv') await load3DVideo(rec.video, label, v, id);
      else await loadLoopVideo(rec.video, label, v, id);
    } finally { placeNext = false; }
  },
  // 部屋からしまう（ライブラリには残る）
  unplace(id){
    if (vr && vr.libId === id) clearVR180();
    const mp = readMap();
    for (const m of [...photos]) if (m.userData.libId === id){
      if (m.userData.id) delete mp[m.userData.id];
      A.disposePhoto(m);
    }
    writeMap(mp);
    A.drawPanel();
  },
  // ライブラリからも消す
  async remove(id){
    this.unplace(id);
    const mp = readMap();
    for (const k of Object.keys(mp)) if (mp[k] === id) delete mp[k];
    writeMap(mp);
    await vDel(id);
  },
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

// 音を出して再生（ブラウザに止められたら、音なしで再生）
function playWithSound(v){
  v.muted = false;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}

// 半球の見た目。型紙つき（packed）なら、上 2/3 の映像を下 1/3 の型紙で切り抜く
const VR_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const VR_FRAG = `
uniform sampler2D map;
uniform float uPacked;
varying vec2 vUv;
float toSRGB(float x){ return x < 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
void main(){
  vec4 c;
  float a;
  if (uPacked > 0.5){
    c = texture2D(map, vec2(vUv.x, 1.0 / 3.0 + vUv.y * (2.0 / 3.0)));
    // 型紙は色として読まれるので、元の明るさに戻してから使う
    a = toSRGB(texture2D(map, vec2(vUv.x, vUv.y / 3.0)).r);
    a = smoothstep(0.08, 0.92, a);
  } else {
    c = texture2D(map, vUv);
    a = c.a;
  }
  if (a < 0.02) discard;
  gl_FragColor = vec4(c.rgb, a);
  #include <colorspace_fragment>
}`;

async function loadVR180(file, opened, name, libId){
  status.textContent = 'VR180の動画を開いています…（30秒ほどかかることがあります）';
  const v = opened || await makeVideo(file);
  clearVR180();
  // 型紙つきかどうか：名前に「packed」があるか、縦横比が 3:4 に近い（ふつうのVR180は 1:2）
  const packed = /packed/i.test(name || file.name || '') || v.videoHeight > v.videoWidth * 0.62;
  if (!libId) libId = await addToLib(file, v, 'vr180', packed);
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
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uPacked: { value: packed ? 1 : 0 } },
      vertexShader: VR_VERT,
      fragmentShader: VR_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.set(eye + 1);                  // three.js では 1＝左目だけ、2＝右目だけに見える
    mesh.renderOrder = -1;
    mesh.raycast = () => {};
    group.add(mesh);
  });
  A.scene.add(group);
  vr = { group, v, tex, needYaw: true, libId };
  // VRに入る前は音なしで。VRに入ったら最初から音つきで流す
  v.play().catch(() => {});
  if (renderer.xr.isPresenting){ v.currentTime = 0; playWithSound(v); }
  const eyeW = v.videoWidth / 2;
  const eyeH = packed ? v.videoHeight * 2 / 3 : v.videoHeight;
  status.textContent = 'VR180の動画を読み込みました。START AR を押すと、撮ったときの位置に人が見えます（音も出ます）。';
  A.note(`VR180の動画を読み込みました（片目 ${Math.round(eyeW)}×${Math.round(eyeH)}${packed ? '・型紙つき' : ''}）`);
  watchSmoothness(v);
}

// 再生がカクついていないか見て、ひどければ知らせる（コマ落ちの割合）
function watchSmoothness(v){
  if (!v.getVideoPlaybackQuality) return;
  let last = null;
  const iv = setInterval(() => {
    if (!vr || vr.v !== v){ clearInterval(iv); return; }
    if (v.paused) return;
    const q = v.getVideoPlaybackQuality();
    if (last){
      const total = q.totalVideoFrames - last.totalVideoFrames;
      const dropped = q.droppedVideoFrames - last.droppedVideoFrames;
      if (total > 30 && dropped / total > 0.2){
        A.note(`VR180：コマ落ちが多めです（${Math.round(dropped / total * 100)}%）。カクつくなら、Colabで画質を「軽め」にして作り直してください`);
        clearInterval(iv);
      }
    }
    last = q;
  }, 10000);
}

// 半球はいつも自分の頭の位置に。向きはVRに入ったときの正面に合わせる
const origRender = renderer.render.bind(renderer);
renderer.render = (scene, cam) => {
  // 消した写真の動画の音が鳴り続けないように止める
  for (const m of soundMeshes) if (!photos.includes(m)){ m.userData.video && m.userData.video.pause(); soundMeshes.delete(m); }
  for (const m of photos){
    if (!m.userData.dv) continue;
    for (const mat of [m.material, m.userData.back.material]){
      mat.uniforms.uDepthS.value = A.settings.depth;
      mat.uniforms.uRelief.value = A.settings.relief;
      mat.uniforms.uInflate.value = A.settings.inflate;
    }
  }
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

// VRに入ったとき、止まっている動画があれば再生し直す。VR180は最初から音つきで
renderer.xr.addEventListener('sessionstart', () => {
  for (const m of photos) if (m.userData.video){
    if (m.userData.sound){ m.userData.video.currentTime = 0; playWithSound(m.userData.video); }
    else m.userData.video.play().catch(() => {});
  }
  if (vr){ vr.v.currentTime = 0; playWithSound(vr.v); vr.needYaw = true; }
});
// VRから出たら、VR180の音は止める
renderer.xr.addEventListener('sessionend', () => {
  if (vr){ vr.v.muted = true; }
  for (const m of photos) if (m.userData.sound) m.userData.video.muted = true;
});

// VR180かどうかは、名前だけでなく中身の形でも見分ける（Questで選ぶと名前が変わることがあるため）
//   ・横が縦の約2倍 → ふつうのVR180（左右並び）
//   ・WebMではなく、縦横比が 3:4 → 型紙つきのVR180（〜_vr180_packed.mp4）
const nameVR180 = f => /vr180/i.test(f.name);
// WebMかどうかは中身の先頭で見分ける（名前や種類が変わっていても大丈夫）
async function isWebm(f){
  try {
    const b = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    return b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;
  } catch (e) { return /webm/i.test(f.type) || /\.webm$/i.test(f.name); }
}
function looksVR180(f, v, webm){
  if (nameVR180(f)) return true;
  const w = v.videoWidth, h = v.videoHeight;
  if (w >= 1.9 * h) return true;
  return !webm && Math.abs(h / w - 0.75) < 0.04 && w >= 2000;
}

$('videos').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  const probe = document.createElement('video');
  const can = c => probe.canPlayType(`video/mp4; codecs="${c}"`) || 'いいえ';
  let vrCount = 0;
  for (let i = 0; i < files.length; i++){
    const f = files[i], label = `動画 ${i+1} 本目`;
    try {
      status.textContent = `${label}：動画を開いています…（大きい動画は30秒ほどかかります）`;
      A.note(`${label}：${f.name || '(名前なし)'}（${(f.size / 1048576).toFixed(0)} MB・${f.type || '?'}）を開いています。` +
             `HEVCの再生：${can('hvc1')}／H.264の再生：${can('avc1.640033')}`);
      const webm = await isWebm(f);
      const v = await makeVideo(f);
      A.note(`${label}：開けました ${v.videoWidth}×${v.videoHeight}`);
      if (looksVR180(f, v, webm)){ vrCount++; await loadVR180(f, v); }
      else {
        // WebMでないループ動画は、全部のコマで立体になる動画（〜_3d.mp4）
        const kind = webm ? 'loop' : 'dv';
        const libId = await addToLib(f, v, kind);
        placeNext = renderer.xr.isPresenting;     // VRの中で選んだときは、自分の正面に置く
        try {
          if (kind === 'dv') await load3DVideo(f, label, v, libId);
          else await loadLoopVideo(f, label, v, libId);
        } finally { placeNext = false; }
        A.note(`${label}：完了`);
      }
    } catch (err) {
      showErr(`${label}（${f.name}）で失敗：${err && err.message ? err.message : err}`);
    }
  }
  if (files.length && vrCount < files.length) status.textContent = `合計 ${photos.length} 枚 準備完了。START AR を押してください。`;
  e.target.value = '';
});
