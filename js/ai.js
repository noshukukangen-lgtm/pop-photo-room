// ai.js — 奥行き・切り抜きのAIと、画像処理の道具
import * as THREE from 'three';
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

const A = window.APP;
const { $, status } = A;

// =====================================================================
// AIモデル
// =====================================================================
let depthModel = null;
A.loadDepthModel = async () => {
  if (depthModel) return depthModel;
  status.textContent = '奥行きAIを準備中…（初回だけダウンロードがあります）';
  depthModel = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small',
    { progress_callback: A.onDownloadProgress });
  return depthModel;
};

const cutModels = {};
async function loadCutModel(kind){
  if (cutModels[kind]) return cutModels[kind];
  if (kind === 'modnet'){
    status.textContent = '切り抜きAI（軽量）を準備中…';
    const pipe = await pipeline('background-removal', 'Xenova/modnet', { progress_callback: A.onDownloadProgress });
    cutModels.modnet = {
      name: '軽量（MODNet）',
      run: async url => { const r = await pipe(url); return Array.isArray(r) ? r[0] : r; }
    };
    return cutModels.modnet;
  }
  if (kind === 'rmbg'){
    status.textContent = '切り抜きAI（標準）を準備中…初回は約45MBのダウンロードがあります';
    const pipe = await pipeline('background-removal', 'briaai/RMBG-1.4',
      { dtype:'q8', progress_callback: A.onDownloadProgress });
    cutModels.rmbg = {
      name: '標準（RMBG）',
      run: async url => { const r = await pipe(url); return Array.isArray(r) ? r[0] : r; }
    };
    return cutModels.rmbg;
  }
  throw new Error('不明な切り抜きAI：' + kind);
}

const markRunning = kind => { try { kind ? localStorage.setItem(A.RUN_KEY, kind) : localStorage.removeItem(A.RUN_KEY); } catch (e) {} };

A.runCutout = async url => {
  let kind = $('cutModel').value;
  for (;;){
    try {
      markRunning(kind);
      const m = await loadCutModel(kind);
      status.textContent += `（切り抜き：${m.name}）`;
      const r = await m.run(url);
      markRunning(null);
      return r;
    } catch (e) {
      markRunning(null);
      const msg = e && e.message ? e.message : String(e);
      if (kind === 'modnet') throw e;
      const next = A.LIGHTER[kind];
      showErr(`「${A.CUT_NAMES[kind]}」が使えなかったので「${A.CUT_NAMES[next]}」に切り替えます：${msg}`);
      delete cutModels[kind];
      kind = next;
      $('cutModel').value = kind; A.saveSettings();
    }
  }
};

// =====================================================================
// 画像まわりの道具
// =====================================================================
A.loadImage = url => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('画像を読み込めませんでした（形式が未対応の可能性）'));
  img.src = url;
});

A.toTexture = (canvas, color = true) => {
  const tex = new THREE.CanvasTexture(canvas);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = A.ANISO;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
};

const fitSize = A.fitSize = (w, h, max) => {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w*k)), Math.max(1, Math.round(h*k))];
};

A.drawPhoto = img => {
  const [w, h] = fitSize(img.width, img.height, A.MAX_TEX);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return cv;
};

// RawImage の1ピクセルの値（RGBAなら透明度、それ以外は1チャンネル目）
const rawVal = (raw, i) => raw.channels === 4 ? raw.data[i*4+3] : raw.data[i*raw.channels];

// RawImage → 白黒の canvas（マスク用）
A.rawToCanvas = (raw, w, h) => {
  const src = document.createElement('canvas');
  src.width = raw.width; src.height = raw.height;
  const sctx = src.getContext('2d');
  const id = sctx.createImageData(raw.width, raw.height);
  for (let i = 0; i < raw.width*raw.height; i++){
    const v = rawVal(raw, i);
    id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = v; id.data[i*4+3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return cv;
};

// canvas → 0〜1 の数値の配列（赤チャンネル）
A.canvasToGrid = (canvas, w, h) => {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w*h);
  for (let i = 0; i < w*h; i++) g[i] = d[i*4] / 255;
  return g;
};

function boxBlur(src, w, h, r){
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w*h), out = new Float32Array(w*h), n = 2*r + 1;
  for (let y = 0; y < h; y++){
    const row = y*w; let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(w-1, Math.max(0, k))];
    for (let x = 0; x < w; x++){
      tmp[row+x] = s / n;
      s += src[row + Math.min(w-1, x+r+1)] - src[row + Math.max(0, x-r)];
    }
  }
  for (let x = 0; x < w; x++){
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h-1, Math.max(0, k))*w + x];
    for (let y = 0; y < h; y++){
      out[y*w+x] = s / n;
      s += tmp[Math.min(h-1, y+r+1)*w + x] - tmp[Math.max(0, y-r)*w + x];
    }
  }
  return out;
}
const blur2 = (a, w, h, r) => boxBlur(boxBlur(a, w, h, r), w, h, r);

