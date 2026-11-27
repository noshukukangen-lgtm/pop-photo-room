# lora_tool.py — 写真からLoRAを学習して、その人らしい（または架空の）人物の新しい画像を作る（Colab用）
#   写真はその場でZIPをアップロード（Googleドライブにはつながない）。人分けはNAS側で済んでいる前提
#   使い方は2つ
#     mode='person'  ：特定の人。呼び名（例 'rin'）をつけて顔をしっかり覚えさせる
#     mode='concept' ：架空の人物。いろんな人の共通点（雰囲気）だけを覚えさせ、誰か一人に似すぎないようにする
#   流れ：prepare()で写真を選ぶ → caption()で説明文をつける → train()で学習 → generate()で試しに作る
import os, io, re, json, glob, shutil, zipfile, subprocess, time, random

WORK = '/content/lora_work'
RAW = f'{WORK}/raw'
DATA = f'{WORK}/dataset'
OUT = f'{WORK}/output'
TOOLKIT = '/content/ai-toolkit'

BASES = {
    # 土台のAI。qwen＝アジア系の顔に強い（おすすめ）、flux＝写真の質感に強い（Hugging Faceで利用規約の同意が必要）
    'qwen': dict(name='Qwen/Qwen-Image', arch='qwen_image'),
    'flux': dict(name='black-forest-labs/FLUX.1-dev', arch='flux'),
}

# 実在の人を露出の多い姿にする指示は、作るときに受け付けない（子どものときは必ず。大人も本人の了解がないときは使わない）
NG_ALWAYS = ['nude', 'naked', 'topless', 'lingerie', 'underwear', 'sexy', 'erotic', '裸', '下着', 'セクシー']
NG_CHILD = ['bikini', 'swimsuit', 'swimwear', '水着']

_state_file = f'{WORK}/state.json'


def _state(**kw):
    s = json.load(open(_state_file)) if os.path.exists(_state_file) else {}
    s.update(kw)
    os.makedirs(WORK, exist_ok=True)
    json.dump(s, open(_state_file, 'w'), ensure_ascii=False)
    return s


def setup():
    """学習の部品（ai-toolkit）と、写真選び・説明文用の部品を入れる（初回10分前後）"""
    if not os.path.exists(TOOLKIT):
        subprocess.run(['git', 'clone', '-q', '--depth', '1', 'https://github.com/ostris/ai-toolkit.git', TOOLKIT], check=True)
    subprocess.run(f'cd {TOOLKIT} && pip -q install -r requirements.txt', shell=True, check=True)
    subprocess.run('pip -q install -U imagehash opencv-python-headless pillow-heif "transformers>=4.49" accelerate qwen-vl-utils '
                   'git+https://github.com/huggingface/diffusers peft', shell=True, check=True)
    print('準備ができました')


# ---------- 1. 写真を選ぶ ----------

def _open(path):
    from PIL import Image, ImageOps
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    return ImageOps.exif_transpose(Image.open(path)).convert('RGB')


def _sharpness(img):
    import cv2, numpy as np
    g = cv2.cvtColor(np.asarray(img.resize((512, int(512 * img.height / img.width)))), cv2.COLOR_RGB2GRAY)
    return cv2.Laplacian(g, cv2.CV_64F).var()


