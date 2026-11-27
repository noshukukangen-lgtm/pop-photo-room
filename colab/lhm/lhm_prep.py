# lhm_prep.py — LHM++ に渡す前に、写真から人だけを切り抜いて、白い背景・縦長（5:3）にそろえる
#   使い方：/content/lhm_env/bin/python lhm_prep.py 入力フォルダ 出力フォルダ
#   ・何人か写っていても、いちばん大きく写っている人だけを残す
#   ・頭から足まで写っている（縦に長い）写真を先頭にする（体の形はその1枚目から推定されるため）
import os, sys, glob
import numpy as np
import cv2
from PIL import Image, ImageOps
from rembg import new_session, remove

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
OUT_H, OUT_W = 840, 504          # LHM++ の入力の大きさ（縦:横 = 5:3）

try:
    sess = new_session('birefnet-general')
except Exception:
    sess = new_session('u2net_human_seg')

items = []
for p in sorted(glob.glob(os.path.join(src, '*'))):
    try:
        img = ImageOps.exif_transpose(Image.open(p)).convert('RGB')
    except Exception:
        continue
    img.thumbnail((2048, 2048))
    rgb = np.asarray(img)
    a = np.asarray(remove(img, session=sess, only_mask=True), dtype=np.uint8)
    if a.ndim == 3:
        a = a[..., 0]
    m = (a > 127).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        print(f'{os.path.basename(p)}：人が見つからなかったので使いません')
        continue
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))          # いちばん大きな人
    keep = cv2.dilate((lab == k).astype(np.uint8), np.ones((15, 15), np.uint8))
    a = (a.astype(np.float32) / 255) * keep
    x, y, w, h = cv2.boundingRect((a > 0.5).astype(np.uint8))
    pad = int(max(w, h) * 0.04)
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(rgb.shape[1], x + w + pad), min(rgb.shape[0], y + h + pad)
    crop = rgb[y0:y1, x0:x1].astype(np.float32)
    al = a[y0:y1, x0:x1, None]
    crop = crop * al + 255 * (1 - al)                               # 背景を白に
    ch, cw = crop.shape[:2]
    s = min(OUT_H / ch, OUT_W / cw)
    crop = cv2.resize(crop, (max(1, int(cw * s)), max(1, int(ch * s))),
                      interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LANCZOS4)
    canvas = np.full((OUT_H, OUT_W, 3), 255, np.float32)
    oy, ox = (OUT_H - crop.shape[0]) // 2, (OUT_W - crop.shape[1]) // 2
    canvas[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
    items.append((h / max(1, w), os.path.basename(p), np.clip(canvas, 0, 255).astype(np.uint8)))

if not items:
    print('使える写真がありませんでした')
    sys.exit(2)
items.sort(key=lambda t: -t[0])                                     # 縦に長い（全身の）写真を先頭に
for i, (_, name, im) in enumerate(items[:8]):
    Image.fromarray(im).save(os.path.join(dst, f'{i:02d}.png'))
    print(f'{i + 1}枚目：{name}')
if len(items) > 8:
    print(f'（{len(items)}枚のうち、8枚を使います）')
