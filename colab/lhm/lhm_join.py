# lhm_join.py — LHM++ の全身（顔は苦手）と、LAM の頭部（顔が得意）を、首でつないで1人にする
#   1. 全身の「首」を探す（T字ポーズの腕より上で、いちばん細いところ）。そこから上を消す
#   2. LAM の頭部の首（いちばん細いところ）を探し、大きさ・向き・位置を全身の首に合わせて置く
#   3. つなぎ目の色の差をなじませる（全身の首の色を、少しずつ頭部の首の色に寄せる）
#   使い方：python lhm_join.py 全身.ply 頭部.ply 出力.ply [scale=1] [up=0] [fwd=0] [turn=0] [cut=0]
#     scale：頭の大きさの倍率 ／ up：頭を上げる量（cm）／ fwd：頭を前に出す量（cm）／ turn：頭の向きを回す角度（度）
#     cut：全身の頭を消す高さを、さらに下げる量（cm）。元のあごや髪が残るときに使う
import sys, math
import numpy as np

C0 = 0.28209479177387814
TYPES = {'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8', 'uchar': 'u1', 'uint8': 'u1',
         'char': 'i1', 'int8': 'i1', 'short': 'i2', 'int16': 'i2', 'ushort': 'u2', 'uint16': 'u2',
         'int': 'i4', 'int32': 'i4', 'uint': 'u4', 'uint32': 'u4'}


def read_ply(path):
    raw = open(path, 'rb').read()
    k = raw.index(b'end_header')
    start = raw.index(b'\n', k) + 1
    props, n, inv = [], 0, False
    for line in raw[:start].decode('ascii', 'replace').splitlines():
        t = line.split()
        if not t:
            continue
        if t[0] == 'element':
            inv = t[1] == 'vertex'
            if inv:
                n = int(t[2])
        elif t[0] == 'property' and inv:
            props.append((t[2], '<' + TYPES[t[1]]))
    v = np.frombuffer(raw, dtype=np.dtype(props), count=n, offset=start)
    names = v.dtype.names
    g = lambda k, d=0.0: v[k].astype(np.float64) if k in names else np.full(n, d)
    xyz = np.stack([g('x'), g('y'), g('z')], 1)
    dc = np.stack([g('f_dc_0'), g('f_dc_1'), g('f_dc_2')], 1)
    has_rest = any(k.startswith('f_rest_') for k in names)
    # LAM の頭部は色を 0〜1 のまま入れている。ふつうの形（SH）にそろえる
    inside = ((dc >= -0.02) & (dc <= 1.02)).mean()
    rgb_mode = (not has_rest) and inside > 0.99
    if rgb_mode:
        dc = (np.clip(dc, 0, 1) - 0.5) / C0
    return {
        'xyz': xyz, 'dc': dc, 'op': g('opacity', 5.0),
        'scale': np.stack([g('scale_0', -5), g('scale_1', -5), g('scale_2', -5)], 1),
        'rot': np.stack([g('rot_0', 1), g('rot_1'), g('rot_2'), g('rot_3')], 1),
        'rgb_mode': rgb_mode,
    }


def write_ply(path, d):
    n = len(d['xyz'])
    names = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
             'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    v = np.zeros(n, dtype=[(k, '<f4') for k in names])
    v['x'], v['y'], v['z'] = d['xyz'].T
    v['f_dc_0'], v['f_dc_1'], v['f_dc_2'] = d['dc'].T
    v['opacity'] = d['op']
    v['scale_0'], v['scale_1'], v['scale_2'] = d['scale'].T
    v['rot_0'], v['rot_1'], v['rot_2'], v['rot_3'] = d['rot'].T
    head = 'ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % n + \
        ''.join('property float %s\n' % k for k in names) + 'end_header\n'
    with open(path, 'wb') as f:
        f.write(head.encode('ascii'))
        f.write(v.tobytes())


def take(d, m):
    return {k: (v[m] if isinstance(v, np.ndarray) else v) for k, v in d.items()}


