# ai_video_tool.py — 写真1枚から、AI（Wan 2.2）で数秒の動画を作って、背景を消したループ動画にする（Colab用）
#
# 使い方は colab/ai_video_colab.ipynb を開いて上から実行するだけ。
# ・写真はその場でアップロード（Googleドライブにはさわらない）
# ・動きは「ほほえみとまばたき」などから選ぶか、自由に書く（日本語でもOK。英語の方が指示通りになりやすい）
# ・「ループにする」なら、最初と最後のコマを元の写真にして、つなぎ目が分からないようにする
# ・できるもの：〜_ai.mp4（AIが作った動画そのまま）と 〜_ai_loop.webm（背景透明。アプリの「動画」で読み込む）
import os, gc, base64, subprocess, time
import numpy as np
import ipywidgets as W
from IPython.display import display, HTML
from PIL import Image, ImageOps

IN_DIR, OUT_DIR = '/content/ai_in', '/content/ai_out'
IMG_EXT = ('.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp')

MODELS = {
    'small': dict(name='小さめ（TI2V-5B・L4で1本15〜25分くらい）', repo='Wan-AI/Wan2.2-TI2V-5B-Diffusers',
                  area=704 * 1280, frames=121, fps=24, steps=40, cfg=5.0),
    'large': dict(name='大きめ（I2V-A14B・1本30分以上。GPUはA100がおすすめ）', repo='Wan-AI/Wan2.2-I2V-A14B-Diffusers',
                  area=480 * 832, frames=81, fps=16, steps=40, cfg=3.5),
}
PRESETS = [
    ('ほほえみとまばたき', 'The person smiles gently and blinks once. Subtle, natural movement. The head stays almost still. Static camera.'),
    ('うなずく', 'The person nods slightly and smiles warmly. Subtle, natural movement. Static camera.'),
    ('手を振る', 'The person smiles and waves one hand at the camera. Natural movement. Static camera.'),
    ('楽しそうに笑う', 'The person laughs happily, shoulders moving slightly. Natural movement. Static camera.'),
    ('少し首をかしげる', 'The person tilts the head slightly to one side and smiles. Subtle movement. Static camera.'),
]
NEG = ('blurry, low quality, distorted face, changing face, deformed hands, extra fingers, morphing, '
       'flickering, camera movement, zoom, text, watermark')

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

_pipe = None
_key = None


def _load(key, log):
    """AIを読み込む（同じものなら使い回す）"""
    global _pipe, _key
    if _key == key and _pipe is not None:
        return _pipe
    import torch
    from diffusers import WanImageToVideoPipeline, AutoencoderKLWan
    if _pipe is not None:
        _pipe = None
        gc.collect()
        torch.cuda.empty_cache()
    m = MODELS[key]
    log(f'AI「{m["name"]}」を準備中…（初回はダウンロードに10分以上かかることがあります）')
    vae = AutoencoderKLWan.from_pretrained(m['repo'], subfolder='vae', torch_dtype=torch.float32)
    p = WanImageToVideoPipeline.from_pretrained(m['repo'], vae=vae, torch_dtype=torch.bfloat16)
    p.enable_model_cpu_offload()        # GPUのメモリが足りるように、使う部分だけGPUに載せる
    try:
        p.vae.enable_tiling()           # 最後に動画へ戻すところも、少しずつ処理してメモリを節約
    except Exception:
        pass
    _pipe, _key = p, key
    return p


