// planes.js — Questがスキャンした部屋の床・壁・天井を使って、写真を吸い付かせる
import * as THREE from 'three';

const A = window.APP;
const { settings, camera, renderer } = A;
const planes = A.planes;
const UP = new THREE.Vector3(0, 1, 0);
const SNAP = 0.3;   // この距離（m）より近いと吸い付く
const camP = new THREE.Vector3();

// =====================================================================
// 面の情報を更新（数十フレームに1回）
// =====================================================================
let lastCount = -1;
A.updatePlanes = frame => {
  if (!frame || !frame.detectedPlanes) return;
  const ref = renderer.xr.getReferenceSpace();
  if (!ref) return;
  camera.getWorldPosition(camP);
  planes.length = 0;
  let labeledFloor = null, lowestUp = null;

  frame.detectedPlanes.forEach(p => {
    const pose = frame.getPose(p.planeSpace, ref);
    if (!pose) return;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const point = new THREE.Vector3().setFromMatrixPosition(m);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(m);
    // 面の向きは、自分（部屋の内側）を向くようにそろえる
    if (normal.dot(camP.clone().sub(point)) < 0) normal.negate();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of p.polygon){
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    const label = (p.semanticLabel || '').toLowerCase();
    let kind;
    if (label === 'floor') kind = 'floor';
    else if (label === 'ceiling') kind = 'ceiling';
    else if (p.orientation === 'vertical' || Math.abs(normal.y) < 0.5) kind = 'wall';
    else kind = normal.y > 0 ? 'floor' : 'ceiling';   // 机などの上向きの面も「のせられる面」

    planes.push({ inv: m.clone().invert(), point, normal, kind, label, minX, maxX, minZ, maxZ });
    if (label === 'floor') labeledFloor = labeledFloor === null ? point.y : Math.min(labeledFloor, point.y);
    if (kind === 'floor') lowestUp = lowestUp === null ? point.y : Math.min(lowestUp, point.y);
  });

  const fy = labeledFloor !== null ? labeledFloor : lowestUp;
  if (fy !== null){
    const first = A.floorY === null;
    A.floorY = fy;
    // 初めて床が分かったら、自動で並べたままの写真は足を床に立たせ直す
    if (first && A.autoArranged) A.arrangeAround();
  }
  if (planes.length !== lastCount){
    lastCount = planes.length;
    A.note(planes.length ? `壁・床などを ${planes.length} 面 認識しました` :
      '壁・床を認識できません（Questの設定で部屋のスキャン＝スペース設定が必要です）');
    A.drawPanel();
  }
};

// =====================================================================
// 吸い付き
// =====================================================================
const _q = new THREE.Quaternion();
function axes(m){
  m.updateMatrixWorld(true);
  m.getWorldQuaternion(_q);
  return {
    n:  new THREE.Vector3(0, 0, 1).applyQuaternion(_q),   // 写真の表が向いている方向
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(_q),   // 写真の上方向
  };
}

// 面からの距離（面の範囲から外れていたら Infinity）
function distTo(p, w, margin){
  const l = w.clone().applyMatrix4(p.inv);
  const inside = l.x >= p.minX - margin && l.x <= p.maxX + margin &&
                 l.z >= p.minZ - margin && l.z <= p.maxZ + margin;
  return inside ? Math.abs(l.y) : Infinity;
}

// 写真の表を n の方向に向ける（上方向はできるだけ upHint に合わせる）
function orient(m, n, upHint){
  const y = upHint.clone().addScaledVector(n, -upHint.dot(n));
  if (y.lengthSq() < 1e-4) y.set(0, 0, -1).addScaledVector(n, n.z);
  if (y.lengthSq() < 1e-4) y.set(1, 0, 0).addScaledVector(n, -n.x);
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, n).normalize();
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
}

// 今この写真を離したら、どこに吸い付くか（なければ null）
A.findSnap = m => {
  if (settings.snap !== 'on' || !planes.length) return null;
  const L = m.userData.layout;
  const { n, up } = axes(m);
  const c = m.getWorldPosition(new THREE.Vector3());
  let best = null, bestD = SNAP;

  // 1) 壁・床・天井に貼り付ける（写真の向きが面とだいたい同じとき）
  for (const p of planes){
    if (Math.abs(n.dot(p.normal)) < 0.6) continue;
    const d = distTo(p, c, 0.3);
    if (d < bestD){ bestD = d; best = { type: 'flat', p }; }
  }
  // 2) 全身の写真が立っていて、足が床や台の近くなら、足をのせて立たせる
  if (!best && L.fullBody && Math.abs(up.y) > 0.7){
    const feet = m.localToWorld(new THREE.Vector3(L.cx, L.bottom, 0));
    let bd = SNAP;
    for (const p of planes){
      if (p.kind !== 'floor') continue;
      const d = distTo(p, feet, 0.3);
      if (d < bd){ bd = d; best = { type: 'stand', p }; }
    }
  }
  return best;
};

// 吸い付かせる（写真は部屋に置かれた状態で呼ぶ）
A.applySnap = (m, s) => {
  const p = s.p;
  const { n, up } = axes(m);
  if (s.type === 'flat'){
    // 壁ならまっすぐ立てて、床・天井なら今の向きのまま、面にぴったり重ねる
    orient(m, p.normal, p.kind === 'wall' ? UP : up);
    const dist = m.position.clone().sub(p.point).dot(p.normal);
    m.position.addScaledVector(p.normal, -dist + 0.01);
  } else {
    // まっすぐ立たせて、足を面の高さに合わせる
    const hor = new THREE.Vector3(n.x, 0, n.z);
    if (hor.lengthSq() < 1e-4) hor.set(0, 0, 1);
    orient(m, hor.normalize(), UP);
    m.updateMatrixWorld(true);
    const L = m.userData.layout;
    const feet = m.localToWorld(new THREE.Vector3(L.cx, L.bottom, 0));
    m.position.y += p.point.y - feet.y;
  }
  m.updateMatrixWorld(true);
};