def prepare(name, mode='person', max_photos=None, min_side=768, blur_cut=60, near_dup=6):
    """写真のZIP（または写真そのもの）をアップロードして、学習に向いたものを自動で選ぶ
    name: 呼び名（英数字。例 'rin' / 'ojisan'） mode: 'person' か 'concept'
    外すもの：小さすぎる写真、ぼやけた写真、ほぼ同じ写真の2枚目以降"""
    from google.colab import files
    import imagehash
    assert re.fullmatch(r'[A-Za-z0-9_]+', name), '呼び名は英数字で（例 rin）'
    assert mode in ('person', 'concept')
    shutil.rmtree(RAW, ignore_errors=True)
    shutil.rmtree(DATA, ignore_errors=True)
    os.makedirs(RAW)
    os.makedirs(DATA)
    print('写真をまとめたZIP（または写真）を選んでください。大きいZIPは数分かかります')
    for fn, data in files.upload().items():
        tmp = os.path.join('/content', fn)
        if fn.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                z.extractall(RAW)
        else:
            open(os.path.join(RAW, os.path.basename(fn)), 'wb').write(data)
        if os.path.exists(tmp):
            os.remove(tmp)
    paths = [p for p in glob.glob(f'{RAW}/**/*', recursive=True)
             if p.lower().endswith(('.jpg', '.jpeg', '.png', '.heic', '.webp')) and '__MACOSX' not in p]
    print(f'写真 {len(paths)} 枚を調べています')
    cands, small, blur = [], 0, 0
    for p in paths:
        try:
            img = _open(p)
        except Exception:
            continue
        if min(img.size) < min_side:
            small += 1
            continue
        s = _sharpness(img)
        if s < blur_cut:
            blur += 1
            continue
        cands.append((s, p, imagehash.phash(img)))
    cands.sort(key=lambda x: -x[0])          # くっきりした順
    kept, dup = [], 0
    for s, p, h in cands:
        if any(h - kh <= near_dup for _, _, kh in kept):
            dup += 1
            continue
        kept.append((s, p, h))
    if max_photos is None:
        max_photos = 40 if mode == 'person' else 150
    random.seed(0)
    if len(kept) > max_photos:
        kept = random.sample(kept, max_photos)  # 日付や場面がばらけるように、上位からではなくまんべんなく選ぶ
    for i, (s, p, h) in enumerate(kept):
        img = _open(p)
        img.thumbnail((1536, 1536))
        img.save(f'{DATA}/{name}_{i:03d}.jpg', quality=95)
    print(f'選んだ写真：{len(kept)} 枚（外したもの：小さい {small}・ぼやけ {blur}・ほぼ同じ {dup}）')
    if mode == 'person' and len(kept) < 15:
        print('写真が少なめです。20枚以上あると本人らしさが安定します')
    if mode == 'concept' and len(kept) < 50:
        print('架空の人物には、いろんな人の写真が50枚以上あると誰か一人に似にくくなります')
    _state(name=name, mode=mode, count=len(kept))
    show()


