# loop_tool.py — 長い動画から場面を選んで、ループする短い透過動画（WebM）を作る（Colab用）
#
# 使い方（Colabのセルで）:
#   !curl -sL https://raw.githubusercontent.com/noshukukangen-lgtm/pop-photo-room/main/colab/loop_tool.py -o /content/loop_tool.py
#   import sys, importlib; sys.path.insert(0, '/content'); import loop_tool; importlib.reload(loop_tool); loop_tool.start()
#
#   ドライブにつながずに使うときは、最後を loop_tool.start(upload=True) にする
#   （その場で動画をアップロードして、できた動画はダウンロードされる。Googleドライブには一切さわらない）
#
# ・動画は マイドライブ/kirinuki/input_videos に入れる（upload=True のときは不要）
# ・ファイル名の最後に「@1分23秒」「@1時間2分3秒」「@1-23」のように書いておくと、その時間ですぐ作れる
# ・書いていなければ、サムネイル（1分ごと → 前後1分を2秒ごと）で場面を選ぶ
# ・ループ：選んだ時間の前後から、最初と最後がいちばん似ている2〜5秒を自動で探して切り出す
# ・長いまま：選んだ時間の前後1分ずつ（切り出しツールで作ったクリップなら全部）を、音声つきでそのまま切り抜く
# ・VR180（左に左目・右に右目が並んだ動画）は、左右それぞれ人物を切り抜いて名前に「_vr180」を付ける
import os, re, json, subprocess, shutil, tempfile, base64, io
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import ipywidgets as W
from IPython.display import display, HTML
from PIL import Image

BASE = '/content/drive/MyDrive/kirinuki'
IN_DIR = f'{BASE}/input_videos'
OUT_DIR = f'{BASE}/output_loops'
LONG_SIDE = 1280        # 出力の長辺（Questで軽く再生できる大きさ）
VR_LONG = 2880          # VR180の出力の横幅（左右合わせて。片目1440）
FPS = 24                # 出力のコマ数
MIN_LEN, MAX_LEN = 2.0, 5.0   # ループの長さ（秒）
SEARCH = 4.0            # 選んだ時間の前後、何秒の中から探すか
FADE = 8                # 終わりを最初に溶け込ませるコマ数
FULL_HALF = 60.0        # 長いまま：選んだ時間の前後、何秒ずつ使うか
VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi')
UPLOAD = False


def _mount():
    if not os.path.isdir('/content/drive/MyDrive'):
        from google.colab import drive
        drive.mount('/content/drive')
    os.makedirs(IN_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)


def _upload():
    """ドライブを使わず、その場で動画をアップロードする"""
    global IN_DIR, OUT_DIR, UPLOAD
    UPLOAD = True
    IN_DIR, OUT_DIR = '/content/loop_in', '/content/loop_out'
    os.makedirs(IN_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    from google.colab import files
    print('動画を選んでください（何本でもOK。前にアップロードした分も残っています）')
    up = files.upload()
    for name, data in up.items():
        with open(os.path.join(IN_DIR, os.path.basename(name)), 'wb') as f:
            f.write(data)
        p = os.path.join('/content', name)
        if os.path.exists(p):
            os.remove(p)


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
                       capture_output=True, text=True)
    return float(json.loads(r.stdout)['format']['duration'])


def thumb(path, t, w=200):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', path, '-frames:v', '1',
                        '-vf', f'scale={w}:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'],
                       capture_output=True)
    return r.stdout


def thumbs(path, times):
    with ThreadPoolExecutor(8) as ex:
        return list(ex.map(lambda t: thumb(path, t), times))


def fmt(t):
    t = int(round(float(t)))
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'


def time_from_name(name):
    """ファイル名の最後の「@1分23秒」「@1時間2分3秒」「@83秒」「@1-23」「@1-02-03」を秒にする"""
    n = os.path.splitext(name)[0]
    m = re.search(r'@(?:(\d+)時間)?(?:(\d+)分)?(?:(\d+(?:\.\d+)?)秒)?$', n)
    if m and any(m.groups()):
        h, mi, s = (float(x) if x else 0.0 for x in m.groups())
        return h * 3600 + mi * 60 + s
    m = re.search(r'@(\d+)[:\-_](\d{1,2})(?:[:\-_](\d{1,2}))?$', n)
    if m:
        a, b, c = m.groups()
        return int(a) * 3600 + int(b) * 60 + int(c) if c else int(a) * 60 + int(b)
    return None


