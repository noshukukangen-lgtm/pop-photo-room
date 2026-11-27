// splat.js — Colabで作った立体人物（3Dガウシアン .ply：LHM++ の全身・LAM の頭部）を部屋に置く
//   ・写真と違って本当の立体なので、回り込んで横や後ろからも見られる（こっちを向く・透ける・呼吸はしない）
//   ・小さな色つきの「ぼかし玉」が数十万個集まって人の形になっている。毎フレーム、奥から順に重ねて描く
//     （重ねる順番は、別の作業係（Worker）が並べ替えるので、描くのは止まらない）
//   ・つかんで移動・両手で拡大縮小・床に吸い付く は写真と同じ。つかんで A・X：上下さかさまを直す
//   ・ply は このブラウザの中に保存し、次に開いたときも同じ場所に戻る（ネットには上がりません）
import * as THREE from 'three';

const A = window.APP;
const { $, status, scene, camera, renderer } = A;
const people = A.people = [];

// ---------- 保存場所（写真・動画とは別のデータベース） ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('popPhotoRoomPeople', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('people', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('people', mode);
    const out = fn(t.objectStore('people'));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
  });
};
const pPut = rec => tx('readwrite', s => s.put(rec));
const pGet = id => tx('readonly', s => s.get(id));
const pDel = id => tx('readwrite', s => s.delete(id));
const pAll = () => tx('readonly', s => s.getAll());

// =====================================================================
// ply を読む（3Dガウシアンのふつうの形。色が「そのままの色」で入っている LAM の頭部にも対応）
// =====================================================================
const SIZES = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1,
                short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4 };

