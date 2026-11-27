# gs_preview.py — 3Dガウシアン（.ply）の立体人物・頭部を、ぐるっと一周回して見る動画にする
#   使い方：python gs_preview.py 入力.ply 出力.mp4 [上下 auto/0/1] [色 sh/rgb]
#     上下：auto＝全身用の自動判定、0＝そのまま（+Yが上）、1＝逆さまにする
#     色：sh＝ふつうの3Dガウシアン、rgb＝LAMの頭部（色をそのまま保存している）
import sys, math
import numpy as np
import torch
import imageio
from plyfile import PlyData
from gsplat import rasterization

src, out = sys.argv[1], sys.argv[2]
flip = sys.argv[3] if len(sys.argv) > 3 else 'auto'
cmode = sys.argv[4] if len(sys.argv) > 4 else 'sh'

v = PlyData.read(src)['vertex'].data
names = v.dtype.names
xyz = np.stack([v['x'], v['y'], v['z']], 1).astype(np.float32)
dc = np.stack([v['f_dc_0'], v['f_dc_1'], v['f_dc_2']], 1).astype(np.float32)
rest_names = sorted([n for n in names if n.startswith('f_rest_')], key=lambda s: int(s.split('_')[-1]))
deg = int(round(math.sqrt(len(rest_names) / 3 + 1))) - 1 if rest_names else 0
if cmode == 'rgb':
    rest_names, deg = [], None
    sh = np.clip(dc, 0, 1)
elif rest_names:
    rest = np.stack([v[n] for n in rest_names], 1).astype(np.float32).reshape(len(xyz), 3, -1).transpose(0, 2, 1)
    sh = np.concatenate([dc[:, None], rest], 1)
else:
    sh = dc[:, None]
op = 1 / (1 + np.exp(-v['opacity'].astype(np.float32)))
sc = np.exp(np.stack([v['scale_0'], v['scale_1'], v['scale_2']], 1).astype(np.float32))
q = np.stack([v['rot_0'], v['rot_1'], v['rot_2'], v['rot_3']], 1).astype(np.float32)
q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-8

# 上下の向き：体の中心（腰）から足先までの方が、頭までより長いので、長い側が下
c = np.median(xyz, 0)
y = xyz[:, 1] - c[1]
up_sign = 1.0
if flip == 'auto':
    up_sign = 1.0 if -y.min() > y.max() else -1.0
elif flip == '1':
    up_sign = -1.0
print(f'{len(xyz)} 個の点・色 {cmode}・上は {"+" if up_sign > 0 else "-"}Y')

dev = 'cuda'
T = lambda a: torch.from_numpy(np.ascontiguousarray(a)).to(dev)
means, quats, scales, opac, colors = T(xyz), T(q), T(sc), T(op), T(sh)
H = float(xyz[:, 1].max() - xyz[:, 1].min())
center = np.array([c[0], (xyz[:, 1].max() + xyz[:, 1].min()) / 2, c[2]], np.float32)
dist = H * 1.6
W_, H_ = 540, 720
f = H_ * 1.2
K = torch.tensor([[f, 0, W_ / 2], [0, f, H_ / 2], [0, 0, 1]], dtype=torch.float32, device=dev)[None]
up = np.array([0, up_sign, 0], np.float32)


def view(angle):
    eye = center + dist * np.array([math.sin(angle), 0, math.cos(angle)], np.float32)
    fwd = center - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, up)
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    M = np.eye(4, dtype=np.float32)
    M[:3, :3] = R
    M[:3, 3] = -R @ eye
    return torch.from_numpy(M).to(dev)[None]


frames = []
with torch.no_grad():
    for i in range(72):
        img, _, _ = rasterization(means, quats, scales, opac, colors, view(2 * math.pi * i / 72), K, W_, H_,
                                  sh_degree=deg, backgrounds=torch.ones(1, 3, device=dev) * 0.85)
        frames.append((img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
imageio.mimwrite(out, frames, fps=24, quality=8)
print('一周の動画：', out)
