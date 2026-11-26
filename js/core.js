// core.js — 設定・画面の部品・3Dの土台（ほかのファイルとは window.APP で共有）
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const A = window.APP = {};
const $ = A.$ = id => document.getElementById(id);
const status = A.status = $('status');

// 進み具合を画面に残す（うまくいかないとき、どこで止まったか分かるように）
const t00 = performance.now();
A.note = msg => {
  const el = $('log');
  el.textContent += `[${((performance.now() - t00) / 1000).toFixed(1)}s] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};
status.textContent = '写真を選んでください（何枚でもOK）。準備ができたら下の「START AR」を押します。';

// =====================================================================
// 調整できる項目（スマホの画面とVRのパネルの両方に出ます）
// =====================================================================
const PARAMS = A.PARAMS = [
  { key:'depth',    label:'飛び出し量',       min:0,    max:0.8,  step:0.02, def:0.25, geo:true,
    fmt:v => v.toFixed(2) },
  { key:'relief',   label:'凹凸の強さ',       min:0,    max:1.5,  step:0.05, def:0.5,  geo:true,
    fmt:v => Math.round(v*100) + '%' },
  { key:'smooth',   label:'なめらかさ',       min:0,    max:12,   step:1,    def:3,    geo:true,
    fmt:v => String(v) },
  { key:'inflate',  label:'ふくらみ（厚み）',  min:0,    max:1.5,  step:0.05, def:0.6,  geo:true,
    fmt:v => v <= 0 ? 'なし' : Math.round(v*100) + '%' },
  { key:'thresh',   label:'切り抜きのしきい値', min:0.05, max:0.95, step:0.05, def:0.5,
    fmt:v => v.toFixed(2) },
  { key:'depthCut', label:'人物の後ろを削る',  min:0,    max:1,    step:0.05, def:0,
    fmt:v => v <= 0 ? 'なし' : Math.round(v*100) + '%' },
  { key:'follow',   label:'こっちを向く',      min:0,    max:1,    step:0.1,  def:1,
    fmt:v => v <= 0 ? 'なし' : Math.round(v*100) + '%' },
  { key:'fade',     label:'斜めで薄く消す',    min:20,   max:90,   step:5,    def:60,
    fmt:v => v >= 90 ? 'なし' : v + '°〜' },
  { key:'handHole', label:'手の透明・太さ',    min:0,    max:0.3,  step:0.02, def:0.12,
    fmt:v => v <= 0 ? 'なし' : Math.round(v*100) + 'cm' },
  { key:'handLen',  label:'手の透明・前の長さ', min:0,    max:0.8,  step:0.05, def:0.35,
    fmt:v => Math.round(v*100) + 'cm' },
  { key:'back',     label:'裏側',            options:['hide','shadow','show'], def:'shadow',
    names:{ hide:'非表示', shadow:'影', show:'表示' } },
  { key:'snap',     label:'壁・床に吸い付く',  options:['on','off'], def:'on',
    names:{ on:'ON', off:'OFF' } },
];
const STORE_KEY = 'popPhotoSettings.v3';
A.RUN_KEY = 'popPhotoRunning';   // 切り抜き中に落ちたかどうかの目印
A.CUT_NAMES = { rmbg:'標準（RMBG）', modnet:'軽量（MODNet）' };
A.LIGHTER = { rmbg:'modnet', modnet:'modnet' };

const settings = A.settings = {};
for (const p of PARAMS) settings[p.key] = p.def;
let savedCutModel = null;
try {
  const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  for (const p of PARAMS) if (s[p.key] !== undefined) settings[p.key] = s[p.key];
  savedCutModel = s.cutModel || null;
} catch (e) {}
if (savedCutModel && A.CUT_NAMES[savedCutModel]) $('cutModel').value = savedCutModel;

// 前回、切り抜きの途中でブラウザが落ちていたら、ひとつ軽いAIに切り替える
let crashedKind = null;
try { crashedKind = localStorage.getItem(A.RUN_KEY); localStorage.removeItem(A.RUN_KEY); } catch (e) {}
if (crashedKind && A.CUT_NAMES[crashedKind]){
  const next = A.LIGHTER[crashedKind];
  $('cutModel').value = next;
  setTimeout(() => showErr(`前回「${A.CUT_NAMES[crashedKind]}」の処理中に止まったようなので、「${A.CUT_NAMES[next]}」に切り替えました。`), 0);
}

A.saveSettings = () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...settings, cutModel: $('cutModel').value })); } catch (e) {}
};
$('cutModel').addEventListener('change', A.saveSettings);

const roundStep = (p, v) => {
  v = Math.min(p.max, Math.max(p.min, v));
  const dec = (String(p.step).split('.')[1] || '').length;
  return parseFloat((Math.round((v - p.min) / p.step) * p.step + p.min).toFixed(dec));
};
A.paramValueText = p => p.options ? p.names[settings[p.key]] : p.fmt(settings[p.key]);

// スマホ画面のスライダーを作る
const tuneInputs = {};
for (const p of PARAMS){
  const lab = document.createElement('span'); lab.textContent = p.label;
  let input;
  if (p.options){
    input = document.createElement('select');
    for (const o of p.options){
      const op = document.createElement('option'); op.value = o; op.textContent = p.names[o]; input.appendChild(op);
    }
    input.addEventListener('change', () => A.setParam(p.key, input.value));
  } else {
    input = document.createElement('input');
    Object.assign(input, { type:'range', min:p.min, max:p.max, step:p.step });
    input.addEventListener('input', () => A.setParam(p.key, parseFloat(input.value)));
  }
  const val = document.createElement('span'); val.className = 'v';
  $('tune').append(lab, input, val);
  tuneInputs[p.key] = { input, val };
}
A.syncHtml = () => {
  for (const p of PARAMS){
    const t = tuneInputs[p.key];
    t.input.value = settings[p.key];
    t.val.textContent = A.paramValueText(p);
  }
};
$('resetTune').onclick = () => A.resetParams();

A.geoDirty = false;
A.setParam = (key, value) => {
  const p = PARAMS.find(q => q.key === key);
  settings[key] = p.options ? value : roundStep(p, value);
  A.saveSettings();
  A.syncHtml();
  A.drawPanel();
  if (p.geo) A.geoDirty = true;
  A.applyLook();
};
A.resetParams = () => {
  for (const p of PARAMS) settings[p.key] = p.def;
  A.saveSettings(); A.syncHtml(); A.drawPanel();
  A.geoDirty = true; A.applyLook();
};

// ===== プログレスバー =====
A.setBar = (box, fill, text, ratio, label) => {
  $(box).classList.remove('hidden');
  $(fill).style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
  $(text).textContent = label;
};
const dlFiles = {};
A.onDownloadProgress = p => {
  if (p.status === 'progress' && p.total){
    dlFiles[p.name + '/' + p.file] = { loaded:p.loaded, total:p.total };
    let loaded = 0, total = 0;
    for (const f of Object.values(dlFiles)){ loaded += f.loaded; total += f.total; }
    const mb = x => (x/1048576).toFixed(1);
    A.setBar('dlBox','dlFill','dlText', loaded/total,
      `AIをダウンロード中… ${Math.round(loaded/total*100)}%（${mb(loaded)} / ${mb(total)} MB）`);
  }
};

// =====================================================================
// 3Dの土台（高画質設定）
// =====================================================================
const scene = A.scene = new THREE.Scene();
A.camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.01, 50);
const renderer = A.renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(1.5);
renderer.xr.setFoveation(0);
document.body.appendChild(renderer.domElement);
// plane-detection：Questがスキャンした部屋の床・壁・天井を教えてもらう
document.body.appendChild(ARButton.createButton(renderer, { optionalFeatures:['local-floor', 'plane-detection'] }));

// 写真の表示に使う最大の細かさ。等身大の人を1m先で見るとき、Quest 3の画面で見分けられるのはおよそ2000ピクセル。
// これより大きくしても見た目はほとんど変わらず、メモリだけ食って、たくさん並べると読み込めなくなる
A.MAX_TEX = Math.min(renderer.capabilities.maxTextureSize, 2048);
A.MAX_MASK = 1536;   // 切り抜きの型紙の最大の細かさ
A.GRID = 512;        // 奥行き計算用の解像度（長辺）
A.ANISO = renderer.capabilities.getMaxAnisotropy();

A.photos = [];
A.twoHand = null;
A.allCut = $('cutDefault').checked;
A.arrangeWait = -1;
A.autoArranged = false;   // 自動で並べたままか（自分で動かしたら false）
A.floorY = null;          // 認識した床の高さ
A.planes = [];            // 認識した面（床・壁・天井など）
