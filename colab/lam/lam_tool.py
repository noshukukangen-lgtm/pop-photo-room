# lam_tool.py — 顔写真1枚から、髪まで含めた頭部の立体（3Dガウシアン .ply）を作る（Colab用・LAM）
#   準備は lam_setup.sh（別の Python 3.10 環境に LAM を入れる）。ここではその環境で動かすだけ
#   写真はその場でアップロード（Googleドライブにはさわらない）
#   できるもの：一周回る確認動画、見本の表情で話して動く動画、頭部の立体（〜_lam.ply）
#   あとで全身（LHM++）とつなぐときに使うので、頭部の形（〜_lam_mesh.obj）も一緒に保存する
import os, glob, shutil, subprocess, base64, time

ROOT = '/content/LAM'
PY = '/content/lam_env/bin/python'
IN_DIR = '/content/lam_in'
OUT_DIR = '/content/lam_out'
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = 'model_zoo/lam_models/releases/lam/lam-20k/step_045500/'
CONFIG = 'configs/inference/lam-20k-8gpu.yaml'
MOTION = 'assets/sample_motion/export/Look_In_My_Eyes/'


def _run(cmd, cwd=None):
    """実行しながら、出てきた文字をそのまま表示する"""
    env = dict(os.environ, PATH='/content/lam_env/bin:/usr/local/cuda/bin:' + os.environ['PATH'],
               CUDA_HOME='/usr/local/cuda', PYTHONUNBUFFERED='1', PYTHONPATH=ROOT)
    env.pop('MPLBACKEND', None)
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in p.stdout:
        lines.append(line)
        print(line, end='')
    p.wait()
    return p.returncode, ''.join(lines)


def _video(path, title):
    from IPython.display import display, HTML
    if os.path.exists(path):
        b64 = base64.b64encode(open(path, 'rb').read()).decode()
        display(HTML(f'<p><b>{title}</b></p><video src="data:video/mp4;base64,{b64}" autoplay loop muted playsinline '
                     'style="max-height:420px"></video>'))


def _newest(pattern, since):
    hits = [p for p in glob.glob(pattern, recursive=True) if os.path.getmtime(p) >= since]
    return max(hits, key=os.path.getmtime) if hits else None


def start():
    """顔写真を選んで、1枚ずつ頭部の立体を作る"""
    from google.colab import files
    from PIL import Image, ImageOps
    if not os.path.exists(PY):
        print('先に「1. 準備」のセルを実行してください')
        return
    shutil.rmtree(IN_DIR, ignore_errors=True)
    os.makedirs(IN_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)
    print('顔写真を選んでください（正面向き・顔がはっきり写っているもの。1人ずつ作ります。何枚でもOK）')
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    names = []
    for fn, data in files.upload().items():
        tmp = os.path.join('/content', fn)
        raw = os.path.join(IN_DIR, 'raw_' + os.path.basename(fn))
        with open(raw, 'wb') as f:
            f.write(data)
        if os.path.exists(tmp):
            os.remove(tmp)
        stem = os.path.splitext(os.path.basename(fn))[0].replace(' ', '_')
        img = ImageOps.exif_transpose(Image.open(raw)).convert('RGB')
        img.thumbnail((2048, 2048))
        jpg = os.path.join(IN_DIR, stem + '.jpg')              # LAM は .jpg を読む
        img.save(jpg, quality=95)
        os.remove(raw)
        names.append((stem, jpg))
    if not names:
        print('写真がありません')
        return

    for stem, jpg in names:
        t0 = time.time()
        print(f'\n■ {stem}：顔の形を読み取って、頭部の立体を作っています（初回は部品の準備に数分）')
        _run([PY, '-m', 'lam.launch', 'infer.lam', '--config', CONFIG,
              f'model_name={MODEL}', f'image_input={jpg}', 'export_video=true', 'export_mesh=false',
              f'motion_seqs_dir={MOTION}', 'motion_img_dir=null', 'vis_motion=false', 'motion_img_need_mask=true',
              'render_fps=30', 'motion_video_read_fps=30', 'save_ply=false', 'save_img=true',
              'gaga_track_type=', 'cross_id=false', 'test_sample=false', 'rank=0', 'nodes=0'], cwd=ROOT)
        ply_src = _newest(os.path.join(ROOT, 'exps', 'cano_gs', '*_gs_abs.ply'), t0)
        if not ply_src:
            print(f'\n{stem}：頭部を作れませんでした。顔が見つからなかったか、途中で止まった可能性があります。'
                  '上に出ている英語のエラー（Traceback の下の10行くらい）を教えてください')
            continue
        ply = os.path.join(OUT_DIR, f'{stem}_lam.ply')
        shutil.copy(ply_src, ply)
        off = ply_src.replace('_gs_abs.ply', '_gs_offset.ply')
        if os.path.exists(off):                        # LAMのブラウザ表示用（顔の形からのずれ）も残す
            shutil.copy(off, os.path.join(OUT_DIR, f'{stem}_lam_offset.ply'))
        mesh = ply_src.replace('_gs_abs.ply', '_shaped_mesh.obj')
        if os.path.exists(mesh):
            shutil.copy(mesh, os.path.join(OUT_DIR, f'{stem}_lam_mesh.obj'))
        talk_src = (_newest(os.path.join(ROOT, 'exps', 'videos', '**', '*_audio.mp4'), t0)
                    or _newest(os.path.join(ROOT, 'exps', 'videos', '**', '*.mp4'), t0))
        talk = os.path.join(OUT_DIR, f'{stem}_lam_talk.mp4')
        if talk_src:
            shutil.copy(talk_src, talk)
        turn = os.path.join(OUT_DIR, f'{stem}_lam_turn.mp4')
        print(f'\n■ {stem}：一周回る確認動画を作っています')
        _run([PY, os.path.join(HERE, 'gs_preview.py'), ply, turn, '0', 'rgb'])
        print(f'\n{stem}：完了しました（{(time.time() - t0) / 60:.0f}分）')
        _video(turn, f'{stem}：ぐるっと一周')
        _video(talk, f'{stem}：見本の表情で動かしたもの')
        try:
            files.download(ply)
        except Exception:
            print(f'自動ダウンロードできませんでした：左のフォルダの lam_out から {os.path.basename(ply)} を右クリックでダウンロード')


def flip_preview():
    """一周の動画が逆さま・横倒しだったら、これで上下を逆にして作り直す"""
    for ply in sorted(glob.glob(os.path.join(OUT_DIR, '*_lam.ply'))):
        turn = ply.replace('.ply', '_turn.mp4')
        _run([PY, os.path.join(HERE, 'gs_preview.py'), ply, turn, '1', 'rgb'])
        _video(turn, os.path.basename(ply))
