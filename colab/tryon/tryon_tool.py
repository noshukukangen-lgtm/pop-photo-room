# 着せ替えツール（Colabの中だけで動く。写真は外に出さない）
# 使えるAI: qwen（Qwen-Image-Edit-2511, おすすめ） / kontext（FLUX.1 Kontext dev）
import os, io, zipfile, gc, time
import torch
from PIL import Image, ImageOps

OUT = '/content/tryon_out'
os.makedirs(OUT, exist_ok=True)

# うまくいきやすい指示の例（控えめな変更ほど成功しやすい）
EXAMPLES = {
    'ズボン': 'Change the skirt to slim black trousers. Keep the face, hair, pose, body shape and background exactly the same.',
    'Tシャツ': 'Change the top to a plain fitted white T-shirt. Keep the face, hair, pose, body shape and background exactly the same.',
    '上下ぴったり': 'Change the clothes to a fitted plain T-shirt and slim jeans. Keep the face, hair, pose, body shape and background exactly the same.',
    '上着を脱ぐ': 'Remove the coat, show a fitted plain sweater underneath. Keep everything else exactly the same.',
    '服の写真を着せる': 'Dress the person in image 1 with the clothes shown in image 2. Keep the face, pose, body shape and background of image 1 exactly the same.',
}

# 服の着せ替え以外の指示は受け付けない（家族写真用の安全策）
NG_WORDS = ['nude','naked','bikini','swimsuit','lingerie','underwear','topless','sexy','裸','水着','下着','セクシー']

_pipe = None
_name = None

def _free():
    global _pipe, _name
    _pipe = None; _name = None
    gc.collect(); torch.cuda.empty_cache()

def load(model='qwen'):
    """AIを読み込む。model='qwen' または 'kontext'"""
    global _pipe, _name
    if _name == model:
        return _pipe
    _free()
    t = time.time()
    if model == 'qwen':
        from diffusers import QwenImageEditPlusPipeline
        p = QwenImageEditPlusPipeline.from_pretrained('Qwen/Qwen-Image-Edit-2511', torch_dtype=torch.bfloat16)
        # 8ステップで終わる高速化LoRA（読めなければ通常の40ステップで動く）
        try:
            p.load_lora_weights('lightx2v/Qwen-Image-Edit-2511-Lightning', weight_name='Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors')
            p._fast = True
        except Exception as e:
            print('高速化LoRAは使わずに続けます:', str(e)[:120]); p._fast = False
        p.enable_model_cpu_offload()   # L4(24GB)に収めるため
    elif model == 'kontext':
        from diffusers import FluxKontextPipeline
        p = FluxKontextPipeline.from_pretrained('black-forest-labs/FLUX.1-Kontext-dev', torch_dtype=torch.bfloat16)
        p.enable_model_cpu_offload()
    else:
        raise ValueError('model は qwen か kontext')
    _pipe, _name = p, model
    print(f'{model} の読み込み完了（{time.time()-t:.0f}秒）')
    return p

def _check(prompt):
    low = prompt.lower()
    for w in NG_WORDS:
        if w in low:
            raise ValueError('このツールは服を替える用途だけです（指示に使えない言葉: ' + w + '）')

def _open(path, long_side=1024):
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    s = long_side / max(im.size)
    if s < 1:
        im = im.resize((round(im.width*s/16)*16, round(im.height*s/16)*16), Image.LANCZOS)
    return im

def edit(photo, prompt, model='qwen', clothes=None, seed=0, steps=None):
    """photo: 写真のパス / prompt: 指示（英語推奨。EXAMPLESのキーも使える） / clothes: 服の写真（qwenのみ）"""
    prompt = EXAMPLES.get(prompt, prompt)
    _check(prompt)
    p = load(model)
    im = _open(photo)
    g = torch.Generator('cpu').manual_seed(seed)
    t = time.time()
    if model == 'qwen':
        imgs = [im] + ([_open(clothes)] if clothes else [])
        fast = getattr(p, '_fast', False)
        out = p(image=imgs, prompt=prompt, negative_prompt=' ', true_cfg_scale=1.0 if fast else 4.0,
                num_inference_steps=steps or (8 if fast else 40), generator=g).images[0]
    else:
        if clothes:
            print('Kontextは服の写真を使えないので、文章だけで替えます')
        out = p(image=im, prompt=prompt, guidance_scale=2.5, num_inference_steps=steps or 28,
                width=im.width, height=im.height, generator=g).images[0]
    base = os.path.splitext(os.path.basename(photo))[0]
    path = f'{OUT}/{base}_{model}_s{seed}.png'
    out.save(path)
    print(f'できました: {path}（{time.time()-t:.0f}秒）')
    return path

def compare(photo, prompt, models=('qwen','kontext'), clothes=None, seed=0):
    """同じ写真・同じ指示で複数のAIを試して並べて表示"""
    from IPython.display import display
    paths = []
    for m in models:
        try:
            paths.append(edit(photo, prompt, m, clothes, seed))
        except Exception as e:
            print(m, 'で失敗:', str(e)[:200])
    ims = [_open(photo, 512)] + [_open(x, 512) for x in paths]
    h = max(i.height for i in ims)
    sheet = Image.new('RGB', (sum(i.width for i in ims), h), 'white')
    x = 0
    for i in ims:
        sheet.paste(i, (x, 0)); x += i.width
    display(sheet)
    print('左から: 元の写真, ' + ', '.join(models))
    return paths

def download_all():
    from google.colab import files
    z = '/content/tryon_results.zip'
    with zipfile.ZipFile(z, 'w') as f:
        for n in os.listdir(OUT):
            f.write(f'{OUT}/{n}', n)
    files.download(z)