def frame_size(path, t, w):
    """幅 w にしたときの高さ（縦動画の回転も ffmpeg に任せる）"""
    return Image.open(io.BytesIO(thumb(path, t, w))).size


def read_frames(path, start, length, w, fps):
    w, h = frame_size(path, start, w)
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-t', f'{length:.3f}', '-i', path,
                        '-vf', f'scale={w}:{h},fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                       capture_output=True)
    n = len(r.stdout) // (w * h * 3)
    return np.frombuffer(r.stdout[:n * w * h * 3], np.uint8).reshape(n, h, w, 3)


def find_loop(path, t, dur):
    """選んだ時間 t の近くで、最初と最後のコマがいちばん似ている区間を探す"""
    f = 12
    s = max(0.0, t - SEARCH - MAX_LEN / 2)
    e = min(dur, t + SEARCH + MAX_LEN / 2)
    fr = read_frames(path, s, e - s, 160, f).astype(np.float32).mean(-1)
    n = len(fr)
    lo, hi = int(MIN_LEN * f), int(MAX_LEN * f)
    if n <= lo:
        return s, max(0.5, n / f), 0.0
    best = None
    for i in range(n):
        for j in range(i + lo, min(n, i + hi + 1)):
            d = float(np.abs(fr[i] - fr[j]).mean())
            mid = s + (i + j) / 2 / f
            cost = d + 0.5 * abs(mid - t)      # 似ているほど・選んだ時間に近いほど良い
            if best is None or cost < best[0]:
                best = (cost, i, j, d)
    _, i, j, d = best
    return s + i / f, (j - i) / f, d


_rvm = None
def _model():
    global _rvm
    if _rvm is None:
        import torch
        _rvm = torch.hub.load('PeterL1n/RobustVideoMatting', 'resnet50').eval().cuda()
    return _rvm


def matte(frames):
    """人物の切り抜き（透明度）。ループなので2周して、2周目の結果を使う（つなぎ目でも安定）"""
    import torch
    m = _model()
    h, w = frames.shape[1:3]
    ds = min(1.0, 512 / max(h, w))
    rec = [None] * 4
    with torch.no_grad():
        for _ in range(2):
            out = []
            for fr in frames:
                x = torch.from_numpy(np.ascontiguousarray(fr)).cuda().permute(2, 0, 1)[None].float() / 255
                fgr, pha, *rec = m(x, *rec, ds)
                out.append((pha[0, 0].clamp(0, 1) * 255).byte().cpu().numpy())
    return np.stack(out)


def loop_blend(rgb, a, k=FADE):
    """終わりの数コマを、最初のコマにじわっと溶け込ませる"""
    rgb = rgb.astype(np.float32)
    a = a.astype(np.float32)
    n = len(rgb)
    k = min(k, n // 3)
    for q in range(k):
        wgt = (q + 1) / (k + 1)
        i = n - k + q
        rgb[i] = rgb[i] * (1 - wgt) + rgb[0] * wgt
        a[i] = a[i] * (1 - wgt) + a[0] * wgt
    return rgb.clip(0, 255).astype(np.uint8), a.clip(0, 255).astype(np.uint8)


def encode(rgb, a, out):
    tmp = tempfile.mkdtemp()
    try:
        for i, (c, al) in enumerate(zip(rgb, a)):
            Image.fromarray(np.dstack([c, al]), 'RGBA').save(f'{tmp}/{i:05d}.png', compress_level=1)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(FPS), '-i', f'{tmp}/%05d.png',
                        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28',
                        '-row-mt', '1', '-auto-alt-ref', '0', '-an', out], check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _out_size(path, s, vr):
    w0, h0 = frame_size(path, s, 64)
    if vr:
        return VR_LONG
    return LONG_SIDE if w0 >= h0 else int(round(LONG_SIDE * w0 / h0 / 2) * 2)


def _download(out, log, box):
    if not UPLOAD:
        return
    try:
        from google.colab import files
        with box:
            files.download(out)
        log('ダウンロードを始めました（始まらなければ、左のフォルダの loop_out から右クリックでダウンロード）')
    except Exception as e:
        log(f'自動ダウンロードできませんでした：左のフォルダの loop_out から右クリックでダウンロードしてください（{e}）')


