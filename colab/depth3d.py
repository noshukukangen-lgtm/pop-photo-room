# depth3d.py — 動画の全部のコマで立体にする「〜_3d.mp4」を作る（Colab用。loop_tool と一緒に使う）
#   上 2/3：元の映像
#   下 1/3：左 2/3 が切り抜き（白＝人）、右 1/3 の上半分が奥行き（白＝手前）、下半分がふくらみ（白＝厚い）
#   アプリは再生中のコマの奥行きとふくらみで、毎コマ形を作り直す
#
#   本物の動画から作る：depth3d.start()（loop_tool の画面が出る。「長いまま」なら音声つきで全部、外せばループ）
#   できている動画を作り直す：depth3d.to_3d('/content/…/〜.mp4')
import os, subprocess
import numpy as np
from PIL import Image
import loop_tool as lt

MAX_LONG = 1920          # 長い辺の上限（Questで滑らかに再生できる大きさ）
FPS_MAX = 30             # コマ数の上限
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


def depth_raw(frames):
    """コマごとの奥行き（白いほど手前・まだ 0〜1 にそろえていない）"""
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
    return out


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


class Shaper:
    """1コマずつ：奥行きを 0〜1 にそろえ（そろえ方もコマ間でなめらかに）、人の中だけでならし、ふくらみを作る"""
    def __init__(self, h):
        self.s = max(2.0, h / 200)
        self.lo = self.hi = None

    def __call__(self, d, alpha):
        import cv2
        lo, hi = np.percentile(d, 2), np.percentile(d, 98)
        if self.lo is None:
            self.lo, self.hi = lo, hi
        else:                                   # 明るさのそろえ方が急に変わると形がぴくっと動くので、ゆっくり追う
            self.lo = self.lo * 0.8 + lo * 0.2
            self.hi = self.hi * 0.8 + hi * 0.2
        d = np.clip((d - self.lo) / max(1e-6, self.hi - self.lo), 0, 1).astype(np.float32)
        wm = (alpha > 127).astype(np.float32)
        s = self.s
        num, den = cv2.GaussianBlur(d * wm, (0, 0), s), cv2.GaussianBlur(wm, (0, 0), s)
        inside = np.where(den > 1e-3, num / np.maximum(den, 1e-3), cv2.GaussianBlur(d, (0, 0), s))
        num2, den2 = cv2.GaussianBlur(d * wm, (0, 0), s * 8), cv2.GaussianBlur(wm, (0, 0), s * 8)
        outside = np.where(den2 > 1e-3, num2 / np.maximum(den2, 1e-3), inside)
        return np.where(wm > 0, inside, outside), _bulge(wm)


def pack(rgb, alpha, D, B):
    """1コマを「上に映像、下に 切り抜き｜奥行き／ふくらみ」の1枚にする"""
    import cv2
    h, w = rgb.shape[:2]
    bh, mw = h // 2, w * 2 // 3
    dw, qh = w - mw, bh // 2
    bottom = np.zeros((bh, w), np.float32)
    bottom[:, :mw] = cv2.resize(alpha.astype(np.float32), (mw, bh), interpolation=cv2.INTER_AREA)
    bottom[:qh, mw:] = cv2.resize(D * 255, (dw, qh), interpolation=cv2.INTER_AREA)
    bottom[qh:, mw:] = cv2.resize(np.clip(B * 2, 0, 1) * 255, (dw, bh - qh), interpolation=cv2.INTER_AREA)
    bottom = np.clip(bottom, 0, 255).astype(np.uint8)
    return np.concatenate([rgb, np.repeat(bottom[:, :, None], 3, axis=2)], axis=0)


def _encoder_args(log):
    t = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=512x512:d=0.2',
                        '-c:v', 'h264_nvenc', '-f', 'null', '-'], capture_output=True)
    if t.returncode == 0:
        log('動画の形式：H.264（GPUで高速に作ります）')
        return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '18', '-b:v', '0',
                '-profile:v', 'high', '-pix_fmt', 'yuv420p']
    log('動画の形式：H.264')
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p']


def _size(path, t):
    """長い辺を MAX_LONG までにした大きさ（縦横の回転も考える）。型紙の都合で 横は6・縦は4 の倍数"""
    W0, H0, _ = lt._probe(path)
    w64, h64 = lt.frame_size(path, t, 64)
    long = min(max(W0, H0), MAX_LONG)
    w = long if w64 >= h64 else int(round(long * w64 / h64))
    w -= w % 6
    h = int(round(w * h64 / w64))
    h -= h % 4
    return w, h


def _ema(prev, x, k=0.35):
    return x if prev is None else prev * k + x * (1 - k)


