# depth3d.py — 動画の全部のコマで立体にする「〜_3d.mp4」を作る（Colab用。loop_tool と一緒に使う）
#   上 2/3：元の映像
#   下 1/3：左から [切り抜き｜奥行き｜ふくらみ] の3枚（それぞれ白いほど 人／手前／厚い）
#   アプリは再生中のコマの奥行きとふくらみで、毎コマ形を作り直す
#   できている動画を作り直すとき：depth3d.to_3d('/content/ai_out/〜_ai.mp4')
import os, subprocess
import numpy as np
from PIL import Image
import loop_tool as lt


_depth = None


def _depth_model():
    global _depth
    if _depth is None:
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        name = 'depth-anything/Depth-Anything-V2-Base-hf'
        _depth = (AutoImageProcessor.from_pretrained(name),
                  AutoModelForDepthEstimation.from_pretrained(name).to('cuda').eval().half())
    return _depth


def depth_frames(frames):
    """コマごとの奥行き（白いほど手前）。1コマずつ 0〜1 にそろえる"""
    import torch
    import torch.nn.functional as F
    proc, model = _depth_model()
    n, h, w = frames.shape[:3]
    out = np.zeros((n, h, w), np.float32)
    with torch.no_grad():
        for i in range(0, n, 8):
            inp = proc(images=[Image.fromarray(f) for f in frames[i:i + 8]], return_tensors='pt')
            pred = model(pixel_values=inp['pixel_values'].to('cuda').half()).predicted_depth.float()
            out[i:i + 8] = F.interpolate(pred[:, None], size=(h, w), mode='bilinear', align_corners=False)[:, 0].cpu().numpy()
    for i in range(n):
        lo, hi = np.percentile(out[i], 2), np.percentile(out[i], 98)
        out[i] = np.clip((out[i] - lo) / max(1e-6, hi - lo), 0, 1)
    return out


def _smooth_time(x, k=0.5, loop=True):
    """コマ同士の揺れ（ちらつき）を抑える。前からと後ろからのならしを平均するので、動きは遅れない"""
    n = len(x)
    if n < 3:
        return x
    def run(seq):
        y = np.empty_like(seq)
        acc = seq[-1] if loop else seq[0]
        for _ in range(2 if loop else 1):      # ループなら一周目で端をなじませる
            for i in range(n):
                acc = acc * k + seq[i] * (1 - k)
                y[i] = acc
        return y
    return (run(x) + run(x[::-1])[::-1]) / 2


def _bulge(wm):
    """切り抜きの形から、風船のような厚み（写真の高さに対する割合）を作る"""
    import cv2
    from scipy import ndimage
    h, w = wm.shape
    sh, sw = max(8, h // 4), max(8, w // 4)
    small = cv2.resize(wm, (sw, sh), interpolation=cv2.INTER_AREA) > 0.5
    dt = ndimage.distance_transform_edt(small)
    R = ndimage.maximum_filter(dt, size=max(3, sh // 8))
    b = np.sqrt(np.clip(dt * (2 * R - dt), 0, None)) / sh
    b = cv2.GaussianBlur(b.astype(np.float32), (0, 0), 1.0)
    return cv2.resize(b, (w, h), interpolation=cv2.INTER_LINEAR)


def encode_3d(frames, alpha, out, fps, log=print, loop=True):
    import cv2
    n, h, w = frames.shape[:3]
    h, w = h - h % 4, w - w % 6
    frames, alpha = frames[:, :h, :w], alpha[:, :h, :w]
    tw, th = w // 3, h // 2
    log(f'全部のコマ（{n} コマ）の奥行きを作っています…')
    D = depth_frames(np.ascontiguousarray(frames))
    M = alpha.astype(np.float32) / 255
    s = max(2.0, h / 200)
    Dn = np.empty_like(D)
    Bn = np.empty_like(D)
    for i in range(n):
        wm = (M[i] > 0.5).astype(np.float32)
        d = D[i]
        # 人の中だけでならす（背景の奥行きが体のふちに混ざらないように）。背景は近くの人の奥行きに寄せる
        num, den = cv2.GaussianBlur(d * wm, (0, 0), s), cv2.GaussianBlur(wm, (0, 0), s)
        inside = np.where(den > 1e-3, num / np.maximum(den, 1e-3), cv2.GaussianBlur(d, (0, 0), s))
        num2, den2 = cv2.GaussianBlur(d * wm, (0, 0), s * 8), cv2.GaussianBlur(wm, (0, 0), s * 8)
        outside = np.where(den2 > 1e-3, num2 / np.maximum(den2, 1e-3), inside)
        Dn[i] = np.where(wm > 0, inside, outside)
        Bn[i] = _bulge(wm)
    Dn = _smooth_time(Dn, 0.5, loop)
    Bn = _smooth_time(Bn, 0.5, loop)

    log('動画にしています…')
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', f'{w}x{h + th}', '-framerate', f'{fps}', '-i', 'pipe:0',
                            '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p',
                            '-movflags', '+faststart', out], stdin=subprocess.PIPE)
    tile = lambda x: cv2.resize(x, (tw, th), interpolation=cv2.INTER_AREA)
    for i in range(n):
        t0 = tile(alpha[i].astype(np.float32))
        t1 = tile(Dn[i] * 255)
        t2 = tile(np.clip(Bn[i] * 2, 0, 1) * 255)        # 厚みは高さの半分までを 0〜255 に
        bottom = np.clip(np.concatenate([t0, t1, t2], axis=1), 0, 255).astype(np.uint8)
        packed = np.concatenate([frames[i], np.repeat(bottom[:, :, None], 3, axis=2)], axis=0)
        enc.stdin.write(np.ascontiguousarray(packed).tobytes())
    enc.stdin.close()
    enc.wait()
    if enc.returncode != 0:
        raise RuntimeError('動画を書き出せませんでした')
    Image.fromarray(np.dstack([frames[0], alpha[0]]), 'RGBA').save(out.replace('.mp4', '_first.png'))


def to_3d(path, loop=True, log=print):
    """できている動画（AIで作った〜_ai.mp4 など）を、全部のコマで立体になる〜_3d.mp4 に作り直す"""
    W0, H0, fps = lt._probe(path)
    dur = lt.duration(path)
    w = min(W0, 1280) if W0 >= H0 else min(W0, 768)
    frames = lt.read_frames(path, 0, dur, w, fps)
    log(f'{os.path.basename(path)}：{frames.shape[2]}×{frames.shape[1]}・{len(frames)} コマ。人物を切り抜いています…')
    a = lt.matte(frames)
    if loop:
        frames, a = lt.loop_blend(frames, a)
    out_dir = os.path.dirname(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(out_dir, f'{stem}_3d.mp4')
    encode_3d(frames, a, out, fps, log, loop)
    log(f'完了しました：{out}')
    try:
        from google.colab import files
        files.download(out)
    except Exception:
        pass
    return out