// 人物の中だけでなめらかにする（背景の奥行きが顔のふちに混ざらないように）
A.smoothDepth = (G, M, w, h, r) => {
  if (r <= 0) return G.slice();
  const W = new Float32Array(w*h), GW = new Float32Array(w*h);
  for (let i = 0; i < w*h; i++){ W[i] = M[i] > 0.5 ? 1 : 0; GW[i] = G[i] * W[i]; }
  const P1 = blur2(GW, w, h, r), P2 = blur2(W, w, h, r), all = blur2(G, w, h, r);
  const P = new Float32Array(w*h);
  for (let i = 0; i < w*h; i++) P[i] = (W[i] > 0 && P2[i] > 1e-3) ? P1[i] / P2[i] : all[i];
  return P;
};

// 人物を風船のようにふくらませる形を作る（輪郭で0、太いところほど高い）
// 切り抜きの中で「∇²h = -1、輪郭で h = 0」を解いて √(2h) にすると、
// 腕のような細い部分は細い円柱、胴のような太い部分は太く丸くなる
A.computeBulge = (M, gw, gh, photoH) => {
  const [sw, sh] = fitSize(gw, gh, 160);
  const inside = new Uint8Array(sw*sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++){
    const gx = Math.min(gw-1, Math.floor((x + 0.5) * gw / sw));
    const gy = Math.min(gh-1, Math.floor((y + 0.5) * gh / sh));
    inside[y*sw + x] = M[gy*gw + gx] > 0.5 ? 1 : 0;
  }
  const cell = photoH / sh, c = cell * cell, w = 1.94;
  const h = new Float32Array(sw*sh);
  for (let it = 0; it < 500; it++){
    for (let y = 0; y < sh; y++){
      for (let x = 0; x < sw; x++){
        const i = y*sw + x;
        if (!inside[i]) continue;
        // 写真のふち（人物が画面で切れている所）は平らに伸ばす
        const l = x > 0 ? h[i-1] : h[i], r = x < sw-1 ? h[i+1] : h[i];
        const u = y > 0 ? h[i-sw] : h[i], d = y < sh-1 ? h[i+sw] : h[i];
        h[i] += w * ((l + r + u + d + c) / 4 - h[i]);
      }
    }
  }
  let S = new Float32Array(sw*sh);
  for (let i = 0; i < sw*sh; i++) S[i] = Math.sqrt(2 * Math.max(0, h[i]));
  S = boxBlur(S, sw, sh, 1);
  // 奥行きと同じ格子の大きさに戻す
  const B = new Float32Array(gw*gh);
  for (let y = 0; y < gh; y++){
    const fy = Math.min(sh-1, Math.max(0, (y + 0.5) * sh / gh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(y0+1, sh-1), ay = fy - y0;
    for (let x = 0; x < gw; x++){
      const fx = Math.min(sw-1, Math.max(0, (x + 0.5) * sw / gw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(x0+1, sw-1), ax = fx - x0;
      B[y*gw + x] = S[y0*sw+x0]*(1-ax)*(1-ay) + S[y0*sw+x1]*ax*(1-ay) + S[y1*sw+x0]*(1-ax)*ay + S[y1*sw+x1]*ax*ay;
    }
  }
  return B;
};

A.medianMasked = (G, M) => {
  const vals = [];
  for (let i = 0; i < G.length; i++) if (M[i] > 0.5) vals.push(G[i]);
  const arr = vals.length > 50 ? vals : Array.from(G);
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] || 0.5;
};
