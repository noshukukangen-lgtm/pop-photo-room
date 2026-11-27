# lhm_tool.py — 写真1〜8枚、または動画1本から、全身の立体人物（3Dガウシアン .ply）を作る（Colab用・LHM++）
#   準備は lhm_setup.sh（別の Python 3.10 環境に LHM++ を入れる）。ここではその環境で動かすだけ
#   写真・動画はその場でアップロード（Googleドライブにはさわらない）。できたものは一周回る確認動画と .ply
#   ・写真は「同じ日・同じ服・同じ髪型」のものだけを一緒にする（違う日の写真を混ぜると崩れる）
#   ・動画なら、その中から角度の違うくっきりしたコマを8枚、自動で選ぶ
import os, glob, shutil, subprocess, base64, time

ROOT = '/content/LHMPP'
PY = '/content/lhm_env/bin/python'
IN_DIR = '/content/lhm_in'
PREP_DIR = '/content/lhm_prep'
OUT_DIR = '/content/lhm_out'
HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm')
MODEL = 'LHMPP-700M-PixelShuffle'


def _run(cmd, cwd=None):
    """実行しながら、出てきた文字をそのまま表示する"""
    # GPU向けの部品はその場で組み立てることがあるので、PyTorchに合わせた CUDA 12.1 の道具を使う（lhm_setup.sh で入れたもの）
    cuda = '/content/cuda121' if os.path.exists('/content/cuda121/bin/nvcc') else '/usr/local/cuda'
    env = dict(os.environ, PATH='/content/lhm_env/bin:' + cuda + '/bin:' + os.environ['PATH'],
               CUDA_HOME=cuda, CC='gcc-12', CXX='g++-12', NVCC_PREPEND_FLAGS='-ccbin /usr/bin/g++-12',
               TORCH_CUDA_ARCH_LIST='8.0;8.6;8.9', PYTHONUNBUFFERED='1')
    env.pop('PYTHONPATH', None)                     # Colab本体の部品が混ざらないように
    env.pop('MPLBACKEND', None)
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in p.stdout:
        lines.append(line)
        print(line, end='')
    p.wait()
    return p.returncode, ''.join(lines)


def _frames_from_video(path, out_dir, n=8, cand=64):
    """動画から、全体に散らばった、くっきりしたコマを n 枚選ぶ"""
    import cv2
    import numpy as np
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    picks = []
    for i in range(cand):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int((i + 0.5) * total / cand))
        ok, fr = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(cv2.resize(fr, (640, int(640 * fr.shape[0] / fr.shape[1]))), cv2.COLOR_BGR2GRAY)
        picks.append((i, cv2.Laplacian(g, cv2.CV_64F).var(), fr))
    cap.release()
    if not picks:
        return 0
    groups = np.array_split(np.arange(len(picks)), min(n, len(picks)))
    stem = os.path.splitext(os.path.basename(path))[0]
    for j, g in enumerate(groups):
        best = max((picks[k] for k in g), key=lambda t: t[1])      # その区間でいちばんくっきりしたコマ
        cv2.imwrite(os.path.join(out_dir, f'{stem}_{j:02d}.jpg'), best[2], [cv2.IMWRITE_JPEG_QUALITY, 95])
    return len(groups)


def _show(name, ply, mp4):
    from IPython.display import display, HTML
    if os.path.exists(mp4):
        b64 = base64.b64encode(open(mp4, 'rb').read()).decode()
        display(HTML(f'<p><b>{name}</b>（{os.path.getsize(ply) / 1048576:.0f} MB）</p>'
                     f'<video src="data:video/mp4;base64,{b64}" autoplay loop muted playsinline '
                     'style="max-height:480px"></video>'))


def start(name=None):
    """写真（1〜8枚・同じ日・同じ服）か動画1本を選んで、立体人物を1人作る"""
    from google.colab import files
    if not os.path.exists(PY):
        print('先に「1. 準備」のセルを実行してください')
        return
    for d in (IN_DIR, PREP_DIR):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    os.makedirs(OUT_DIR, exist_ok=True)
    print('写真（同じ日・同じ服の1〜8枚。正面・斜め・横・後ろがあるほど良い）か、その人が映った動画1本を選んでください')
    up = files.upload()
    vids, n = [], 0
    for fn, data in up.items():
        base = os.path.basename(fn).replace(' ', '_')
        tmp = os.path.join('/content', fn)
        if os.path.exists(tmp):
            os.remove(tmp)
        if base.lower().endswith(VIDEO_EXT):
            vp = os.path.join('/content', 'lhm_video_' + base)
            with open(vp, 'wb') as f:
                f.write(data)
            vids.append(vp)
        else:
            with open(os.path.join(IN_DIR, base), 'wb') as f:
                f.write(data)
            n += 1
    for vp in vids:
        k = _frames_from_video(vp, IN_DIR)
        print(f'{os.path.basename(vp)}：動画から {k} コマ選びました')
        os.remove(vp)
    if not os.listdir(IN_DIR):
        print('写真も動画もありませんでした')
        return
    first = sorted(up)[0]
    name = name or os.path.splitext(os.path.basename(first))[0].replace(' ', '_')

    t0 = time.time()
    print('\n■ 人を切り抜いて、そろえています…（初回は切り抜きAIのダウンロードに1分ほど）')
    code, _ = _run([PY, os.path.join(HERE, 'lhm_prep.py'), IN_DIR, PREP_DIR])
    if code != 0:
        print('人を見つけられませんでした')
        return
    views = sorted(glob.glob(os.path.join(PREP_DIR, '*.png')))

    ply = os.path.join(OUT_DIR, f'{name}_lhm.ply')
    # 体の形は1枚目から推定する。1枚目が全身として認められなければ、次の写真を1枚目にしてやり直す
    for attempt in range(len(views)):
        print(f'\n■ {len(views)} 枚から立体人物を作っています（初回はAIのダウンロードに数分）')
        code, log = _run([PY, 'scripts/inference/to_gs_ply.py', '--model_name', MODEL,
                          '--images_dir', PREP_DIR, '--ref_view', str(len(views)), '--output', ply], cwd=ROOT)
        if code == 0 and os.path.exists(ply):
            break
        if 'Input image invalid' in log and attempt + 1 < len(views):
            print('\n1枚目の写真では体の形を読み取れなかったので、写真の順番を変えてやり直します')
            tmp = os.path.join(PREP_DIR, 'tmp.png')
            os.rename(views[0], tmp)
            for a, b in zip(views[1:], views[:-1]):
                os.rename(a, b)
            os.rename(tmp, views[-1])
            continue
        print('\n失敗しました。上に出ている英語のエラー（最後の10行くらい）を教えてください')
        return

    mp4 = ply.replace('.ply', '_turn.mp4')
    print('\n■ 一周回る確認動画を作っています')
    _run([PY, os.path.join(HERE, 'lhm_preview.py'), ply, mp4])
    print(f'\n完了しました（{(time.time() - t0) / 60:.0f}分）')
    _show(name, ply, mp4)
    try:
        files.download(ply)
    except Exception:
        print(f'自動ダウンロードできませんでした：左のフォルダの lhm_out から {os.path.basename(ply)} を右クリックでダウンロード')


def flip_preview(ply):
    """確認動画の人が逆さまだったら、これで作り直す"""
    mp4 = ply.replace('.ply', '_turn.mp4')
    _run([PY, os.path.join(HERE, 'lhm_preview.py'), ply, mp4, '1'])
    _show(os.path.basename(ply), ply, mp4)
