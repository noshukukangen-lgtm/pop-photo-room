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


def _latest():
    plys = [p for p in glob.glob(os.path.join(OUT_DIR, '*_lhm.ply'))]
    return max(plys, key=os.path.getmtime) if plys else None


def symmetrize(ply=None):
    """横向きの写真で、片側の色がおかしいとき：よく写っている側の色を反対側へ写して、左右対称にする
       形はそのまま、色だけ変える。どちらの側が良いか分からないので A・B の2通り作って見比べる"""
    ply = ply or _latest()
    if not ply:
        print('先に「立体人物を作る」を実行してください')
        return
    a, b = ply.replace('.ply', '_symA.ply'), ply.replace('.ply', '_symB.ply')
    print('■ 左右対称にしています…')
    code, _ = _run([PY, os.path.join(HERE, 'lhm_sym.py'), ply, a, b])
    if code != 0:
        print('失敗しました。上に出ている英語のエラーを教えてください')
        return
    for label, p in (('A', a), ('B', b)):
        mp4 = p.replace('.ply', '_turn.mp4')
        print(f'\n■ {label} の確認動画を作っています')
        _run([PY, os.path.join(HERE, 'lhm_preview.py'), p, mp4])
        _show(f'{label}：{os.path.basename(p)}', p, mp4)
    print('\n良い方を選んで保存：lhm_tool.pick_sym("A") か lhm_tool.pick_sym("B")')
    print('（体の模様・かばん・髪の分け目など、左右で違うものも鏡写しになります）')


def pick_sym(which, ply=None):
    """symmetrize で作った A か B をダウンロードする"""
    from google.colab import files
    ply = ply or _latest()
    p = ply.replace('.ply', f'_sym{which.upper()}.ply')
    if not os.path.exists(p):
        print('先に lhm_tool.symmetrize() を実行してください')
        return
    open(os.path.join(OUT_DIR, '.chosen'), 'w').write(p)     # 頭部をつなぐときに、これを使う
    try:
        files.download(p)
    except Exception:
        print(f'自動ダウンロードできませんでした：左のフォルダの lhm_out から {os.path.basename(p)} を右クリックでダウンロード')


LAM_OUT = '/content/lam_out'


def _upload_one(msg, ext='.ply'):
    from google.colab import files
    print(msg)
    up = files.upload()
    for fn, data in up.items():
        tmp = os.path.join('/content', fn)
        if os.path.exists(tmp):
            os.remove(tmp)
        if fn.lower().endswith(ext):
            os.makedirs(OUT_DIR, exist_ok=True)
            p = os.path.join(OUT_DIR, os.path.basename(fn).replace(' ', '_'))
            with open(p, 'wb') as f:
                f.write(data)
            return p
    return None


def join(head=None, body=None, scale=1.0, up=0, fwd=0, turn=0, cut=0):
    """全身（LHM++）の頭を、LAM の頭部に取り替えて、1人の立体人物にする
       head：頭部の番号か .ply の場所（省略すると lam_out から選ぶ）
       body：全身の .ply か、左右対称の "A"・"B"（省略すると pick_sym で選んだもの）
       うまく合わないときの調整：scale＝頭の大きさの倍率（1.1 で 1割大きく）、up＝頭を上げる cm（マイナスで下げる）、
       fwd＝頭を前に出す cm（マイナスで後ろ）、turn＝頭の向きを回す角度（後ろを向いていたら 180）、
       cut＝元の頭を消す高さを下げる cm（元のあご・髪が残るとき）"""
    from google.colab import files
    # 全身：左右対称で選んだもの → 最後に作ったもの → アップロード（body="A" / "B" で左右対称のどちらかを指定）
    if isinstance(body, str) and body.upper() in ('A', 'B') and _latest():
        body = _latest().replace('.ply', f'_sym{body.upper()}.ply')
    if body is None:
        c = os.path.join(OUT_DIR, '.chosen')
        body = open(c).read().strip() if os.path.exists(c) else None
        if not body or not os.path.exists(body):
            body = _latest()
    if not body:
        body = _upload_one('全身の .ply（LHM++ で作ったもの）を選んでください')
        if not body:
            return
    # 頭部：lam_out にあるもの（1つならそれ、複数なら番号で選ぶ）→ アップロード
    heads = sorted(glob.glob(os.path.join(LAM_OUT, '*_lam*.ply')), key=os.path.getmtime)
    heads = [h for h in heads if not h.endswith(('_offset.ply', '_before.ply'))]
    if isinstance(head, int):
        if not 1 <= head <= len(heads):
            print(f'頭部の番号は 1〜{len(heads)} です')
            return
        head = heads[head - 1]
    if head is None:
        if len(heads) == 1:
            head = heads[0]
        elif len(heads) > 1:
            print('頭部が複数あります。番号を選んで、もう一度実行してください（例：lhm_tool.join(head=1)）')
            for i, h in enumerate(heads, 1):
                print(f'  {i}：{os.path.basename(h)}')
            return
        else:
            head = _upload_one('頭部の .ply（LAM で作った「〜_lam.ply」）を選んでください')
            if not head:
                return
    name = os.path.splitext(os.path.basename(body))[0]
    hname = os.path.splitext(os.path.basename(head))[0]
    out = os.path.join(OUT_DIR, f'{name}__{hname}_joined.ply')
    print(f'全身：{os.path.basename(body)}\n頭部：{os.path.basename(head)}\n\n■ つないでいます…')
    code, _ = _run([PY, os.path.join(HERE, 'lhm_join.py'), body, head, out,
                    f'scale={scale}', f'up={up}', f'fwd={fwd}', f'turn={turn}', f'cut={cut}'])
    if code != 0 or not os.path.exists(out):
        print('失敗しました。上に出ている英語のエラーを教えてください')
        return
    for zoom, label in (('head', '頭のアップ'), ('body', '全身')):
        mp4 = out.replace('.ply', f'_{zoom}.mp4')
        print(f'\n■ 確認動画（{label}）を作っています')
        _run([PY, os.path.join(HERE, 'lhm_preview.py'), out, mp4, 'auto', zoom])
        _show(f'{label}：{os.path.basename(out)}', out, mp4)
    print('\nずれていたら、数字を変えてやり直せます（例）：')
    print(f'  lhm_tool.join(head={heads.index(head) + 1 if head in heads else repr(head)}, up=2, fwd=-1, scale=1.05)')
    print('  up＝頭を上げる cm ／ fwd＝前に出す cm ／ scale＝大きさ ／ turn＝向き（後ろ向きなら 180）／ cut＝元のあご・髪が残るとき、消す高さを下げる cm')
    try:
        files.download(out)
    except Exception:
        print(f'自動ダウンロードできませんでした：左のフォルダの lhm_out から {os.path.basename(out)} を右クリックでダウンロード')


def flip_preview(ply):
    """確認動画の人が逆さまだったら、これで作り直す"""
    mp4 = ply.replace('.ply', '_turn.mp4')
    _run([PY, os.path.join(HERE, 'lhm_preview.py'), ply, mp4, '1'])
    _show(os.path.basename(ply), ply, mp4)