def _size(img, pipe, area):
    """写真の縦横比を保ったまま、AIが扱える大きさにそろえる"""
    mod = pipe.vae_scale_factor_spatial * pipe.transformer.config.patch_size[1]
    ar = img.height / img.width
    h = max(mod, int(round(np.sqrt(area * ar))) // mod * mod)
    w = max(mod, int(round(np.sqrt(area / ar))) // mod * mod)
    return w, h


def _write_mp4(frames, path, fps):
    h, w = frames.shape[1:3]
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}',
                          '-framerate', str(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-crf', '16',
                          '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], stdin=subprocess.PIPE)
    p.stdin.write(np.ascontiguousarray(frames).tobytes())
    p.stdin.close()
    p.wait()


def generate(path, key, prompt, loop, log, box):
    m = MODELS[key]
    t0 = time.time()
    img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    pipe = _load(key, log)
    w, h = _size(img, pipe, m['area'])
    img = img.resize((w, h), Image.LANCZOS)

    # 10ステップごとに進み具合を出す
    def on_step(p, i, t, kwargs):
        if (i + 1) % 10 == 0 or i == 0:
            log(f'  {i + 1} / {m["steps"]} ステップ（{(time.time() - t0) / 60:.0f}分経過）')
        return kwargs

    kw = dict(image=img, prompt=prompt, negative_prompt=NEG, height=h, width=w, num_frames=m['frames'],
              num_inference_steps=m['steps'], guidance_scale=m['cfg'], output_type='np',
              callback_on_step_end=on_step)
    log(f'動画を作っています…（{w}×{h}・{m["frames"] / m["fps"]:.0f}秒。{m["steps"]}ステップ）')
    if loop:
        try:
            frames = pipe(last_image=img, **kw).frames[0]
        except Exception as e:
            log(f'最初と最後を同じ写真にする指定は使えなかったので、普通に作ってからつなぎ目をならします（{e}）')
            frames = pipe(**kw).frames[0]
    else:
        frames = pipe(**kw).frames[0]
    frames = (np.clip(np.asarray(frames), 0, 1) * 255).round().astype(np.uint8)

    stem = os.path.splitext(os.path.basename(path))[0]
    mp4 = os.path.join(OUT_DIR, f'{stem}_ai.mp4')
    _write_mp4(frames, mp4, m['fps'])
    log(f'AIの動画ができました：{mp4}（{(time.time() - t0) / 60:.0f}分）')

    import loop_tool as lt
    log('人物を切り抜いています…')
    a = lt.matte(frames)
    if loop:
        frames, a = lt.loop_blend(frames, a)
    lt.FPS = m['fps']
    out = os.path.join(OUT_DIR, f'{stem}_ai_loop.webm')
    lt.encode(frames, a, out)
    log(f'完了しました：{out}（合計 {(time.time() - t0) / 60:.0f}分）')

    try:
        from google.colab import files
        with box:
            files.download(out)
            files.download(mp4)
        log('ダウンロードを始めました（始まらなければ、左のフォルダの ai_out から右クリックでダウンロード）')
    except Exception as e:
        log(f'自動ダウンロードできませんでした：左のフォルダの ai_out から右クリックでダウンロードしてください（{e}）')
    b64 = base64.b64encode(open(out, 'rb').read()).decode()
    with box:
        display(HTML(
            '<div style="display:inline-block;padding:8px;'
            'background:repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/20px 20px">'
            f'<video src="data:video/webm;base64,{b64}" autoplay loop muted playsinline '
            'style="max-width:480px;max-height:480px;display:block"></video></div>'))


def start():
    os.makedirs(IN_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    from google.colab import files
    try:
        from google.colab import output
        output.enable_custom_widget_manager()
    except Exception:
        pass
    # 人物の切り抜きAIを、先に「信用する」と登録しておく（ボタンから動かすと確認に答えられず止まるため）
    try:
        import torch
        torch.hub.load('PeterL1n/RobustVideoMatting', 'resnet50', trust_repo=True)
    except Exception as e:
        print(f'切り抜きAIの準備で問題がありました（あとでもう一度試します）：{e}')
    print('写真を選んでください（何枚でもOK。前にアップロードした分も残っています）')
    for name, data in files.upload().items():
        with open(os.path.join(IN_DIR, os.path.basename(name)), 'wb') as f:
            f.write(data)
        p = os.path.join('/content', name)
        if os.path.exists(p):
            os.remove(p)
    names = sorted(f for f in os.listdir(IN_DIR) if f.lower().endswith(IMG_EXT))
    if not names:
        print('写真がありません。もう一度実行して選んでください')
        return

    photo = W.Dropdown(options=names, description='写真', layout=W.Layout(width='520px'))
    preview = W.Image(format='jpeg', layout=W.Layout(width='240px'))
    preset = W.Dropdown(options=[(n, p) for n, p in PRESETS] + [('自由に書く', '')],
                        description='動き', layout=W.Layout(width='520px'))
    text = W.Textarea(placeholder='自由に書く場合：例）ほほえんで、一回まばたきする（英語の方が指示通りになりやすい）',
                      layout=W.Layout(width='520px', height='70px'))
    model = W.Dropdown(options=[(v['name'], k) for k, v in MODELS.items()], description='AI',
                       layout=W.Layout(width='520px'))
    loop = W.Checkbox(value=True, description='ループにする（最初と最後を元の写真にする）', indent=False)
    go = W.Button(description='動画を作る', button_style='success', layout=W.Layout(width='200px'))
    box = W.Output()

    def log(msg):
        with box:
            print(msg)

    def on_photo(_=None):
        img = ImageOps.exif_transpose(Image.open(os.path.join(IN_DIR, photo.value))).convert('RGB')
        img.thumbnail((480, 480))
        import io
        b = io.BytesIO()
        img.save(b, 'JPEG', quality=85)
        preview.value = b.getvalue()
    photo.observe(on_photo, 'value')
    on_photo()

    def run(_):
        prompt = text.value.strip() or preset.value or PRESETS[0][1]
        try:
            generate(os.path.join(IN_DIR, photo.value), model.value, prompt, loop.value, log, box)
        except Exception as e:
            log(f'失敗しました：{e}')
    go.on_click(run)
    display(W.VBox([photo, preview, preset, text, model, loop, go, box]))