def show(cols=8):
    """選んだ写真を一覧で表示（外したい写真は remove([番号, ...]) で）"""
    from PIL import Image, ImageDraw
    from IPython.display import display
    ps = sorted(glob.glob(f'{DATA}/*.jpg'))
    if not ps:
        print('写真がありません')
        return
    t = 160
    rows = (len(ps) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * t, rows * t), 'white')
    d = ImageDraw.Draw(sheet)
    for i, p in enumerate(ps):
        im = Image.open(p)
        im.thumbnail((t, t))
        x, y = (i % cols) * t, (i // cols) * t
        sheet.paste(im, (x, y))
        d.rectangle([x, y, x + 34, y + 18], fill='black')
        d.text((x + 3, y + 3), str(int(re.findall(r'_(\d+)\.jpg', p)[0])), fill='white')
    display(sheet)
    print(f'{len(ps)} 枚。外したい写真があれば T.remove([番号, 番号]) を実行')


def remove(nums):
    for n in nums:
        for p in glob.glob(f'{DATA}/*_{int(n):03d}.*'):
            os.remove(p)
    print(f'{len(nums)} 枚外しました。残り {len(glob.glob(DATA + "/*.jpg"))} 枚')


# ---------- 2. 説明文をつける ----------

def caption():
    """写真ごとに説明文をAI（Qwen2.5-VL）でつける
    person ：服・場所・ポーズだけを書き、顔だちは書かない → 顔は呼び名に結びつく
    concept：服・場所に加えて、一人ひとり違う点（髪型・眼鏡など）も書く → 個人の特徴は覚えず、共通の雰囲気だけが呼び名に残る"""
    import torch
    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
    s = _state()
    name, mode = s['name'], s['mode']
    mid = 'Qwen/Qwen2.5-VL-7B-Instruct'
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(mid, torch_dtype=torch.bfloat16, device_map='cuda')
    proc = AutoProcessor.from_pretrained(mid, max_pixels=768 * 768)
    if mode == 'person':
        ask = ('Describe this photo in one English sentence for image-model training. Refer to the main person only as "the person". '
               'Describe clothing, pose, expression, setting, lighting and camera angle. Do NOT describe face shape, eyes, nose, '
               'skin, ethnicity, age or hair color.')
    else:
        ask = ('Describe this photo in one English sentence for image-model training. Refer to the main person only as "the man" or "the woman". '
               'Describe clothing, pose, expression, setting, lighting, camera angle, and any individual traits such as hairstyle, '
               'glasses, beard or accessories.')
    ps = sorted(glob.glob(f'{DATA}/*.jpg'))
    for i, p in enumerate(ps):
        msgs = [{'role': 'user', 'content': [{'type': 'image', 'image': p}, {'type': 'text', 'text': ask}]}]
        text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        from qwen_vl_utils import process_vision_info
        imgs, vids = process_vision_info(msgs)
        inp = proc(text=[text], images=imgs, videos=vids, return_tensors='pt').to('cuda')
        out = model.generate(**inp, max_new_tokens=90, do_sample=False)
        cap = proc.batch_decode(out[:, inp.input_ids.shape[1]:], skip_special_tokens=True)[0].strip()
        cap = re.sub(r'\bthe (person|man|woman)\b', name, cap, count=1, flags=re.I)
        if name not in cap:
            cap = f'{name}, {cap}'
        open(p[:-4] + '.txt', 'w').write(cap)
        if i < 5:
            print(os.path.basename(p), '→', cap)
    del model
    torch.cuda.empty_cache()
    print(f'{len(ps)} 枚に説明文をつけました（気になるものは dataset フォルダの .txt を直してOK）')


# ---------- 3. 学習する ----------

def train(base='qwen', steps=None, rank=16, adult=False, samples=None):
    """LoRAを学習する。L4で1〜2時間ほど（写真の枚数と回数で変わる）
    steps：学習の回数。指定しなければ枚数から決める（少ない写真を何度も回すと覚えすぎになるので控えめ）
    rank：どれだけ細かく調整できるか。大きいほどファイルも大きくなる（16で数十MB）
    adult：大人で、本人の了解があるときだけ True（作るときの服装の制限が少しゆるくなる）"""
    import yaml
    s = _state()
    name, mode, n = s['name'], s['mode'], len(glob.glob(f'{DATA}/*.jpg'))
    assert glob.glob(f'{DATA}/*.txt'), '先に caption() を実行してください'
    if steps is None:
        steps = min(3000, max(1200, n * 60)) if mode == 'person' else min(4000, max(2000, n * 15))
    b = BASES[base]
    if samples is None:
        samples = [f'{name} smiling at a park in autumn, natural light, photo',
                   f'{name} wearing a casual sweater at home, sitting on a sofa, photo',
                   f'{name} in a traditional Japanese yukata at a summer festival at night, photo']
    cfg = {'job': 'extension', 'config': {'name': name, 'process': [{
        'type': 'sd_trainer', 'training_folder': OUT, 'device': 'cuda:0', 'trigger_word': name,
        'network': {'type': 'lora', 'linear': rank, 'linear_alpha': rank},
        'save': {'dtype': 'float16', 'save_every': 500, 'max_step_saves_to_keep': 3},
        'datasets': [{'folder_path': DATA, 'caption_ext': 'txt', 'caption_dropout_rate': 0.05,
                      'cache_latents_to_disk': True, 'resolution': [512, 768, 1024]}],
        'train': {'batch_size': 1, 'steps': steps, 'gradient_accumulation_steps': 1, 'train_unet': True,
                  'train_text_encoder': False, 'gradient_checkpointing': True, 'noise_scheduler': 'flowmatch',
                  'optimizer': 'adamw8bit', 'lr': 1e-4 if mode == 'person' else 8e-5, 'dtype': 'bf16',
                  'ema_config': {'use_ema': True, 'ema_decay': 0.99}},
        'model': {'name_or_path': b['name'], 'arch': b['arch'], 'quantize': True, 'quantize_te': True, 'low_vram': True},
        'sample': {'sampler': 'flowmatch', 'sample_every': 500, 'width': 768, 'height': 1024, 'prompts': samples,
                   'seed': 42, 'walk_seed': True, 'guidance_scale': 3.5 if base == 'flux' else 4.0, 'sample_steps': 25},
    }]}}
    os.makedirs(OUT, exist_ok=True)
    path = f'{WORK}/{name}.yaml'
    yaml.safe_dump(cfg, open(path, 'w'), allow_unicode=True, sort_keys=False)
    _state(base=base, adult=bool(adult), steps=steps)
    print(f'学習を始めます：土台 {base}・写真 {n} 枚・{steps} 回（500回ごとに試しの画像を作ります）')
    t0 = time.time()
    p = subprocess.Popen(['python', 'run.py', path], cwd=TOOLKIT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        if any(k in line for k in ('step', 'Error', 'error', 'Traceback', 'Saving', 'sample')) or line.startswith(' '):
            print(line, end='')
    p.wait()
    if p.returncode != 0:
        print('\n学習が止まりました。上の英語のエラー（Traceback の下10行くらい）を教えてください')
        return
    print(f'\n学習が終わりました（{(time.time() - t0) / 60:.0f}分）')
    progress()


def progress():
    """学習の途中で作った試しの画像を、回数ごとに並べて表示（覚えすぎになっていないかの確認用）"""
    from IPython.display import display, Image as IPImage
    s = _state()
    ps = sorted(glob.glob(f'{OUT}/{s["name"]}/samples/*.jpg'))
    for p in ps[-9:]:
        print(os.path.basename(p))
        display(IPImage(filename=p, width=240))
    print('回数が進むほど本人に似ていきます。後半で服や背景まで学習写真そっくりになったら、覚えすぎのサインです')


def lora_files():
    s = _state()
    return sorted(glob.glob(f'{OUT}/{s["name"]}/*.safetensors'), key=os.path.getmtime)


# ---------- 4. 試しに作る ----------

_pipe = None


def _check(prompt, adult):
    low = prompt.lower()
    for w in NG_ALWAYS + ([] if adult else NG_CHILD):
        if w in low:
            raise ValueError(f'この指示には使えない言葉が入っています：{w}')


def generate(prompt, n=4, lora=None, strength=1.0, seed=0, width=768, height=1024):
    """学習したLoRAで画像を作る。prompt に呼び名を入れる（例 'rin wearing a kimono at a shrine, photo'）
    lora：使うファイル。指定しなければ最後にできたもの。覚えすぎなら途中のファイル（lora_files() で一覧）を使う
    strength：LoRAの効きの強さ。顔が弱ければ 1.1、絵が崩れるなら 0.8 など"""
    global _pipe
    import torch
    from IPython.display import display
    s = _state()
    _check(prompt, s.get('adult', False))
    if s['name'] not in prompt:
        print(f'指示に呼び名「{s["name"]}」が入っていないので、先頭に足します')
        prompt = f'{s["name"]}, {prompt}'
    lora = lora or (lora_files() or [None])[-1]
    assert lora, '学習したファイルがありません'
    if _pipe is None:
        from diffusers import DiffusionPipeline
        _pipe = DiffusionPipeline.from_pretrained(BASES[s.get('base', 'qwen')]['name'], torch_dtype=torch.bfloat16)
        _pipe.enable_model_cpu_offload()
        _pipe._lora = None
    if _pipe._lora != lora:
        _pipe.unload_lora_weights()
        _pipe.load_lora_weights(lora, adapter_name='me')
        _pipe._lora = lora
    _pipe.set_adapters(['me'], adapter_weights=[strength])
    os.makedirs(f'{WORK}/generated', exist_ok=True)
    outs = []
    for i in range(n):
        g = torch.Generator('cpu').manual_seed(seed + i)
        kw = dict(prompt=prompt, width=width, height=height, num_inference_steps=30, generator=g)
        if s.get('base', 'qwen') == 'qwen':
            kw.update(negative_prompt=' ', true_cfg_scale=4.0)
        else:
            kw.update(guidance_scale=3.5)
        img = _pipe(**kw).images[0]
        path = f'{WORK}/generated/{s["name"]}_{int(time.time())}_{i}.png'
        img.save(path)
        outs.append(path)
        img.thumbnail((360, 480))
        display(img)
    return outs


def download():
    """学習したファイル（.safetensors）と作った画像をZIPでダウンロード"""
    from google.colab import files
    s = _state()
    z = f'/content/{s["name"]}_lora.zip'
    with zipfile.ZipFile(z, 'w') as f:
        for p in lora_files()[-1:]:
            f.write(p, os.path.basename(p))
        for p in glob.glob(f'{WORK}/generated/*.png'):
            f.write(p, 'generated/' + os.path.basename(p))
    files.download(z)
