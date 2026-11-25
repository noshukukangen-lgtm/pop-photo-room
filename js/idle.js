// idle.js — 写真の人が生きているように、ほんの少し動く
//   ・呼吸：約4秒ごとに、体の厚みがふくらんだりしぼんだりする（胸も少し上がる）
//   ・ゆらゆら：足元を支点に、左右にほんの少し揺れる
//   ・写真ごとにタイミングをずらすので、みんながばらばらに息をしているように見える
//   見た目だけを動かすので、置いた位置・向き・保存には影響しない
import * as THREE from 'three';

const A = window.APP;
const { photos, renderer } = A;

A.idleEnabled = true;
const BREATH_SEC = 4.2;     // 呼吸の周期（秒）
const BREATH_DEPTH = 0.03;  // 厚みの変化（3%）
const BREATH_RISE = 0.006;  // 胸の上がり（0.6%）
const SWAY_DEG = 0.6;       // 揺れの角度（度）

const t0 = performance.now();
const T = new THREE.Matrix4(), Ti = new THREE.Matrix4(), R = new THREE.Matrix4(), S = new THREE.Matrix4();

function idleMatrix(m){
  const u = m.userData, L = u.layout;
  if (u.phase === undefined) u.phase = Math.random() * 100;
  const t = (performance.now() - t0) / 1000 + u.phase;
  const br = Math.sin(t * 2 * Math.PI / BREATH_SEC);
  const sw = 0.6 * Math.sin(t * 2 * Math.PI / 7.3) + 0.4 * Math.sin(t * 2 * Math.PI / 11.1);
  const px = L ? L.cx : 0, py = L ? L.bottom : -0.3;   // 足元を支点に
  T.makeTranslation(px, py, 0);
  Ti.makeTranslation(-px, -py, 0);
  R.makeRotationZ(THREE.MathUtils.degToRad(SWAY_DEG) * sw);
  S.makeScale(1, 1 + BREATH_RISE * br, 1 + BREATH_DEPTH * br);
  return new THREE.Matrix4().copy(T).multiply(R).multiply(S).multiply(Ti);
}

// 描く直前だけ形を少し変えて、描き終わったら元に戻す（左右の目で2回呼ばれても大丈夫）
function hook(obj, owner){
  obj.onBeforeRender = () => {
    if (!A.idleEnabled) return;
    const im = idleMatrix(owner);
    obj.userData._im = im;
    obj.matrixWorld.multiply(im);
  };
  obj.onAfterRender = () => {
    const im = obj.userData._im;
    if (!im) return;
    obj.matrixWorld.multiply(im.invert());
    obj.userData._im = null;
  };
}

function attachAll(){
  for (const m of photos){
    if (m.userData.idleOn) continue;
    m.userData.idleOn = true;
    hook(m, m);
    if (m.userData.back) hook(m.userData.back, m);
  }
}

const origRender = renderer.render.bind(renderer);
renderer.render = (scene, cam) => { attachAll(); origRender(scene, cam); };