def make(path, t, log, box, vr=False):
    dur = duration(path)
    log(f'{fmt(t)} の前後で、きれいにループする区間を探しています…')
    s, L, d = find_loop(path, t, dur)
    log(f'{fmt(s)} から {L:.1f} 秒を使います（つなぎ目の差 {d:.1f}、小さいほどなめらか）')
    frames = read_frames(path, s, L, _out_size(path, s, vr), FPS)
    if vr:
        half = frames.shape[2] // 2
        frames = np.ascontiguousarray(frames[:, :, :half * 2])
        log(f'VR180：左目と右目をそれぞれ切り抜いています…（{len(frames)} コマ × 2）')
        a = np.concatenate([matte(frames[:, :, :half]), matte(frames[:, :, half:])], axis=2)
    else:
        log(f'人物を切り抜いています…（{len(frames)} コマ）')
        a = matte(frames)
    rgb, a = loop_blend(frames, a)
    stem = os.path.splitext(os.path.basename(path))[0].split('@')[0]
    tag = '_vr180' if vr else ''
    out = os.path.join(OUT_DIR, f'{stem}_{fmt(s).replace(":", "-")}{tag}_loop.webm')
    log('動画にしています…')
    encode(rgb, a, out)
    Image.fromarray(np.dstack([rgb[0], a[0]]), 'RGBA').save(out.replace('_loop.webm', '_loop_first.png'))
    log(f'完了しました：{out}')
    _download(out, log, box)
    b64 = base64.b64encode(open(out, 'rb').read()).decode()
    with box:
        display(HTML(
            '<div style="display:inline-block;padding:8px;'
            'background:repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/20px 20px">'
            f'<video src="data:video/webm;base64,{b64}" autoplay loop muted playsinline '
            'style="max-width:480px;max-height:480px;display:block"></video></div>'))


def make_full(path, t, log, box, vr=False):
    """ループにせず、長いまま切り抜く（1コマずつ処理して、そのまま動画に流し込むのでメモリを食わない）"""
    import torch
    dur = duration(path)
    s = max(0.0, t - FULL_HALF)
    L = min(dur, t + FULL_HALF) - s
    w, h = frame_size(path, s, _out_size(path, s, vr))
    if vr:
        w = (w // 4) * 4
    half = w // 2
    stem = os.path.splitext(os.path.basename(path))[0].split('@')[0]
    tag = '_vr180' if vr else ''
    out = os.path.join(OUT_DIR, f'{stem}_{fmt(s).replace(":", "-")}{tag}_full.webm')
    total = int(L * FPS)
    log(f'{fmt(s)} から {L:.0f} 秒を、長いまま切り抜きます（{total} コマ{" × 左右2" if vr else ""}。10分以上かかることがあります）')

    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f'{s:.3f}', '-t', f'{L:.3f}', '-i', path,
                            '-vf', f'scale={w}:{h},fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y',
                            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{w}x{h}', '-framerate', str(FPS), '-i', 'pipe:0',
                            '-ss', f'{s:.3f}', '-t', f'{L:.3f}', '-i', path,
                            '-map', '0:v', '-map', '1:a?',
                            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30',
                            '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-auto-alt-ref', '0',
                            '-c:a', 'libopus', '-b:a', '128k', '-shortest', out],
                           stdin=subprocess.PIPE)
    m = _model()
    ds = min(1.0, 512 / max(h, half if vr else w))
    recs = [[None] * 4, [None] * 4]
    fb = w * h * 3
    n = 0
    try:
        with torch.no_grad():
            while True:
                buf = dec.stdout.read(fb)
                if len(buf) < fb:
                    break
                fr = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                parts = [fr[:, :half], fr[:, half:]] if vr else [fr]
                alphas = []
                for k, p in enumerate(parts):
                    x = torch.from_numpy(np.ascontiguousarray(p)).cuda().permute(2, 0, 1)[None].float() / 255
                    res = m(x, *recs[k], ds)
                    recs[k] = list(res[2:])
                    alphas.append((res[1][0, 0].clamp(0, 1) * 255).byte().cpu().numpy())
                rgba = np.dstack([fr, np.concatenate(alphas, axis=1)])
                if n == 0:
                    Image.fromarray(rgba, 'RGBA').save(out.replace('_full.webm', '_full_first.png'))
                enc.stdin.write(rgba.tobytes())
                n += 1
                if n % (FPS * 10) == 0:
                    log(f'  {n // FPS} / {L:.0f} 秒 まで切り抜きました')
    finally:
        enc.stdin.close()
        enc.wait()
        dec.wait()
    log(f'完了しました：{out}（{os.path.getsize(out) / 1048576:.0f} MB）')
    _download(out, log, box)