def quat_mul(a, b):
    w1, x1, y1, z1 = a.T
    w2, x2, y2, z2 = b.T
    return np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
                     w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], 1)


def mat_to_quat(R):
    w = math.sqrt(max(0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = math.sqrt(max(0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2
    y = math.sqrt(max(0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2
    z = math.sqrt(max(0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2
    x = math.copysign(x, R[2, 1] - R[1, 2])
    y = math.copysign(y, R[0, 2] - R[2, 0])
    z = math.copysign(z, R[1, 0] - R[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def width_profile(h, lat, lo, hi, step=0.01):
    """高さ h ごとに、横幅（5%〜95%の幅）を測る"""
    ys, ws = [], []
    y = lo
    while y < hi:
        m = (h >= y) & (h < y + step)
        if m.sum() >= 20:
            a, b = np.percentile(lat[m], [5, 95])
            ys.append(y + step / 2)
            ws.append(b - a)
        y += step
    return np.array(ys), np.array(ws)


body_path, head_path, out_path = sys.argv[1:4]
opt = dict(scale=1.0, up=0.0, fwd=0.0, turn=0.0, cut=0.0)
for a in sys.argv[4:]:
    k, v = a.split('=')
    opt[k] = float(v)

B = read_ply(body_path)
Hd = read_ply(head_path)
alive = lambda d: 1 / (1 + np.exp(-d['op'])) > 0.1

# ---------- 全身の向き：上・横（腕の方向）・前 ----------
p = B['xyz']
lo, hi = np.percentile(p, 0.5, 0), np.percentile(p, 99.5, 0)
mid = np.median(p[:, 1])
up_sign = 1.0 if (mid - lo[1]) > (hi[1] - mid) else -1.0      # 足先までの方が頭までより長いので、長い側が下
ext = hi - lo
lat_ax = 0 if ext[0] >= ext[2] else 2                          # T字の腕が広がっている方向が横
fwd_ax = 2 if lat_ax == 0 else 0
up_v = np.zeros(3); up_v[1] = up_sign
h = p[:, 1] * up_sign
h0 = np.percentile(h, 0.5)
h = h - h0
H = np.percentile(h, 99.5)
lat = p[:, lat_ax]
fw = p[:, fwd_ax]
# 前：つま先はかかとより前に出ているので、足元の点は体の中心より前にある
feet = h < 0.04 * H
torso = (h > 0.45 * H) & (h < 0.6 * H)
fwd_sign = 1.0 if fw[feet].mean() >= np.median(fw[torso]) else -1.0
fwd_v = np.zeros(3); fwd_v[fwd_ax] = fwd_sign
right_v = np.cross(up_v, fwd_v)
print(f'全身：{len(p)} 個・身長 {H:.2f}・上は {"+" if up_sign > 0 else "-"}Y・前は {"+-"[fwd_sign < 0]}{"xyz"[fwd_ax]}')

# ---------- 全身の首：腕より上で、いちばん細いところ ----------
ys, ws = width_profile(h, lat, 0.6 * H, H)
arm_top = ys[ws > 0.5].max() if (ws > 0.5).any() else 0.8 * H
cand = (ys > arm_top + 0.02) & (ys < H - 0.12)
if not cand.any():
    cand = (ys > 0.8 * H) & (ys < H - 0.1)
neck_h = ys[cand][np.argmin(ws[cand])]
band = (h > neck_h - 0.01) & (h < neck_h + 0.01)
neck_c = np.array([np.median(p[band, 0]), 0, np.median(p[band, 2])])
neck_c[1] = (neck_h + h0) * up_sign
above = h > neck_h
hb = H - neck_h
wb = ws[(ys > neck_h)].max() if (ys > neck_h).any() else 0.16
print(f'全身の首：足元から {neck_h:.2f}（頭の高さ {hb:.2f}・幅 {wb:.2f}）')

# ---------- 頭部（LAM）の首：下の方で、いちばん細いところ ----------
q = Hd['xyz']
hl_ = q[:, 1] - np.percentile(q[:, 1], 0.5)
Hl = np.percentile(hl_, 99.5)
ys2, ws2 = width_profile(hl_, q[:, 0], 0, Hl, step=0.005)
low = ys2 < 0.4 * Hl
lam_neck = ys2[low][np.argmin(ws2[low])] if low.any() else 0.0
band2 = (hl_ > lam_neck - 0.005) & (hl_ < lam_neck + 0.005)
lam_c = np.array([np.median(q[band2, 0]), np.percentile(q[:, 1], 0.5) + lam_neck, np.median(q[band2, 2])])
hl = Hl - lam_neck
wl = ws2[ys2 > lam_neck].max() if (ys2 > lam_neck).any() else 0.16
s = math.sqrt((hb / hl) * (wb / wl)) if hl > 0 and wl > 0 else 1.0
s = float(np.clip(s, 0.8, 1.25)) * opt['scale']
print(f'頭部：{len(q)} 個・首から上 {hl:.2f}・幅 {wl:.2f}・色 {"そのまま→SHに変換" if Hd["rgb_mode"] else "SH"}・大きさの倍率 {s:.2f}')

# ---------- 頭部を全身の首に合わせて置く ----------
# LAM の頭部は +Y が上・+Z が顔の向き。全身の上・前に合わせて回す（turn で向きを微調整）
t = math.radians(opt['turn'])
yaw = np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])
R = np.stack([right_v, up_v, fwd_v], 1) @ yaw
keep_h = hl_ >= lam_neck - (0.015 + opt['cut'] / 100) / s   # 首の少し下まで残して、全身の首と重ねる
Hk = take(Hd, keep_h)
Hk['xyz'] = (R @ ((Hk['xyz'] - lam_c) * s).T).T + neck_c + up_v * opt['up'] / 100 + fwd_v * opt['fwd'] / 100
Hk['scale'] = Hk['scale'] + math.log(s)
Hk['rot'] = quat_mul(np.tile(mat_to_quat(R), (len(Hk['rot']), 1)), Hk['rot'])

# ---------- 全身の頭を消して、首の色をなじませる ----------
near_neck = np.hypot(lat - neck_c[lat_ax], fw - neck_c[fwd_ax]) < 0.3
cut_h = neck_h - opt['cut'] / 100
drop = (h > cut_h) & near_neck
# あご：首のいちばん細いところより下まで、前に垂れ下がっている。
#   首の下の方（のど）の前面より前に出ている点は、あごとして消す
fo = (fw - neck_c[fwd_ax]) * fwd_sign
throat = (h > cut_h - 0.08) & (h < cut_h - 0.05) & (np.abs(lat - neck_c[lat_ax]) < 0.06)
if throat.sum() >= 20:
    front = np.percentile(fo[throat], 90)
    chin = (h > cut_h - 0.07) & (fo > front + 0.01) & (np.abs(lat - neck_c[lat_ax]) < 0.09)
    print(f'あごとして消す点：{int((chin & ~drop).sum())} 個')
    drop |= chin
Bk = take(B, ~drop)
hk = h[~drop]
lam_neck_col = np.median(Hd['dc'][band2], 0) if band2.any() else None
if lam_neck_col is not None:
    seam = (hk > cut_h - 0.06) & (hk <= cut_h)
    w = np.clip((hk[seam] - (cut_h - 0.06)) / 0.06, 0, 1)[:, None] * 0.7
    Bk['dc'][seam] = Bk['dc'][seam] * (1 - w) + lam_neck_col * w

out = {k: np.concatenate([Bk[k], Hk[k]]) for k in ('xyz', 'dc', 'op', 'scale', 'rot')}
write_ply(out_path, out)
print(f'つなぎました：全身 {len(Bk["xyz"])} 個 ＋ 頭部 {len(Hk["xyz"])} 個 → {out_path}')
