// face.js — 写真の中の顔を見つけて、「一番大きい顔」が実物大になるように人の大きさを決める
//   顔の大きさは大人も子どももあまり変わらないので、子どもは自然に小さく、大人は大きくなる。
//   顔が見つからない写真は、今まで通り（全身1.6m・上半身0.9m）のまま。
const A = window.APP;
const { photos } = A;

const FACE_M = 0.16;        // 顔の枠（眉の上〜あご）の実物の高さ（m）
const MAX_PERSON = 1.95;    // これより大きくはしない（m）
const MIN_PERSON = 0.3;     // これより小さくはしない（m）
const VER = '0.10.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detectorP = null;
function getDetector(){
  if (!detectorP){
    detectorP = (async () => {
      const { FaceDetector, FilesetResolver } = await import(`${BASE}/vision_bundle.mjs`);
      const fs = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      const det = await FaceDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
      A.note('顔を見つけるAIの準備ができました');
      return det;
    })().catch(e => {
      A.note('顔を見つけるAIが使えません（今まで通りの大きさにします）：' + (e.message || e));
      return null;
    });
  }
  return detectorP;
}

// 顔を見つけるのは1枚ずつ順番に
let queue = Promise.resolve();
let rearrangeTimer = 0;

async function fitByFace(m){
  const det = await getDetector();
  if (!det || !photos.includes(m)) return;
  const img = m.material.uniforms.map.value.image;   // 写真のcanvas
  let res;
  try { res = det.detect(img); } catch (e) { A.note('顔の検出に失敗：' + (e.message || e)); return; }
  const faces = (res && res.detections) || [];
  if (!faces.length){ A.note('顔が見つからない写真がありました（今まで通りの大きさ）'); return; }

  // 一番大きい顔
  let best = faces[0].boundingBox;
  for (const f of faces){
    const b = f.boundingBox;
    if (b.width * b.height > best.width * best.height) best = b;
  }

  const L = m.userData.layout;
  const h = 0.6;                                     // 写真の元の高さ（立体を作るときの単位）
  const faceLocal = best.height / img.height * h;    // 写真の中での顔の高さ
  let s = FACE_M / faceLocal;
  const personH = L.top - L.bottom;
  if (personH > 0){
    s = Math.min(s, MAX_PERSON / personH);
    s = Math.max(s, MIN_PERSON / personH);
  }
  const oldS = L.s;
  L.width = L.width / oldS * s;
  L.s = s;
  L.byFace = true;
  A.note(`顔に合わせて大きさを決めました（${faces.length}人中いちばん大きい顔、身長の目安 ${(s * personH).toFixed(2)}m）`);

  // 自動で並べたままなら、新しい大きさで並べ直す（自分で置いた写真は動かさない）
  if (A.autoArranged){
    clearTimeout(rearrangeTimer);
    rearrangeTimer = setTimeout(() => { if (A.autoArranged) A.arrangeAround(); }, 400);
  }
}

const origBuild = A.buildPhotoMesh;
A.buildPhotoMesh = d => {
  origBuild(d);
  const m = photos[photos.length - 1];
  if (!m) return;
  queue = queue.then(() => fitByFace(m)).catch(() => {});
};