def start(upload=False):
    if upload:
        _upload()
    else:
        _mount()
    try:
        from google.colab import output
        output.enable_custom_widget_manager()
    except Exception:
        pass
    vids = sorted(f for f in os.listdir(IN_DIR) if f.lower().endswith(VIDEO_EXT))
    if not vids:
        print('動画がありません。もう一度実行して動画を選んでください' if upload
              else f'{IN_DIR} に動画を入れてから、もう一度実行してください')
        return

    dd = W.Dropdown(options=vids, description='動画', layout=W.Layout(width='560px'))
    go = W.Button(description='サムネイルを出す', button_style='primary')
    name_btn = W.Button(button_style='success', layout=W.Layout(width='300px'))
    vrc = W.Checkbox(description='VR180（左に左目・右に右目が並んだ動画）', indent=False)
    full = W.Checkbox(description='長いまま（ループにしない。選んだ時間の前後1分ずつ・音声つき）', indent=False)
    area = W.VBox()
    box = W.Output()

    def log(m):
        with box:
            print(m)

    def path():
        return os.path.join(IN_DIR, dd.value)

    def on_dd(_=None):
        t = time_from_name(dd.value)
        name_btn.layout.display = 'none' if t is None else ''
        if t is not None:
            name_btn.description = f'ファイル名の時間（{fmt(t)}）で作る'
        try:
            w, h = frame_size(path(), 1, 64)
            vrc.value = w >= 1.9 * h        # 横が縦の約2倍ならVR180とみなす（違えば外せる）
            full.value = vrc.value          # VR180は最初から「長いまま」
        except Exception:
            pass
    dd.observe(on_dd, 'value')
    on_dd()

    def grid(times, imgs, on_pick):
        cells = []
        for t, b in zip(times, imgs):
            img = W.Image(value=b or b'', format='jpeg', layout=W.Layout(width='160px'))
            btn = W.Button(description=fmt(t), layout=W.Layout(width='160px'))
            btn.on_click(lambda _, t=float(t): on_pick(t))
            cells.append(W.VBox([img, btn]))
        return W.GridBox(cells, layout=W.Layout(grid_template_columns='repeat(6, 170px)'))

    def level1(_=None):
        p = path()
        dur = duration(p)
        long = dur > 120
        area.children = [W.HTML('サムネイルを作っています…')]
        times = list(np.arange(0, dur, 60.0 if long else 2.0))
        imgs = thumbs(p, times)
        msg = '1分ごと。近い場面をクリックすると、前後1分を2秒ごとに出します' if long else '2秒ごと。欲しい場面をクリック'
        area.children = [W.HTML(f'<b>{dd.value}</b>（{fmt(dur)}）：{msg}'), grid(times, imgs, level2 if long else confirm)]

    def level2(t):
        p = path()
        dur = duration(p)
        area.children = [W.HTML(f'{fmt(t)} の前後のサムネイルを作っています…')]
        times = list(np.arange(max(0.0, t - 60), min(dur, t + 60), 2.0))
        imgs = thumbs(p, times)
        back = W.Button(description='← 戻る')
        back.on_click(level1)
        area.children = [W.HBox([back, W.HTML(f'　{fmt(times[0])}〜{fmt(times[-1])}：2秒ごと。欲しい場面をクリック')]),
                         grid(times, imgs, confirm)]

    def confirm(t):
        p = path()
        big = W.Image(value=thumb(p, t, 640), format='jpeg', layout=W.Layout(width='480px'))
        ok = W.Button(description='この場面で作る', button_style='success', layout=W.Layout(width='240px'))
        back = W.Button(description='← 選び直す')
        back.on_click(lambda _: level2(t) if duration(p) > 120 else level1())
        ok.on_click(lambda _: run(t))
        area.children = [W.HTML(f'<b>{fmt(t)}</b> の場面'), big, W.HBox([ok, back])]

    def run(t):
        try:
            if full.value:
                make_full(path(), t, log, box, vrc.value)
            else:
                make(path(), t, log, box, vrc.value)
        except Exception as e:
            log(f'失敗しました：{e}')

    go.on_click(level1)
    name_btn.on_click(lambda _: run(time_from_name(dd.value)))
    display(W.VBox([W.HBox([dd, go, name_btn]), vrc, full, area, box]))
