# pop_tool.py — 写真から、アプリ用の「〜_pop.png」を作る（Colab用）
#   左半分＝写真、右半分＝ 赤:奥行き上位8bit / 緑:奥行き下位8bit / 青:切り抜き
#   切り抜き：BiRefNet_HR、奥行き：Depth-Anything-V2-Large
#
# 使い方（Colabのセルで）:
#   !pip -q install timm kornia einops pillow-heif
#   !curl -sL https://raw.githubusercontent.com/noshukukangen-lgtm/pop-photo-room/main/colab/pop_tool.py -o /content/pop_tool.py
#   import sys, importlib; sys.path.insert(0, '/content'); import pop_tool; importlib.reload(pop_tool); pop_tool.start(upload=True)
#
#   upload=True ：その場で写真をアップロードして、できたものはまとめてzipでダウンロード（Googleドライブにはさわらない）
#   upload=False：マイドライブ/kirinuki/input_images の写真を処理して output_pop に保存
import os, io, zipfile
import numpy as np
from PIL import Image, ImageOps, PngImagePlugin

LONG_SIDE = 3072     # 出力の長辺（大きすぎるとQuestのブラウザがメモリ不足になるので3072に）
MODEL_SIZE = 2048    # 切り抜きAIに入れる大きさ
DEPTH_SIZE = 1022    # 奥行きAIに入れる大きさ（14の倍数）
SKIP_DONE = True     # もうできている写真は飛ばす
IMG_EXT = ('.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp')

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

_cut = _depth = None


def _models():
    global _cut, _depth
    import torch
    from transformers import AutoModelForImageSegmentation, AutoImageProcessor, AutoModelForDepthEstimation
    if _cut is None:
        print('切り抜きAI（BiRefNet_HR）を準備中…')
        _cut = AutoModelForImageSegmentation.from_pretrained('ZhengPeng7/BiRefNet_HR', trust_remote_code=True)
        _cut = _cut.eval().cuda().half()
    if _depth is None:
        print('奥行きAI（Depth-Anything-V2-Large）を準備中…')
        name = 'depth-anything/Depth-Anything-V2-Large-hf'
        _depth = (AutoImageProcessor.from_pretrained(name),
                  AutoModelForDepthEstimation.from_pretrained(name).eval().cuda())
    return _cut, _depth


def _mask(img):
    import torch
    import torchvision.transforms as T
    cut, _ = _models()
    tf = T.Compose([T.Resize((MODEL_SIZE, MODEL_SIZE)), T.ToTensor(),
                    T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x = tf(img).unsqueeze(0).cuda().half()
    with torch.no_grad():
        p = cut(x)[-1].sigmoid()[0, 0].float().cpu().numpy()
    m = Image.fromarray((p * 255).astype(np.uint8)).resize(img.size, Image.BILINEAR)
    return np.asarray(m)


def _depthmap(img):
    import torch
    _, (proc, model) = _models()
    small = img.copy()
    small.thumbnail((DEPTH_SIZE, DEPTH_SIZE))
    inp = proc(images=small, return_tensors='pt', size={'height': DEPTH_SIZE, 'width': DEPTH_SIZE},
               do_resize=False).to('cuda') if False else proc(images=small, return_tensors='pt').to('cuda')
    with torch.no_grad():
        d = model(**inp).predicted_depth
    d = torch.nn.functional.interpolate(d[:, None], size=(img.height, img.width), mode='bicubic',
                                        align_corners=False)[0, 0].cpu().numpy()
    d = (d - d.min()) / max(1e-6, d.max() - d.min())   # 0〜1（大きいほど手前）
    return d


def make_pop(src_path, out_path):
    img = ImageOps.exif_transpose(Image.open(src_path)).convert('RGB')
    img.thumbnail((LONG_SIDE, LONG_SIDE), Image.LANCZOS)
    w, h = img.size
    mask = _mask(img)
    d16 = (_depthmap(img) * 65535).round().astype(np.uint16)
    right = np.dstack([(d16 >> 8).astype(np.uint8), (d16 & 255).astype(np.uint8), mask])
    out = Image.new('RGB', (w * 2, h))
    out.paste(img, (0, 0))
    out.paste(Image.fromarray(right, 'RGB'), (w, 0))
    info = PngImagePlugin.PngInfo()
    info.add_text('Software', 'pop-photo-room')
    out.save(out_path, pnginfo=info, compress_level=6)


def start(upload=False):
    if upload:
        in_dir, out_dir = '/content/pop_in', '/content/pop_out'
        os.makedirs(in_dir, exist_ok=True); os.makedirs(out_dir, exist_ok=True)
        from google.colab import files
        print('写真を選んでください（何枚でもOK）')
        for name, data in files.upload().items():
            with open(os.path.join(in_dir, os.path.basename(name)), 'wb') as f:
                f.write(data)
            p = os.path.join('/content', name)
            if os.path.exists(p):
                os.remove(p)
    else:
        if not os.path.isdir('/content/drive/MyDrive'):
            from google.colab import drive
            drive.mount('/content/drive')
        base = '/content/drive/MyDrive/kirinuki'
        in_dir, out_dir = f'{base}/input_images', f'{base}/output_pop'
        os.makedirs(in_dir, exist_ok=True); os.makedirs(out_dir, exist_ok=True)

    names = sorted(f for f in os.listdir(in_dir) if f.lower().endswith(IMG_EXT))
    if not names:
        print('写真がありません')
        return
    done = []
    for i, n in enumerate(names, 1):
        out = os.path.join(out_dir, os.path.splitext(n)[0] + '_pop.png')
        if SKIP_DONE and os.path.exists(out):
            print(f'[{i}/{len(names)}] {n}：できているので飛ばします'); done.append(out); continue
        try:
            print(f'[{i}/{len(names)}] {n}：処理中…')
            make_pop(os.path.join(in_dir, n), out)
            done.append(out)
        except Exception as e:
            print(f'  失敗しました：{e}')
    print(f'完了：{len(done)} 枚')
    if upload and done:
        z = '/content/pop_out.zip'
        with zipfile.ZipFile(z, 'w') as zf:
            for p in done:
                zf.write(p, os.path.basename(p))
        from google.colab import files
        files.download(z)
        print('zipのダウンロードを始めました（始まらなければ、左のフォルダの pop_out.zip を右クリックでダウンロード）')