function parsePly(buf){
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 65536)));
  const k = head.indexOf('end_header');
  if (!head.startsWith('ply') || k < 0) throw new Error('ply ファイルではないようです');
  const start = head.indexOf('\n', k) + 1;
  const lines = head.slice(0, k).split(/\r?\n/);
  if (!lines.some(l => /^format binary_little_endian/.test(l))) throw new Error('この ply の形（文字で書かれた形など）には未対応です');
  let n = 0, inV = false, before = false;
  const props = [];
  for (const l of lines){
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element'){
      inV = t[1] === 'vertex';
      if (inV) n = +t[2];
      else if (!n && +t[2] > 0) before = true;
    } else if (t[0] === 'property' && inV){
      if (t[1] === 'list') throw new Error('この ply の形には未対応です');
      props.push({ name: t[2], type: t[1] });
    }
  }
  if (before) throw new Error('この ply の形には未対応です（点の前に別のデータがある）');
  let stride = 0;
  const off = {};
  for (const p of props){
    if (!SIZES[p.type]) throw new Error('この ply の形には未対応です（' + p.type + '）');
    off[p.name] = { o: stride, t: p.type };
    stride += SIZES[p.type];
  }
  for (const need of ['x', 'y', 'z']) if (!off[need]) throw new Error('ply に位置のデータがありません');
  const dv = new DataView(buf, start);
  if (dv.byteLength < n * stride) throw new Error('ply が途中で切れています（ダウンロードが終わっていない？）');
  const rd = (f, i) => {
    const o = i * stride + f.o;
    switch (f.t){
      case 'float': case 'float32': return dv.getFloat32(o, true);
      case 'double': case 'float64': return dv.getFloat64(o, true);
      case 'uchar': case 'uint8': return dv.getUint8(o);
      case 'char': case 'int8': return dv.getInt8(o);
      case 'short': case 'int16': return dv.getInt16(o, true);
      case 'ushort': case 'uint16': return dv.getUint16(o, true);
      case 'int': case 'int32': return dv.getInt32(o, true);
      default: return dv.getUint32(o, true);
    }
  };
  const col = (name, i, d) => off[name] ? rd(off[name], i) : d;
  const hasRest = props.some(p => p.name.startsWith('f_rest_'));
  const hasDC = !!off.f_dc_0;

  // 色の入れ方を見分ける：ふつうは「SH」という形（マイナスの値もある）。LAM の頭部は 0〜1 の色そのもの
  let rgbMode = false;
  if (hasDC && !hasRest){
    let outside = 0;
    const step = Math.max(1, Math.floor(n / 5000));
    let seen = 0;
    for (let i = 0; i < n; i += step){
      seen++;
      for (const c of ['f_dc_0', 'f_dc_1', 'f_dc_2']){
        const v = rd(off[c], i);
        if (v < -0.02 || v > 1.02) outside++;
      }
    }
    rgbMode = outside / (seen * 3) < 0.01;
  }

  const P = new Float32Array(n * 3), S = new Float32Array(n * 6), C = new Uint8Array(n * 4);
  let m = 0;
  const C0 = 0.28209479177387814;
  for (let i = 0; i < n; i++){
    const op = off.opacity ? 1 / (1 + Math.exp(-rd(off.opacity, i))) : 1;
    if (op < 0.01) continue;                      // ほとんど透明な玉は捨てる（軽くなる）
    let r, g, b;
    if (hasDC){
      r = rd(off.f_dc_0, i); g = rd(off.f_dc_1, i); b = rd(off.f_dc_2, i);
      if (!rgbMode){ r = 0.5 + C0 * r; g = 0.5 + C0 * g; b = 0.5 + C0 * b; }
    } else {
      r = col('red', i, 200) / 255; g = col('green', i, 200) / 255; b = col('blue', i, 200) / 255;
    }
    const sx = off.scale_0 ? Math.exp(rd(off.scale_0, i)) : 0.005;
    const sy = off.scale_1 ? Math.exp(rd(off.scale_1, i)) : sx;
    const sz = off.scale_2 ? Math.exp(rd(off.scale_2, i)) : sx;
    let qw = col('rot_0', i, 1), qx = col('rot_1', i, 0), qy = col('rot_2', i, 0), qz = col('rot_3', i, 0);
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    // 玉の形（共分散）＝ 回転 × 大きさ² × 回転の逆
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
    const a = sx * sx, bb = sy * sy, c = sz * sz;
    P[m * 3] = rd(off.x, i); P[m * 3 + 1] = rd(off.y, i); P[m * 3 + 2] = rd(off.z, i);
    S[m * 6]     = r00 * r00 * a + r01 * r01 * bb + r02 * r02 * c;
    S[m * 6 + 1] = r00 * r10 * a + r01 * r11 * bb + r02 * r12 * c;
    S[m * 6 + 2] = r00 * r20 * a + r01 * r21 * bb + r02 * r22 * c;
    S[m * 6 + 3] = r10 * r10 * a + r11 * r11 * bb + r12 * r12 * c;
    S[m * 6 + 4] = r10 * r20 * a + r11 * r21 * bb + r12 * r22 * c;
    S[m * 6 + 5] = r20 * r20 * a + r21 * r21 * bb + r22 * r22 * c;
    const cl = v => Math.max(0, Math.min(255, Math.round(v * 255)));
    C[m * 4] = cl(r); C[m * 4 + 1] = cl(g); C[m * 4 + 2] = cl(b); C[m * 4 + 3] = cl(op);
    m++;
  }
  return capSplats({ n: m, P: P.subarray(0, m * 3), S: S.subarray(0, m * 6), C: C.subarray(0, m * 4), rgbMode, total: n });
}

// 玉が多すぎると Quest では重いので、目立たない玉（薄くて小さいもの）から減らす
const MAX_SPLATS = 250000;
function capSplats(d){
  if (d.n <= MAX_SPLATS) return d;
  const { n, P, S, C } = d;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) score[i] = C[i * 4 + 3] * Math.sqrt(S[i * 6] + S[i * 6 + 3] + S[i * 6 + 5]);
  const keep = Array.from({ length: n }, (_, i) => i).sort((a, b) => score[b] - score[a]).slice(0, MAX_SPLATS).sort((a, b) => a - b);
  const m = keep.length, P2 = new Float32Array(m * 3), S2 = new Float32Array(m * 6), C2 = new Uint8Array(m * 4);
  keep.forEach((i, j) => {
    P2.set(P.subarray(i * 3, i * 3 + 3), j * 3);
    S2.set(S.subarray(i * 6, i * 6 + 6), j * 6);
    C2.set(C.subarray(i * 4, i * 4 + 4), j * 4);
  });
  return { ...d, n: m, P: P2, S: S2, C: C2, reduced: n };
}