def encode_3d(frames, alpha, out, fps, log=print, loop=True):
    """短い動画（全部のコマがメモリにあるもの）を 〜_3d.mp4 にする。ループなら前後からならしてつなぎ目もなめらかに
       長いループでも画面を小さくしないで済むよう、奥行きは8コマずつ作って、すぐ型紙の大きさに縮めて持つ"""
    import cv2
    n, h, w = frames.shape[:3]
    h, w = h - h % 4, w - w % 6
    frames, alpha = frames[:, :h, :w], alpha[:, :h, :w]
    dw, qh, bq = w - w * 2 // 3, (h // 2) // 2, h // 2 - (h // 2) // 2
    sh = Shaper(h)
    if loop:                                    # 最初のそろえ方を、全体の平均から始める（数コマだけ先に見る）
        idx = list(range(0, n, max(1, n // 8)))
        smp = depth_raw(np.ascontiguousarray(frames[idx]))
        sh.lo = float(np.mean([np.percentile(r, 2) for r in smp]))
        sh.hi = float(np.mean([np.percentile(r, 98) for r in smp]))
        del smp
    log(f'全部のコマ（{n} コマ）の奥行きを作っています…')
    D = np.empty((n, qh, dw), np.float32)
    Bs = np.empty((n, bq, dw), np.float32)
    for i in range(0, n, 8):
        raw = depth_raw(np.ascontiguousarray(frames[i:i + 8]))
        for j, r in enumerate(raw):
            d, bb = sh(r, alpha[i + j])
            D[i + j] = cv2.resize(d, (dw, qh), interpolation=cv2.INTER_AREA)
            Bs[i + j] = cv2.resize(bb, (dw, bq), interpolation=cv2.INTER_AREA)
        if (i // 8) % 30 == 29:
            log(f'  {i + 8} / {n} コマ')
    # コマ同士の揺れを抑える（前から・後ろからの平均なので動きは遅れない）
    def smooth(x):
        def run(seq):
            y = np.empty_like(seq)
            acc = seq[-1] if loop else seq[0]
            for _ in range(2 if loop else 1):
                for i in range(n):
                    acc = acc * 0.4 + seq[i] * 0.6
                    y[i] = acc
            return y
        return (run(x) + run(x[::-1])[::-1]) / 2 if n >= 3 else x
    D, Bs = smooth(D), smooth(Bs)
    log('動画にしています…')
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', f'{w}x{h + h // 2}', '-framerate', f'{fps}', '-i', 'pipe:0']
                           + _encoder_args(log) + ['-movflags', '+faststart', out], stdin=subprocess.PIPE)
    for i in range(n):
        enc.stdin.write(np.ascontiguousarray(pack(frames[i], alpha[i], D[i], Bs[i])).tobytes())
    enc.stdin.close()
    enc.wait()
    if enc.returncode != 0:
        raise RuntimeError('動画を書き出せませんでした')
    Image.fromarray(np.dstack([frames[0], alpha[0]]), 'RGBA').save(out.replace('.mp4', '_first.png'))


def make_full_3d(path, t, log, box, half=None):
    """長いまま（選んだ時間の前後1分ずつ・切り出しツールのクリップなら全部）を、音声つき・全部のコマで立体に。
    少しずつ読んで、そのまま動画に流し込むのでメモリを食わない"""
    import torch
    half = lt.FULL_HALF if half is None else half
    dur = lt.duration(path)
    s = max(0.0, t - half)
    L = min(dur, t + half) - s
    _, _, fps0 = lt._probe(path)
    fps = min(float(FPS_MAX), fps0) if fps0 > 0 else 30.0
    w, h = _size(path, s)
    stem = os.path.splitext(os.path.basename(path))[0].split('@')[0]
    out = os.path.join(lt.OUT_DIR, f'{stem}_{lt.fmt(s).replace(":", "-")}_3d.mp4')
    log('切り抜きAIと奥行きAIを準備しています…')
    m = lt._model()
    _depth_model()
    log(f'{lt.fmt(s)} から {L:.0f} 秒を、{w}×{h}・{fps:.0f}コマで、全部のコマを立体にします（{int(L * fps)} コマ。10分以上かかることがあります）')

    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f'{s:.3f}', '-t', f'{L:.3f}', '-i', path,
                            '-vf', f'scale={w}:{h}:flags=lanczos,fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y',
                            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h + h // 2}', '-framerate', f'{fps}', '-i', 'pipe:0',
                            '-ss', f'{s:.3f}', '-t', f'{L:.3f}', '-i', path,
                            '-map', '0:v', '-map', '1:a?'] + _encoder_args(log) +
                           ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out],
                           stdin=subprocess.PIPE)
    ds = min(1.0, 512 / max(h, w))
    rec = [None] * 4
    sh = Shaper(h)
    pD = pB = None
    fb = w * h * 3
    n = 0
    done = False
    try:
        while not done:
            chunk = []
            while len(chunk) < 8:
                buf = dec.stdout.read(fb)
                if len(buf) < fb:
                    done = True
                    break
                chunk.append(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
            if not chunk:
                break
            fr = np.stack(chunk)
            al = []
            with torch.no_grad():
                for f in fr:
                    x = torch.from_numpy(np.ascontiguousarray(f)).cuda().permute(2, 0, 1)[None].float() / 255
                    res = m(x, *rec, ds)
                    rec = list(res[2:])
                    al.append((res[1][0, 0].clamp(0, 1) * 255).byte().cpu().numpy())
            raw = depth_raw(fr)
            for i in range(len(fr)):
                D, B = sh(raw[i], al[i])
                pD, pB = _ema(pD, D), _ema(pB, B)
                if n == 0:
                    Image.fromarray(np.dstack([fr[i], al[i]]), 'RGBA').save(out.replace('.mp4', '_first.png'))
                enc.stdin.write(np.ascontiguousarray(pack(fr[i], al[i], pD, pB)).tobytes())
                n += 1
                if n % int(fps * 10) == 0:
                    log(f'  {n / fps:.0f} / {L:.0f} 秒 まで立体にしました')
    finally:
        enc.stdin.close()
        enc.wait()
        dec.wait()
    if enc.returncode != 0:
        raise RuntimeError('動画を書き出せませんでした（上に英語のエラーが出ていたら教えてください）')
    log(f'完了しました：{out}（{os.path.getsize(out) / 1048576:.0f} MB）')
    lt._download(out, log, box)
    return out


def make_loop_3d(path, t, log, box):
    """選んだ時間の近くで、きれいにループする区間（つなぎ目がきれいな範囲でできるだけ長く、2〜30秒）を探して、全部のコマで立体にする"""
    dur = lt.duration(path)
    log(f'{lt.fmt(t)} の前後で、きれいにループする区間を探しています…')
    s, L, d = lt.find_loop(path, t, dur)
    log(f'{lt.fmt(s)} から {L:.1f} 秒を使います（つなぎ目の差 {d:.1f}、小さいほどなめらか）')
    w, h = _size(path, s)
    frames = lt.read_frames(path, s, L, w, lt.FPS)
    log(f'人物を切り抜いています…（{len(frames)} コマ）')
    a = lt.matte(frames)
    rgb, a = lt.loop_blend(frames, a)
    del frames
    stem = os.path.splitext(os.path.basename(path))[0].split('@')[0]
    out = os.path.join(lt.OUT_DIR, f'{stem}_{lt.fmt(s).replace(":", "-")}_loop_3d.mp4')
    encode_3d(rgb, a, out, lt.FPS, log, loop=True)
    log(f'完了しました：{out}')
    lt._download(out, log, box)
    return out


def to_3d(path, loop=True, log=print):
    """できている動画（AIで作った〜_ai.mp4 など）を、全部のコマで立体になる〜_3d.mp4 に作り直す"""
    _, _, fps = lt._probe(path)
    dur = lt.duration(path)
    w, _ = _size(path, 0)
    frames = lt.read_frames(path, 0, dur, w, fps)
    log(f'{os.path.basename(path)}：{frames.shape[2]}×{frames.shape[1]}・{len(frames)} コマ。人物を切り抜いています…')
    a = lt.matte(frames)
    if loop:
        frames, a = lt.loop_blend(frames, a)
    stem = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(os.path.dirname(path), f'{stem}_3d.mp4')
    encode_3d(frames, a, out, fps, log, loop)
    log(f'完了しました：{out}')
    try:
        from google.colab import files
        files.download(out)
    except Exception:
        pass
    return out


def start(upload=True):
    """loop_tool の画面で、VR180以外は全部のコマで立体になる動画を作るようにして開く"""
    orig_make, orig_full = lt.make, lt.make_full

    def make(path, t, log, box, vr=False):
        return orig_make(path, t, log, box, vr) if vr else make_loop_3d(path, t, log, box)

    def make_full(path, t, log, box, vr=False):
        return orig_full(path, t, log, box, vr) if vr else make_full_3d(path, t, log, box)

    lt.make, lt.make_full = make, make_full
    print('切り抜きAIと奥行きAIを準備しています…（初回は1〜2分）')
    lt._model()
    _depth_model()
    lt.start(upload=upload)
