# lhm_sym.py — 立体人物（.ply）の色を、左右の片側から反対側へ写して、左右対称にする
#   横向きの写真から作ると、写っていない側の色がおかしくなる。体はほぼ左右対称なので、
#   よく写っている側の色を、鏡に映した位置の反対側へ写す（形はそのまま、色だけ変える）
#   どちらの側が良いかは見て選べるように、A（片側を基準）と B（反対側を基準）の2つを作る
#   使い方：python lhm_sym.py 入力.ply 出力A.ply 出力B.ply
import sys
import numpy as np
from scipy.spatial import cKDTree

TYPES = {'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8', 'uchar': 'u1', 'uint8': 'u1',
         'char': 'i1', 'int8': 'i1', 'short': 'i2', 'int16': 'i2', 'ushort': 'u2', 'uint16': 'u2',
         'int': 'i4', 'int32': 'i4', 'uint': 'u4', 'uint32': 'u4'}


def read_ply(path):
    raw = open(path, 'rb').read()
    k = raw.index(b'end_header')
    start = raw.index(b'\n', k) + 1
    header = raw[:start].decode('ascii', 'replace')
    props, n, inv = [], 0, False
    for line in header.splitlines():
        t = line.split()
        if not t:
            continue
        if t[0] == 'element':
            inv = t[1] == 'vertex'
            if inv:
                n = int(t[2])
        elif t[0] == 'property' and inv:
            props.append((t[2], '<' + TYPES[t[1]]))
    dt = np.dtype(props)
    v = np.frombuffer(raw, dtype=dt, count=n, offset=start).copy()
    return header, v, raw[start + n * dt.itemsize:]


def write_ply(path, header, v, tail):
    with open(path, 'wb') as f:
        f.write(header.encode('ascii'))
        f.write(v.tobytes())
        f.write(tail)


src, out_a, out_b = sys.argv[1:4]
header, v, tail = read_ply(src)
names = v.dtype.names
xyz = np.stack([v['x'], v['y'], v['z']], 1).astype(np.float64)
op = 1 / (1 + np.exp(-v['opacity'].astype(np.float64))) if 'opacity' in names else np.ones(len(v))
cnames = [c for c in names if c.startswith('f_dc_') or c.startswith('f_rest_')]
cols = np.stack([v[c] for c in cnames], 1).astype(np.float64)

# 左右の向き：T字ポーズは腕を横に広げているので、横（x と z のうち幅の広い方）が左右
lo, hi = np.percentile(xyz, 2, 0), np.percentile(xyz, 98, 0)
ext = hi - lo
ax = 0 if ext[0] >= ext[2] else 2
c = (lo[ax] + hi[ax]) / 2                         # 体の真ん中（両手の先のちょうど中間）
d = xyz[:, ax] - c
size = ext[1] if ext[1] > 0 else 1.0
SEAM = 0.015 * size                               # 真ん中のつなぎ目をなじませる幅（身長の1.5%）
FAR = 0.04 * size                                 # 鏡の位置にこれ以上近い玉がなければ、元の色のまま
print(f'{len(v)} 個の玉・左右は {"xyz"[ax]} 方向・真ん中 {c:.3f}')

for sign, out in ((1, out_a), (-1, out_b)):
    s = d * sign
    base = np.where((s > 0) & (op > 0.05))[0]          # 基準にする側（色をもらう側）
    tgt = np.where(s < SEAM)[0]                        # 色を写す側（＋つなぎ目の少し手前から）
    q = xyz[tgt].copy()
    q[:, ax] = 2 * c - q[:, ax]                        # 鏡に映した位置
    tree = cKDTree(xyz[base])
    dist, idx = tree.query(q, k=4)
    w = 1 / (dist + 1e-4)
    w /= w.sum(1, keepdims=True)
    newc = (cols[base][idx] * w[..., None]).sum(1)
    # つなぎ目は少しずつ切り替える（基準側に近いほど元の色、反対側に入るほど写した色）
    t = np.clip((SEAM - s[tgt]) / (2 * SEAM), 0, 1)
    t[dist[:, 0] > FAR] = 0
    out_cols = cols.copy()
    out_cols[tgt] = (1 - t[:, None]) * cols[tgt] + t[:, None] * newc
    nv = v.copy()
    for j, name in enumerate(cnames):
        nv[name] = out_cols[:, j].astype(nv[name].dtype)
    write_ply(out, header, nv, tail)
    print(f'{"A" if sign > 0 else "B"}：{int((t > 0).sum())} 個の玉の色を写しました → {out}')
