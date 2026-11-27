# lhm_tool.py — 写真1枚から、全身の立体人物（3Dガウシアン .ply）を作る（Colab用）
#   準備は lhm_setup.sh（別の Python 3.10 環境に LHM を入れる）。ここではその環境で LHM を動かすだけ
#   写真はその場でアップロード（Googleドライブにはさわらない）。できたものは一周回る確認動画と .ply
import os, glob, shutil, subprocess, base64, time

LHM_DIR = '/content/LHM'
PY = '/content/lhm_env/bin/python'
IN_DIR = '/content/lhm_in'
OUT_DIR = '/content/lhm_out'
HERE = os.path.dirname(os.path.abspath(__file__))
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif')


def _run(cmd, cwd=None):
    """実行しながら、出てきた文字をそのまま表示する"""
    env = dict(os.environ, PATH='/content/lhm_env/bin:/usr/local/cuda/bin:' + os.environ['PATH'],
               CUDA_HOME='/usr/local/cuda', PYTHONUNBUFFERED='1')
    env.pop('PYTHONPATH', None)                     # Colab本体の部品が混ざらないように
    env.pop('MPLBACKEND', None)
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in p.stdout:
        lines.append(line)
        print(line, end='')
    p.wait()
    return p.returncode, ''.join(lines)


def _to_jpg(path):
    """HEICなどはJPEGにしておく（LHMが読めるように）"""
    from PIL import Image, ImageOps
    if path.lower().endswith(('.jpg', '.jpeg', '.png')):
        return path
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    new = os.path.splitext(path)[0] + '.jpg'
    img.save(new, quality=95)
    os.remove(path)
    return new


def start(model='LHM-500M-HF'):
    """写真を選んで、立体人物を作る。model は 'LHM-500M-HF'（標準）か 'LHM-1B-HF'（高品質・メモリぎりぎり）"""
    from google.colab import files
    from IPython.display import display, HTML
    if not os.path.exists(PY):
        print('先に「1. 準備」のセルを実行してください')
        return
    shutil.rmtree(IN_DIR, ignore_errors=True)
    os.makedirs(IN_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)
    print('写真を選んでください（1人が全身か上半身まで写っているもの。何枚でもOK）')
    for name, data in files.upload().items():
        p = os.path.join(IN_DIR, os.path.basename(name).replace(' ', '_'))
        with open(p, 'wb') as f:
            f.write(data)
        tmp = os.path.join('/content', name)
        if os.path.exists(tmp):
            os.remove(tmp)
        _to_jpg(p)
    names = sorted(os.listdir(IN_DIR))
    if not names:
        print('写真がありません')
        return

    t0 = time.time()
    print(f'\n■ {len(names)} 枚から立体人物を作っています（AI：{model}。初回はAIのダウンロードに数分）')
    code, log = _run([PY, '-m', 'LHM.launch', 'infer.human_lrm', f'model_name={model}',
                      f'image_input={IN_DIR}', 'export_mesh=True', 'motion_seqs_dir=None', 'motion_img_dir=None',
                      'vis_motion=true', 'motion_img_need_mask=true'], cwd=LHM_DIR)
    if code != 0:
        print('\n失敗しました。上に出ている英語のエラー（最後の10行くらい）を教えてください')
        return

    made = []
    for n in names:
        uid = n.split('.')[0]
        hits = glob.glob(os.path.join(LHM_DIR, 'exps', 'meshs', '**', f'{uid}.ply'), recursive=True)
        if not hits:
            print(f'\n{n}：立体にできませんでした（1人だけが写っていないか、体の写っている部分が小さすぎる可能性）')
            continue
        ply = os.path.join(OUT_DIR, f'{uid}_lhm.ply')
        shutil.copy(max(hits, key=os.path.getmtime), ply)
        mp4 = ply.replace('.ply', '_turn.mp4')
        print(f'\n■ {n}：一周回る確認動画を作っています（初回は部品の準備に数分）')
        _run([PY, os.path.join(HERE, 'lhm_preview.py'), ply, mp4])
        made.append((n, ply, mp4))

    print(f'\n完了しました（{(time.time() - t0) / 60:.0f}分）')
    for n, ply, mp4 in made:
        if os.path.exists(mp4):
            b64 = base64.b64encode(open(mp4, 'rb').read()).decode()
            display(HTML(f'<p><b>{n}</b>（{os.path.getsize(ply) / 1048576:.0f} MB）</p>'
                         f'<video src="data:video/mp4;base64,{b64}" autoplay loop muted playsinline '
                         'style="max-height:480px"></video>'))
        try:
            files.download(ply)
        except Exception:
            print(f'自動ダウンロードできませんでした：左のフォルダの lhm_out から {os.path.basename(ply)} を右クリックでダウンロード')


def flip_preview(ply):
    """確認動画の人が逆さまだったら、これで作り直す"""
    from IPython.display import display, HTML
    mp4 = ply.replace('.ply', '_turn.mp4')
    _run([PY, os.path.join(HERE, 'lhm_preview.py'), ply, mp4, '1'])
    b64 = base64.b64encode(open(mp4, 'rb').read()).decode()
    display(HTML(f'<video src="data:video/mp4;base64,{b64}" autoplay loop muted playsinline style="max-height:480px"></video>'))
