// load.js — ファイルの読み込みと、人の大きさで前に並べる初期配置
import * as THREE from 'three';

const A = window.APP;
const { $, status, photos, camera, renderer } = A;

// PNGはすべて Colabで作ったデータとして扱う（ファイル名が変わっていても中身で判定）
async function isPopFile(f){
  if (/\.png$/i.test(f.name) || f.type === 'image/png') return true;
  try {
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
    return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  } catch (e) {
    return false;
  }
}

// 普通の写真 → ブラウザのAIで奥行きと切り抜きを作る
async function analyzeWithAI(file, label){
  const url = URL.createObjectURL(file);
  try {
    const img = await A.loadImage(url);
    const depthModel = await A.loadDepthModel();
    status.textContent = `${label}：奥行きを推定中…`;
    const depthRaw = (await depthModel(url)).depth;
    status.textContent = `${label}：人物を切り抜き中…`;
    const maskRaw = await A.runCutout(url);

    const [gw, gh] = A.fitSize(img.width, img.height, A.GRID);
    const G = A.canvasToGrid(depthRaw.toCanvas(), gw, gh);
    const [mw, mh] = A.fitSize(img.width, img.height, A.MAX_MASK);
    const maskCanvas = A.rawToCanvas(maskRaw, mw, mh);
    const M = A.canvasToGrid(maskCanvas, gw, gh);
    return { src: img, width: img.width, height: img.height, G, M, gw, gh, maskCanvas };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Colabで作った「〜_pop.png」 → AIを使わず、中のデータをそのまま使う
//   左半分＝写真、右半分＝ 赤:奥行き上位8bit / 緑:奥行き下位8bit / 青:切り抜き
async function readPopFile(file, label){
  status.textContent = `${label}：Colabで作ったデータを読み込み中…`;
  A.note(`${label}：画像を開いています`);
  const url = URL.createObjectURL(file);
  let img;
  try { img = await A.loadImage(url); } finally { URL.revokeObjectURL(url); }
  A.note(`${label}：開けました ${img.width}×${img.height}`);
  const W = Math.floor(img.width / 2), H = img.height;
  if (W < 2 || img.width !== W * 2) throw new Error('PNGはColabで作ったデータとして読み込みますが、この画像は形が合いません。普通の写真はJPGで選んでください');

  const rc = document.createElement('canvas');
  rc.width = W; rc.height = H;
  const rctx = rc.getContext('2d', { willReadFrequently: true });
  rctx.drawImage(img, W, 0, W, H, 0, 0, W, H);
  const id = rctx.getImageData(0, 0, W, H);
  const px = id.data;

  // 奥行き計算用の小さい格子に平均して縮める
  const [gw, gh] = A.fitSize(W, H, A.GRID);
  const G = new Float32Array(gw*gh), M = new Float32Array(gw*gh), cnt = new Float32Array(gw*gh);
  for (let y = 0; y < H; y++){
    const gy = Math.min(gh-1, Math.floor(y * gh / H));
    for (let x = 0; x < W; x++){
      const gx = Math.min(gw-1, Math.floor(x * gw / W));
      const o = (y*W + x) * 4, g = gy*gw + gx;
      G[g] += (px[o] * 256 + px[o+1]) / 65535;
      M[g] += px[o+2] / 255;
      cnt[g]++;
    }
  }
  for (let i = 0; i < gw*gh; i++){
    if (cnt[i] > 0){ G[i] /= cnt[i]; M[i] /= cnt[i]; }
  }

  // 切り抜き（青）を白黒の画像にして、型紙にする
  for (let i = 0; i < W*H; i++){
    const o = i*4, v = px[o+2];
    px[o] = v; px[o+1] = v; px[o+3] = 255;
  }
  rctx.putImageData(id, 0, 0);
  const [mw, mh] = A.fitSize(W, H, A.MAX_MASK);
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mw; maskCanvas.height = mh;
  const mctx = maskCanvas.getContext('2d');
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(rc, 0, 0, mw, mh);
  rc.width = rc.height = 1;   // メモリを早めに返す

  // 写真（左半分）は、表示に使う大きさまで縮めておく
  const [pw, ph] = A.fitSize(W, H, A.MAX_TEX);
  const lc = document.createElement('canvas');
  lc.width = pw; lc.height = ph;
  const lctx = lc.getContext('2d');
  lctx.imageSmoothingQuality = 'high';
  lctx.drawImage(img, 0, 0, W, H, 0, 0, pw, ph);
  img.src = '';               // 大きな元画像を手放す
  return { src: lc, width: W, height: H, G, M, gw, gh, maskCanvas };
}

// =====================================================================
// 初期レイアウト：人の大きさにして、自分の前（左右180°）にぎっしり並べる
//   入りきらないときは、写真どうしを重ねて詰める
//   全身の写真は、床を認識していれば足を床にぴったり立たせる
// =====================================================================
const EYE_FALLBACK = 1.5;   // まだVRに入っていないときの目の高さ（m）
const GAP = 0.05;           // 余裕があるときの写真どうしのすき間（m）
const RADIUS = 1.0;         // 自分からの距離（m）
const SPAN = Math.PI;       // 並べる範囲（正面の左右90°ずつ＝180°）

// 切り抜きの範囲から「人の大きさ」を決める（top・bottom は写真の中での高さ）
A.personLayout = (M, gw, gh, w, h) => {
  let top = gh, bottom = -1, left = gw, right = -1;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++){
    if (M[y*gw + x] > 0.5){
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0 || bottom - top < gh * 0.05){
    // 人が見つからないときは、写真の高さを1.2mにして真ん中を目の高さに
    const s = 1.2 / h;
    return { s, top: h / 2 - 0.1 / s, bottom: -h / 2, cx: 0, width: w * s, fullBody: false };
  }
  const localTop = h / 2 - top / gh * h;
  const localBottom = h / 2 - (bottom + 1) / gh * h;
  const personH = localTop - localBottom;
  const fullBody = bottom < gh - 3;          // 足元まで写っているか
  const s = (fullBody ? 1.6 : 0.9) / personH; // 全身なら身長1.6m、上半身なら0.9m
  const cx = ((left + right + 1) / 2 / gw - 0.5) * w;
  return { s, top: localTop, bottom: localBottom, cx, width: (right - left + 1) / gw * w * s, fullBody };
};

const tmpC = new THREE.Vector3(), tmpF = new THREE.Vector3();
A.arrangeAround = () => {
  if (!photos.length) return;
  A.releaseAll();
  const inXR = renderer.xr.isPresenting;
  camera.getWorldPosition(tmpC);
  camera.getWorldDirection(tmpF);
  const eyeY = inXR ? tmpC.y : EYE_FALLBACK;
  if (!inXR){ tmpC.set(0, 0, 0); tmpF.set(0, 0, -1); }
  tmpF.y = 0;
  if (tmpF.lengthSq() < 1e-4) tmpF.set(0, 0, -1);
  tmpF.normalize();

  // 1人ぶんの角度。合計が180°を超えるなら、全員を同じ割合で詰めて（重ねて）収める
  const angles = photos.map(m => (m.userData.layout.width + GAP) / RADIUS);
  const total = angles.reduce((a, b) => a + b, 0);
  const k = Math.min(1, SPAN / total);
  let phi = total * k / 2;   // 左から右へ
  photos.forEach((m, i) => {
    const L = m.userData.layout;
    const a = phi - angles[i] * k / 2;
    phi -= angles[i] * k;
    const dx = tmpF.x * Math.cos(a) + tmpF.z * Math.sin(a);
    const dz = -tmpF.x * Math.sin(a) + tmpF.z * Math.cos(a);
    m.scale.setScalar(L.s);
    let y;
    if (inXR && L.fullBody && A.floorY !== null){
      y = A.floorY - L.s * L.bottom;          // 足を床にぴったり
    } else {
      y = eyeY + 0.15 - L.s * L.top;          // 頭のてっぺんが目の高さより少し上
    }
    // 重なったときにちらつかないよう、1枚ごとにほんの少し前後をずらす
    const r = RADIUS + (i % 2) * 0.03;
    m.position.set(tmpC.x + dx * r, y, tmpC.z + dz * r);
    m.lookAt(tmpC.x, y, tmpC.z);
    m.translateX(-L.s * L.cx);   // 人が写真の真ん中にいなくても、自分の正面に来るように
  });
  A.autoArranged = true;
  status.textContent = `${photos.length} 枚を自分の前に並べました。`;
};

// VRに入ったら、自分の位置と向きに合わせて並べ直す
renderer.xr.addEventListener('sessionstart', () => { A.arrangeWait = 15; });

async function makePopPhoto(file, label){
  const pop = await isPopFile(file);
  A.note(`${label}：${pop ? 'Colabのデータとして読み込み' : '普通の写真としてAIで処理'}`);
  const data = pop ? await readPopFile(file, label) : await analyzeWithAI(file, label);
  A.note(`${label}：立体を作っています`);
  A.buildPhotoMesh(data);
  A.note(`${label}：完了`);
}

$('files').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  const n = files.length;
  A.note(n ? `${n}枚選ばれました：` + files.map(f => `${f.name || '(名前なし)'} ${(f.size / 1048576).toFixed(1)}MB ${f.type || '?'}`).join(' / ')
           : 'ファイルが渡されませんでした（もう一度選んでみてください）');
  if (!n) return;
  status.textContent = `${n}枚を読み込み中…`;
  const t0 = performance.now();
  for (let i = 0; i < n; i++){
    let eta = '';
    if (i > 0){
      const per = (performance.now() - t0) / i / 1000;
      eta = `（残り約 ${Math.ceil(per * (n - i))} 秒）`;
    }
    A.setBar('allBox','allFill','allText', i/n, `全体 ${i} / ${n} 枚 完了 ${eta}`);
    try {
      await makePopPhoto(files[i], `${i+1} 枚目`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const hint = /読み込めません/.test(msg) && photos.length >= 8
        ? '（形式ではなく、メモリ不足の可能性が高いです。ページを開き直すと、保存済みの写真は残ったまま続きを読み込めます）' : '';
      showErr(`${i+1} 枚目（${files[i].name}）で失敗：${msg}${hint}`);
    }
  }
  A.setBar('allBox','allFill','allText', 1, `全体 ${n} / ${n} 枚 完了`);
  status.textContent = `合計 ${photos.length} 枚 準備完了。START AR を押してください。`;
  e.target.value = '';
});

$('cutAllOn').onclick  = () => { A.allCut = true;  photos.forEach(m => A.setCut(m, true));  A.drawPanel(); };
$('cutAllOff').onclick = () => { A.allCut = false; photos.forEach(m => A.setCut(m, false)); A.drawPanel(); };
