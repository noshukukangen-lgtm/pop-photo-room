// photo.js — 写真の見た目（シェーダー）と立体の形
import * as THREE from 'three';

const A = window.APP;
const { $, settings, photos, scene } = A;

const VERT = `
varying vec2 vUv;
varying vec3 vWorld;
void main(){
  vUv = uv;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
uniform sampler2D map;
uniform sampler2D maskMap;
uniform sampler2D depthMap;
uniform float uCut, uThresh, uDepthCut, uRef, uOpacity, uShadow;
uniform vec3 uHand0, uHand1, uHandDir0, uHandDir1;
uniform float uHandR, uHandLen;
varying vec2 vUv;
varying vec3 vWorld;
// 手から前方へ伸びる楕円体の中で 1 未満になる値
float handShape(vec3 p, vec3 hand, vec3 dir){
  float a = max(uHandR, (uHandLen + uHandR) * 0.5);
  vec3 v = p - (hand + dir * (a - uHandR));
  float along = dot(v, dir);
  float perp = length(v - along * dir);
  return length(vec2(along / a, perp / uHandR));
}
void main(){
  if (uOpacity < 0.01) discard;
  vec4 c = texture2D(map, vUv);
  if (uCut > 0.5){
    float a = texture2D(maskMap, vUv).r;
    if (a < uThresh) discard;
    if (uDepthCut > 0.001){
      float d = texture2D(depthMap, vUv).r;
      if (d < uDepthCut * uRef) discard;
    }
  }
  vec3 col = uShadow > 0.5 ? vec3(0.0) : c.rgb;
  float alpha = (uShadow > 0.5 ? 0.55 : 1.0) * uOpacity;
  // 自分の手（コントローラー）の周りは透明にして、本物の手が見えるようにする
  if (uHandR > 0.001){
    float q = min(handShape(vWorld, uHand0, uHandDir0), handShape(vWorld, uHand1, uHandDir1));
    if (q < 1.0) discard;
    alpha *= smoothstep(1.0, 1.0 + 0.04 / uHandR, q);
  }
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}`;

// 手の位置はすべての写真で共通（毎フレーム更新）
A.FAR = new THREE.Vector3(9999, 9999, 9999);
const handU = A.handU = {
  uHand0: { value: A.FAR.clone() },
  uHand1: { value: A.FAR.clone() },
  uHandDir0: { value: new THREE.Vector3(0, 0, -1) },
  uHandDir1: { value: new THREE.Vector3(0, 0, -1) },
  uHandR: { value: settings.handHole },
  uHandLen: { value: settings.handLen },
};

function makeMaterial(tex, ref, shadow){
  return new THREE.ShaderMaterial({
    uniforms: {
      map:      { value: tex.photo },
      maskMap:  { value: tex.mask },
      depthMap: { value: tex.depth },
      uCut:     { value: 0 },
      uThresh:  { value: settings.thresh },
      uDepthCut:{ value: settings.depthCut },
      uRef:     { value: ref },
      uOpacity: { value: 1 },
      uShadow:  { value: shadow ? 1 : 0 },
      ...handU,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: !shadow,
    side: shadow ? THREE.BackSide : THREE.FrontSide,
  });
}

A.setCut = (mesh, on) => {
  mesh.userData.cut = on;
  mesh.material.uniforms.uCut.value = on ? 1 : 0;
  mesh.userData.back.material.uniforms.uCut.value = on ? 1 : 0;
};

// 奥行き（飛び出し量・凹凸・なめらかさ・ふくらみ）を形に反映
A.applyGeometry = mesh => {
  const u = mesh.userData;
  if (u.smoothR !== settings.smooth){
    u.P = A.smoothDepth(u.G, u.M, u.gw, u.gh, settings.smooth);
    u.smoothR = settings.smooth;
  }
  const { P, B, gw, gh, ref } = u;
  const geo = mesh.geometry, pos = geo.attributes.position, uv = geo.attributes.uv;
  const scale = settings.depth, relief = settings.relief, inflate = settings.inflate;
  for (let i = 0; i < pos.count; i++){
    const fx = uv.getX(i) * (gw-1), fy = (1 - uv.getY(i)) * (gh-1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0+1, gw-1), y1 = Math.min(y0+1, gh-1);
    const ax = fx - x0, ay = fy - y0;
    const d = P[y0*gw+x0]*(1-ax)*(1-ay) + P[y0*gw+x1]*ax*(1-ay) + P[y1*gw+x0]*(1-ax)*ay + P[y1*gw+x1]*ax*ay;
    const b = B[y0*gw+x0]*(1-ax)*(1-ay) + B[y0*gw+x1]*ax*(1-ay) + B[y1*gw+x0]*(1-ax)*ay + B[y1*gw+x1]*ax*ay;
    // 全体は ref の位置まで飛び出し、その周りの凹凸だけ relief 倍にする。さらに人物の厚みをふくらませる
    pos.setZ(i, scale * (ref + (d - ref) * relief) + inflate * b);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
};

// しきい値・後ろを削る・裏側 を反映
A.applyLook = () => {
  handU.uHandR.value = settings.handHole;
  handU.uHandLen.value = settings.handLen;
  for (const m of photos){
    for (const mat of [m.material, m.userData.back.material]){
      mat.uniforms.uThresh.value = settings.thresh;
      mat.uniforms.uDepthCut.value = settings.depthCut;
    }
    m.material.side = settings.back === 'show' ? THREE.DoubleSide : THREE.FrontSide;
    m.userData.back.visible = settings.back === 'shadow';
  }
};

// 読み込んだデータから、立体の写真を作って部屋に置く
A.buildPhotoMesh = d => {
  const { G, M, gw, gh, maskCanvas } = d;
  const aspect = d.width / d.height;
  const ref = A.medianMasked(G, M);

  // 奥行きテクスチャ（「人物の後ろを削る」用）
  const dd = new Uint8Array(gw*gh*4);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++){
    const v = Math.round(G[(gh-1-y)*gw + x] * 255), o = (y*gw + x) * 4;
    dd[o] = dd[o+1] = dd[o+2] = v; dd[o+3] = 255;
  }
  const depthTex = new THREE.DataTexture(dd, gw, gh, THREE.RGBAFormat);
  depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;

  const tex = { photo: A.toTexture(A.drawPhoto(d.src)), mask: A.toTexture(maskCanvas, false), depth: depthTex };

  const h = 0.6, w = h * aspect;
  const segX = aspect >= 1 ? 256 : Math.max(2, Math.round(256*aspect));
  const segY = aspect >= 1 ? Math.max(2, Math.round(256/aspect)) : 256;
  const geo = new THREE.PlaneGeometry(w, h, segX, segY);

  const mesh = new THREE.Mesh(geo, makeMaterial(tex, ref, false));
  const back = new THREE.Mesh(geo, makeMaterial(tex, ref, true));
  back.raycast = () => {};       // 裏の影はつかめないようにする
  mesh.add(back);
  const B = A.computeBulge(M, gw, gh, h);
  Object.assign(mesh.userData, { back, G, M, B, gw, gh, ref, smoothR: null, layout: A.personLayout(M, gw, gh, w, h) });

  A.applyGeometry(mesh);
  A.setCut(mesh, $('cutDefault').checked);

  scene.add(mesh);
  photos.push(mesh);
  A.arrangeAround();   // VRに入ったときにもう一度、自分の位置に合わせて並べ直す
  A.applyLook();
  A.drawPanel();
};