// =====================================================================
// 向き・大きさをそろえる：上を +Y、足元を高さ 0、体の真ん中を原点に
// =====================================================================
function percentile(arr, stride, k, q){
  const n = arr.length / stride, step = Math.max(1, Math.floor(n / 20000)), s = [];
  for (let i = 0; i < n; i += step) s.push(arr[i * stride + k]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function normalize(d){
  const { P, S, n } = d;
  let lo = percentile(P, 3, 1, 0.003), hi = percentile(P, 3, 1, 0.997);
  let h = hi - lo;
  // 全身（1m以上）なら、腰から足先の方が頭までより長いので、長い側を下にする（LHM++ は上下さかさまで出ることがある）
  let flip = false;
  if (h > 1.0){
    const mid = percentile(P, 3, 1, 0.5);
    flip = (mid - lo) < (hi - mid);
  }
  if (flip){
    // X軸まわりに180°回す：y,z の符号が変わる
    for (let i = 0; i < n; i++){
      P[i * 3 + 1] = -P[i * 3 + 1]; P[i * 3 + 2] = -P[i * 3 + 2];
      S[i * 6 + 1] = -S[i * 6 + 1]; S[i * 6 + 2] = -S[i * 6 + 2];
    }
    [lo, hi] = [-hi, -lo];
  }
  // 大きさ：おかしな大きさ（10cm未満・2.5m超）なら身長 1.6m に。それ以外は作ったときの実寸のまま
  let s = 1;
  if (h < 0.1 || h > 2.5) s = 1.6 / h;
  const cx = (percentile(P, 3, 0, 0.02) + percentile(P, 3, 0, 0.98)) / 2;
  const cz = (percentile(P, 3, 2, 0.02) + percentile(P, 3, 2, 0.98)) / 2;
  for (let i = 0; i < n; i++){
    P[i * 3] = (P[i * 3] - cx) * s;
    P[i * 3 + 1] = (P[i * 3 + 1] - lo) * s;
    P[i * 3 + 2] = (P[i * 3 + 2] - cz) * s;
  }
  if (s !== 1) for (let i = 0; i < n * 6; i++) S[i] *= s * s;
  h *= s;
  const wx = (percentile(P, 3, 0, 0.98) - percentile(P, 3, 0, 0.02));
  const wz = (percentile(P, 3, 2, 0.98) - percentile(P, 3, 2, 0.02));
  return { h, wx: Math.max(0.1, wx), wz: Math.max(0.1, wz), head: h < 0.6 };
}

// =====================================================================
// 描き方（シェーダー）：玉を、見ている方向から見た楕円にして、ふちに向かってぼかしながら重ねる
// =====================================================================
const TW = 2048;   // データを入れる画像の横幅
const VERT = `
uniform highp sampler2D uData;
uniform highp sampler2D uColor;
uniform vec2 uViewport;
attribute float splatIndex;
varying vec4 vColor;
varying vec2 vPos;
ivec2 at(int k){ return ivec2(k % ${TW}, k / ${TW}); }
void main(){
  int i = int(splatIndex + 0.5);
  vec4 t0 = texelFetch(uData, at(i * 3), 0);
  vec4 t1 = texelFetch(uData, at(i * 3 + 1), 0);
  vec4 t2 = texelFetch(uData, at(i * 3 + 2), 0);
  vec4 cam = modelViewMatrix * vec4(t0.xyz, 1.0);
  vec4 clip = projectionMatrix * cam;
  float lim = 1.2 * clip.w;
  if (cam.z > -0.01 || clip.x < -lim || clip.x > lim || clip.y < -lim || clip.y > lim){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
  }
  mat3 V = mat3(t0.w, t1.x, t1.y,  t1.x, t1.z, t1.w,  t1.y, t1.w, t2.x);
  vec2 f = vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * uViewport * 0.5;
  mat3 J = mat3(f.x / cam.z, 0.0, -(f.x * cam.x) / (cam.z * cam.z),
                0.0, f.y / cam.z, -(f.y * cam.y) / (cam.z * cam.z),
                0.0, 0.0, 0.0);
  mat3 T = transpose(mat3(modelViewMatrix)) * J;
  mat3 c2 = transpose(T) * V * T;
  float a = c2[0][0] + 0.3, b = c2[0][1], d = c2[1][1] + 0.3;
  float mid = 0.5 * (a + d), rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad, l2 = mid - rad;
  if (l2 <= 0.0){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 e1 = normalize(vec2(b, l1 - a));
  if (abs(b) < 1e-9) e1 = a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 ax1 = min(sqrt(l1), 512.0) * e1;
  vec2 ax2 = min(sqrt(l2), 512.0) * vec2(e1.y, -e1.x);
  vColor = texelFetch(uColor, at(i), 0);
  vPos = position.xy;
  vec2 ndc = clip.xy / clip.w + (position.x * ax1 + position.y * ax2) * 2.0 / uViewport;
  gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
}`;
const FRAG = `
varying vec4 vColor;
varying vec2 vPos;
void main(){
  float r = dot(vPos, vPos);
  if (r > 9.0) discard;
  float a = exp(-0.5 * r) * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

// 重ねる順番を並べ替える係（別の作業係で動かすので、描画は止まらない）
const SORTER = `
let pos = null, n = 0, depth = null, key = null;
onmessage = e => {
  const d = e.data;
  if (d.pos){ pos = d.pos; n = pos.length / 3; depth = new Float32Array(n); key = new Uint16Array(n); return; }
  const [a, b, c, w] = d.row;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++){
    const z = a * pos[i*3] + b * pos[i*3+1] + c * pos[i*3+2] + w;
    depth[i] = z;
    if (z < mn) mn = z;
    if (z > mx) mx = z;
  }
  const B = 65536, k = (B - 1) / (mx - mn || 1);
  const cnt = new Uint32Array(B);
  for (let i = 0; i < n; i++){ const q = ((depth[i] - mn) * k) | 0; key[i] = q; cnt[q]++; }
  let s = 0;
  for (let j = 0; j < B; j++){ const t = cnt[j]; cnt[j] = s; s += t; }
  const out = d.buf && d.buf.length === n ? d.buf : new Float32Array(n);
  for (let i = 0; i < n; i++) out[cnt[key[i]]++] = i;   // 遠い（z が小さい）ものから順に
  postMessage({ order: out, id: d.id }, [out.buffer]);
};`;
const sorterURL = URL.createObjectURL(new Blob([SORTER], { type: 'text/javascript' }));

const _mv = new THREE.Matrix4(), _vp = new THREE.Vector2();

function makeSplatMesh(d){
  const { n, P, S, C } = d;
  const rows = Math.ceil(n * 3 / TW);
  const data = new Float32Array(TW * rows * 4);
  for (let i = 0; i < n; i++){
    const o = i * 12;
    data[o] = P[i*3]; data[o+1] = P[i*3+1]; data[o+2] = P[i*3+2]; data[o+3] = S[i*6];
    data[o+4] = S[i*6+1]; data[o+5] = S[i*6+2]; data[o+6] = S[i*6+3]; data[o+7] = S[i*6+4];
    data[o+8] = S[i*6+5];
  }
  const dataTex = new THREE.DataTexture(data, TW, rows, THREE.RGBAFormat, THREE.FloatType);
  dataTex.minFilter = dataTex.magFilter = THREE.NearestFilter;
  dataTex.generateMipmaps = false;
  dataTex.needsUpdate = true;
  const crows = Math.ceil(n / TW);
  const cdata = new Uint8Array(TW * crows * 4);
  cdata.set(C);
  const colTex = new THREE.DataTexture(cdata, TW, crows, THREE.RGBAFormat, THREE.UnsignedByteType);
  colTex.minFilter = colTex.magFilter = THREE.NearestFilter;
  colTex.generateMipmaps = false;
  colTex.needsUpdate = true;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const order = new Float32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const idx = new THREE.InstancedBufferAttribute(order, 1);
  idx.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('splatIndex', idx);
  geo.instanceCount = n;

  const mat = new THREE.ShaderMaterial({
    uniforms: { uData: { value: dataTex }, uColor: { value: colTex }, uViewport: { value: new THREE.Vector2(1000, 1000) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,   // 楕円の向き次第で四角が裏返るので、裏向きも描く（片面だと消えてしまう）
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.raycast = () => {};          // つかむのは外側の見えない箱で
  mesh.renderOrder = 1;

  // 並べ替え係
  const worker = new Worker(sorterURL);
  worker.postMessage({ pos: new Float32Array(P) });
  let busy = false, spare = null, sortId = 0;
  worker.onmessage = e => {
    busy = false;
    // 受け取った並びをそのまま使い、古い方は次の並べ替えに回す（写し替えの手間をなくす）
    spare = idx.array;
    idx.array = e.data.order;
    idx.needsUpdate = true;
  };
  let lastFrame = -1, lastSortT = 0;
  const lastCam = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), nowCam = new THREE.Vector3(), nowDir = new THREE.Vector3();
  mesh.onBeforeRender = (r, sc, cam) => {
    // 見ている目の画面の大きさ（VRでは片目ぶん）
    if (cam.viewport) _vp.set(cam.viewport.z, cam.viewport.w);
    else r.getDrawingBufferSize(_vp);
    mat.uniforms.uViewport.value.copy(_vp);
    mat.uniformsNeedUpdate = true;
    // 1フレームに1回、見る位置が変わっていたら並べ替えを頼む
    //   頭はいつも少し揺れているので、3cm以上動いたか 3°以上向きが変わったときだけ。間隔も 0.1秒以上あける
    const f = r.info.render.frame;
    if (f === lastFrame || busy) return;
    lastFrame = f;
    const now = performance.now();
    if (now - lastSortT < 100) return;
    _mv.multiplyMatrices(cam.matrixWorldInverse, mesh.matrixWorld);
    const e = _mv.elements;
    nowCam.setFromMatrixPosition(cam.matrixWorld);
    mesh.worldToLocal(nowCam);
    nowDir.set(e[2], e[6], e[10]).normalize();
    if (nowCam.distanceTo(lastCam) < 0.03 && nowDir.dot(lastDir) > 0.9986) return;
    lastCam.copy(nowCam); lastDir.copy(nowDir); lastSortT = now;
    const row = [e[2], e[6], e[10], e[14]];
    busy = true;
    const msg = { row, id: ++sortId };
    if (spare){ msg.buf = spare; worker.postMessage(msg, [spare.buffer]); spare = null; }
    else worker.postMessage(msg);
  };
  mesh.userData.dispose = () => {
    worker.terminate();
    geo.dispose(); mat.dispose(); dataTex.dispose(); colTex.dispose();
  };
  return mesh;
}

// =====================================================================
// 部屋に置く：見えない箱（つかむ・吸い付き用）の中に、立体人物を入れる
// =====================================================================
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

function buildPerson(d, info, rec){
  const L = info;
  const box = new THREE.BoxGeometry(L.wx, L.h, L.wz);
  box.translate(0, L.h / 2, 0);
  const root = new THREE.Mesh(box, hitMat);
  const sp = makeSplatMesh(d);
  root.add(sp);
  Object.assign(root.userData, {
    splat: sp, h: L.h, head: L.head, flipped: false,
    // 吸い付き（planes.js）用：足元は原点。全身なら床に立たせる
    layout: { fullBody: !L.head, cx: 0, bottom: 0, top: L.h, width: L.wx },
  });
  if (rec){
    root.userData.id = rec.id;
    root.userData.rel = rec.rel;   // storage.js が部屋の目印に合わせて置き直すのに使う
    if (rec.flipped) setFlip(root, true);
    if (rec.rel) new THREE.Matrix4().fromArray(rec.rel).decompose(root.position, root.quaternion, root.scale);
    root.userData.saveKey = keyOf(root);
  } else {
    placeInFront(root);
  }
  scene.add(root);
  people.push(root);
  A.drawPanel && A.drawPanel();
  return root;
}

// 自分の 1.5m 前に、こちらを向けて置く（全身は床に立たせ、頭部は顔の高さに）
const cp = new THREE.Vector3(), cf = new THREE.Vector3();
function placeInFront(root){
  camera.getWorldPosition(cp);
  camera.getWorldDirection(cf);
  if (!renderer.xr.isPresenting){ cp.set(0, 1.5, 0); cf.set(0, 0, -1); }
  cf.y = 0;
  if (cf.lengthSq() < 1e-4) cf.set(0, 0, -1);
  cf.normalize();
  // 何人目かで、少しずつ横にずらす
  const k = people.length, side = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.7;
  const x = cp.x + cf.x * 1.5 - cf.z * side, z = cp.z + cf.z * 1.5 + cf.x * side;
  const floor = A.floorY !== null ? A.floorY : 0;
  const y = root.userData.head ? cp.y - 0.15 - root.userData.h / 2 : floor;
  root.position.set(x, y, z);
  root.lookAt(cp.x, y, cp.z);
}

// 上下さかさまを直す（X軸まわりに180°。体の高さの真ん中を中心に回す）
function setFlip(root, on){
  const u = root.userData, sp = u.splat;
  u.flipped = on;
  sp.rotation.set(on ? Math.PI : 0, 0, 0);
  sp.position.set(0, on ? u.h : 0, 0);
}
const origSetCut = A.setCut;
A.setCut = (m, on) => {
  if (m.userData.splat){ setFlip(m, !m.userData.flipped); return; }   // 人物は A・X で上下反転
  origSetCut(m, on);
};

A.disposePerson = m => {
  m.parent && m.parent.remove(m);
  m.userData.splat.userData.dispose();
  m.geometry.dispose();
  const i = people.indexOf(m);
  if (i >= 0) people.splice(i, 1);
  A.drawPanel && A.drawPanel();
};

// =====================================================================
// 読み込み・保存・復元
// =====================================================================
const keyOf = m => {
  const M = new THREE.Matrix4().compose(m.position, m.quaternion, m.scale);
  return M.elements.map(v => v.toFixed(3)).join(',') + (m.userData.flipped ? 'f' : '');
};

async function loadPly(file, label){
  status.textContent = `${label}：立体人物を読み込み中…`;
  const buf = await file.arrayBuffer();
  const d = parsePly(buf);
  if (!d.n) throw new Error('見える点がありませんでした');
  const info = normalize(d);
  A.note(`${label}：${file.name}（${d.n.toLocaleString()} 個の玉${d.reduced ? `（${d.reduced.toLocaleString()} 個から軽くしました）` : ''}・高さ ${(info.h * 100).toFixed(0)}cm・色 ${d.rgbMode ? 'そのまま' : 'SH'}${info.head ? '・頭部' : ''}）`);
  const root = buildPerson(d, info, null);
  root.userData.id = 's' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const rec = { id: root.userData.id, name: file.name, ply: new Blob([buf]), flipped: false,
                rel: A.relOf ? A.relOf(root) : null, time: Date.now() };
  root.userData.rel = rec.rel;
  root.userData.saveKey = keyOf(root);
  pPut(rec).catch(e => showErr('立体人物を保存できませんでした：' + (e.message || e)));
  known.add(rec.id);
}

$('plys').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  for (let i = 0; i < files.length; i++){
    const label = `立体人物 ${i + 1} 人目`;
    try { await loadPly(files[i], label); }
    catch (err){ showErr(`${label}（${files[i].name}）で失敗：${err && err.message ? err.message : err}`); }
  }
  if (files.length) status.textContent = `立体人物 ${people.length} 人。START AR を押すと、自分の前に立っています。`;
  e.target.value = '';
});

// 動かした・反転した・消したら保存（2秒ごとに確認）
const known = new Set();
setInterval(async () => {
  if (!A.relOf || !A.canSaveRel) return;
  const can = A.canSaveRel();
  for (const m of people){
    const u = m.userData;
    if (!u.id || m.parent !== scene || !can) continue;   // つかんでいる間は保存しない
    const k = keyOf(m);
    if (k === u.saveKey) continue;
    u.saveKey = k;
    try {
      const rec = await pGet(u.id);
      if (!rec) continue;
      rec.rel = A.relOf(m); rec.flipped = !!u.flipped;
      u.rel = rec.rel;
      await pPut(rec);
    } catch (e) {}
  }
  const ids = new Set(people.map(m => m.userData.id));
  for (const id of known) if (!ids.has(id)){ known.delete(id); pDel(id).catch(() => {}); }
}, 2000);

// ページを開いたら、保存してある立体人物を戻す
(async () => {
  let recs = [];
  try { recs = await pAll(); } catch (e) { return; }
  if (!recs.length) return;
  recs.sort((a, b) => a.time - b.time);
  for (const r of recs){
    try {
      const d = parsePly(await r.ply.arrayBuffer());
      const info = normalize(d);
      buildPerson(d, info, r);
      known.add(r.id);
    } catch (e) { showErr('戻せない立体人物がありました：' + (e.message || e)); }
  }
  A.note(`保存から立体人物 ${people.length} 人を戻しました`);
})();
