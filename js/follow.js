// follow.js — 写真が見ている人の方をゆっくり向く
//   ・回るのは横方向（縦の軸まわり）だけ。傾けて置いた写真は回らない
//   ・壁・床・天井に貼り付けた写真は回らない（つかみ直すと解除）
//   ・置いた向き（baseQ）は別に覚えておき、保存にはそちらを使う
import * as THREE from 'three';

const A = window.APP;
const { photos, settings, camera, renderer } = A;

const camP = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
const qYaw = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const EASE = 0.12;   // 1フレームでどれくらい追いつくか（小さいほどゆっくり）

// 壁・床・天井に貼り付けたら、回らないようにする
const origSnap = A.applySnap;
A.applySnap = (m, s) => {
  origSnap(m, s);
  m.userData.pinned = s.type === 'flat';
};

function update(){
  const f = settings.follow || 0;
  camera.getWorldPosition(camP);
  for (const m of photos){
    const u = m.userData;
    if (m.parent !== A.scene){            // つかんでいる間は何もしない
      u.baseQ = null; u.pinned = false; u.yawOff = 0;
      continue;
    }
    // ほかの処理（並べ直し・吸い付き・復元）で向きが変わったら、それを新しい「置いた向き」にする
    if (!u.baseQ || !u.lastQ || m.quaternion.angleTo(u.lastQ) > 1e-4){
      u.baseQ = m.quaternion.clone();
      u.yawOff = 0;
    }
    let target = 0;
    up.set(0, 1, 0).applyQuaternion(u.baseQ);
    if (f > 0 && !u.pinned && up.y > 0.9){
      fwd.set(0, 0, 1).applyQuaternion(u.baseQ);
      const baseYaw = Math.atan2(fwd.x, fwd.z);
      m.getWorldPosition(pos);
      const camYaw = Math.atan2(camP.x - pos.x, camP.z - pos.z);
      target = wrap(camYaw - baseYaw) * f;
    }
    const next = u.yawOff + wrap(target - u.yawOff) * EASE;
    if (Math.abs(next - u.yawOff) > 1e-5){
      u.yawOff = next;
      qYaw.setFromAxisAngle(Y, u.yawOff);
      m.quaternion.copy(qYaw).multiply(u.baseQ);
    }
    u.lastQ = m.quaternion.clone();
  }
}

// 毎フレーム、描く直前に向きを更新する
const origRender = renderer.render.bind(renderer);
renderer.render = (scene, cam) => { update(); origRender(scene, cam); };
