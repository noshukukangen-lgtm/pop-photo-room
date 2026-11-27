# lam_refine.py — LAMで作った頭部を、同じ人の別の写真（横顔・斜め・別の表情）に合うように磨く
#   LAM の環境（/content/lam_env）で、/content/LAM をカレントにして動かす。LAM と同じ引数に加えて、環境変数で指定する
#     REFINE_MAIN  ：LAMの元にする正面写真（.jpg）
#     REFINE_EXTRA ：磨くのに使う写真（.jpg）をカンマ区切りで
#     REFINE_OUT   ：出力先フォルダ。REFINE_NAME：出力の名前。REFINE_ITERS：くり返し回数（既定 800）
#   やること
#     1. どの写真も、LAMに入っている顔の読み取りで「顔の向き・表情・カメラ」を求める
#     2. 正面写真から LAM でいつも通り頭部を作る（ここが出発点）
#     3. 頭部の点（位置・色・大きさ・向き・濃さ）を、すべての写真の見た目に合うように少しずつ動かす
#        写真ごとの顔の向きと表情の読み取りのずれも、一緒に少し直す
#        写っていない所が崩れないよう、出発点から離れすぎないようにおさえる
#     ・くらべるのは「頭のまわりだけ」。肩・手・背景（クッションなど）は頭部の立体では作れないので、
#       そこに合わせようとして点が筋状に引き伸ばされないよう、くらべる範囲から外す
#     ・点の移動は最大5mm、大きさは1.5倍までに制限（筋状に伸びるのを防ぐ）
#     ・写真ごとの明るさ・色合いの違いは、写真ごとの補正で吸収する（顔の色に混ぜない）
#     ・途中（全体の1/3・2/3・最後）の結果も残し、写真｜磨く前｜…と並べて、いちばん良い回を選べる
#     ・髪は動かさず、顔（前から見える肌の部分）だけを磨く。首を傾けると髪の垂れ方が写真ごとに変わり、
#       そこに合わせようとすると髪や頬に筋が出るため。くらべる範囲も顔だけにする
#     ・「磨く前」の時点で顔の向きの読み取りが大きくずれている写真は、自動で使わない
#   できるもの：〜_lam_refined.ply、比べる画像（写真｜磨く前｜磨いた後）、見本の表情で動かした動画
import os, sys, math, time, glob
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

MAIN = os.environ['REFINE_MAIN']
EXTRA = [p for p in os.environ.get('REFINE_EXTRA', '').split(',') if p]
OUT = os.environ['REFINE_OUT']
NAME = os.environ.get('REFINE_NAME', 'head')
ITERS = int(os.environ.get('REFINE_ITERS', '150'))
MOTION = 'assets/sample_motion/export/Look_In_My_Eyes/'
os.makedirs(OUT, exist_ok=True)

from lam.runners.infer.lam import LAMInferrer
from lam.runners.infer.head_utils import preprocess_image, prepare_motion_seqs
from lam.models.rendering.gaussian_model import GaussianModel

inf = LAMInferrer()                      # 引数（--config・model_name など）は LAM と同じものを渡す
model, cfg, dev = inf.model, inf.cfg, 'cuda'
model.to(torch.float32).eval()
for p in model.parameters():
    p.requires_grad_(False)
R = model.renderer


def track(path):
    """顔の読み取り（向き・表情・カメラ）。結果のフォルダを返す。読めなければ None"""
    try:
        assert inf.flametracking.preprocess(path) == 0
        assert inf.flametracking.optimize() == 0
        code, d = inf.flametracking.export()
        assert code == 0
        return d
    except Exception as e:
        print(f'  {os.path.basename(path)}：顔を読み取れなかったので使いません（{e}）')
        return None


print('■ 写真ごとに、顔の向きと表情を読み取っています')
main_dir = track(MAIN)
if main_dir is None:
    sys.exit('正面写真の顔を読み取れませんでした')
img_path = os.path.join(main_dir, 'images/00000_00.png')
mask_path = img_path.replace('/images/', '/fg_masks/')
image, _, _, shape = preprocess_image(img_path, mask_path=mask_path if os.path.exists(mask_path) else None, intr=None,
                                      pad_ratio=0, bg_color=1., max_tgt_size=None, aspect_standard=1.0,
                                      enlarge_ratio=[1.0, 1.0], render_tgt_size=cfg.source_size, multiply=14,
                                      need_mask=True, get_shape_param=True)
dirs = [main_dir] + [d for d in (track(p) for p in EXTRA) if d]
print(f'  使える写真：{len(dirs)} 枚（正面を含む）')


def load_view(d):
    ms = prepare_motion_seqs(d + '/', None, save_root=os.path.join(OUT, 'tmp'), fps=30, bg_color=1.,
                             aspect_standard=1.0, enlarge_ratio=[1.0, 1.0], render_image_res=cfg.render_size,
                             multiply=16, need_mask=True, shape_param=shape)
    intr = ms['render_intrs'][0, 0]
    h, w = int(intr[1, 2] * 2), int(intr[0, 2] * 2)
    rgb = Image.open(os.path.join(d, 'images/00000_00.png')).convert('RGB').resize((w, h), Image.LANCZOS)
    mp = os.path.join(d, 'fg_masks/00000_00.png')
    m = Image.open(mp).convert('L').resize((w, h), Image.BILINEAR) if os.path.exists(mp) else Image.new('L', (w, h), 255)
    rgb = torch.from_numpy(np.asarray(rgb)).float().to(dev) / 255
    m = torch.from_numpy(np.asarray(m)).float().to(dev)[..., None] / 255
    rgb = rgb * m + (1 - m)                                           # 背景は白
    fp = {k: v.to(dev) for k, v in ms['flame_params'].items()}
    return dict(c2w=ms['render_c2ws'].to(dev), intr=ms['render_intrs'].to(dev), bg=ms['render_bg_colors'].to(dev),
                fp=fp, h=h, w=w, rgb=rgb, mask=m)


views = [load_view(d) for d in dirs]
motion = prepare_motion_seqs(MOTION, None, save_root=os.path.join(OUT, 'tmp'), fps=30, bg_color=1.,
                             aspect_standard=1.0, enlarge_ratio=[1.0, 1.0], render_image_res=cfg.render_size,
                             multiply=16, need_mask=True, shape_param=shape)
motion_fp = {k: v.to(dev) for k, v in motion['flame_params'].items()}
# 表情のうち歯の動き（teeth_bs）がない写真には、動きなし（0）を入れる
if 'teeth_bs' in motion_fp:
    for v in views:
        if 'teeth_bs' not in v['fp']:
            v['fp']['teeth_bs'] = torch.zeros_like(motion_fp['teeth_bs'][:, :1])

print('■ 正面写真から、LAMで出発点の頭部を作っています')
with torch.no_grad():
    fp0 = views[0]['fp']
    qp, fp0 = R.get_query_points(fp0, device=torch.device(dev))
    img = image.unsqueeze(0).to(dev)
    latent, feats = model.forward_latent_points(img[:, 0], camera=None, query_points=qp.to(dev))
    from einops import rearrange
    feats_bchw = rearrange(feats, 'b (h w) c -> b c h w', h=int(math.sqrt(feats.shape[1])))
    gs_list, qp, _, _ = R.forward_gs(gs_hidden_features=latent, query_points=qp.to(dev), flame_data=fp0,
                                     additional_features={'image_feats': feats, 'image': img[:, 0], 'image_feats_bchw': feats_bchw})
gs0 = gs_list[0]
xyz0, col0 = gs0.xyz.detach().clone(), gs0.shs.detach().clone()

# 動かすもの：点の位置のずれ・色・濃さ・大きさ・向き ＋ 写真ごとの顔の向き・位置・表情の小さな直し
MAX_MOVE = 0.005                                                    # 点の移動は最大5mm
# 顔の点：顔の形（FLAME）の上で、前を向いた中央の部分（目・鼻・口・頬・あご）。髪や耳・後頭部は動かさない
base = xyz0 - gs0.offset                                            # 点がくっついている顔の形の位置
zmax = base[:, 2].max()
cx = base[:, 0].median()
hsz = (base[:, 1].max() - base[:, 1].min()).clamp_min(1e-6)        # 頭（首まで）の高さ。大きさの単位によらないように比で決める
face = ((base[:, 2] > zmax - 0.28 * hsz) & ((base[:, 0] - cx).abs() < 0.28 * hsz)).float()[:, None]
lum = (col0.reshape(col0.shape[0], -1)[:, :3] * torch.tensor([0.3, 0.59, 0.11], device=dev)).sum(-1, keepdim=True)
face = face * (lum > 0.18).float()                                  # 顔の中でも、暗い前髪は動かさない（眉・目は残る程度に）
print(f'  磨く点：{int(face.sum())} / {face.shape[0]}（顔の部分だけ）')
lsc0 = torch.log(gs0.scaling.detach().clamp_min(1e-8))
d_raw = torch.zeros_like(xyz0, requires_grad=True)
col = col0.clone().requires_grad_(True)
op = torch.logit(gs0.opacity.detach().clamp(1e-4, 1 - 1e-4)).clone().requires_grad_(True)
d_sc = torch.zeros_like(lsc0, requires_grad=True)
rot = gs0.rotation.detach().clone().requires_grad_(True)
fix = [dict(rot=torch.zeros(3, device=dev, requires_grad=True), tr=torch.zeros(3, device=dev, requires_grad=True),
            ex=torch.zeros_like(v['fp']['expr'][0, 0], requires_grad=True),
            gain=torch.ones(3, device=dev, requires_grad=True), bias=torch.zeros(3, device=dev, requires_grad=True))
       for v in views]
opt = torch.optim.Adam([
    dict(params=[d_raw], lr=3e-2), dict(params=[col], lr=2e-3), dict(params=[op], lr=5e-3),
    dict(params=[d_sc], lr=2e-3), dict(params=[rot], lr=5e-4),
    dict(params=[f['rot'] for f in fix] + [f['tr'] for f in fix], lr=1e-3),
    dict(params=[f['ex'] for f in fix], lr=3e-3),
    dict(params=[f['gain'] for f in fix[1:]] + [f['bias'] for f in fix[1:]], lr=3e-3)])


op0 = torch.logit(gs0.opacity.detach().clamp(1e-4, 1 - 1e-4))
rot0 = gs0.rotation.detach()


def model_now():
    d_xyz = MAX_MOVE * torch.tanh(d_raw) * face
    c = col0 + (col - col0) * face.view(-1, *([1] * (col0.dim() - 1)))
    return GaussianModel(xyz=xyz0 + d_xyz, opacity=torch.sigmoid(op0 + (op - op0) * face),
                         rotation=F.normalize(rot0 + (rot - rot0) * face, dim=-1),
                         scaling=torch.exp(lsc0 + d_sc.clamp(-1.0, math.log(1.5)) * face), shs=c.clamp(0, 1),
                         offset=gs0.offset)


def render(gs, v, f=None):
    fp = dict(v['fp'])
    if f is not None:
        fp['rotation'] = fp['rotation'] + f['rot'].view(1, 1, 3)
        fp['translation'] = fp['translation'] + f['tr'].view(1, 1, 3)
        fp['expr'] = fp['expr'] + f['ex'].view(1, 1, -1)
    out = R.forward_animate_gs([gs], qp, R.get_single_view_smpl_data(fp, 0), v['c2w'][:, :1], v['intr'][:, :1],
                               v['h'], v['w'], v['bg'][:, :1])
    return out['comp_rgb'][0, 0].permute(1, 2, 0), out['comp_mask'][0, 0].permute(1, 2, 0)


with torch.no_grad():
    before, regions = [], []
    # 顔の点だけを白く描いた絵を作り、写真ごとの「顔が写っている範囲」にする
    gs_face = GaussianModel(xyz=gs0.xyz, opacity=gs0.opacity, rotation=gs0.rotation, scaling=gs0.scaling,
                            shs=face.expand(-1, 3).reshape(gs0.shs.shape).clone(), offset=gs0.offset)
    for v in views:
        rgb_b, m_b = render(gs0, v)
        before.append(rgb_b.clamp(0, 1))
        fr = render(gs_face, v)[0].mean(-1, keepdim=True)            # 顔の部分ほど白い（背景は白なので、頭の外は除く）
        reg_ = ((fr > 0.7) & (m_b > 0.5)).float()
        reg_ = 1 - F.max_pool2d(1 - reg_.permute(2, 0, 1)[None], 5, stride=1, padding=2)[0].permute(1, 2, 0)   # 少し内側だけ
        regions.append(reg_ * (v['mask'] > 0.5).float())
    # 「磨く前」の時点で顔が大きくずれている写真は使わない（顔の向きの読み取りの失敗）
    errs = [((b - v['rgb']).abs() * R_).sum().item() / (R_.sum().item() * 3 + 1) for b, v, R_ in zip(before, views, regions)]
    keep = [0] + [i for i in range(1, len(views)) if errs[i] < max(0.12, errs[0] * 2.5) and regions[i].sum() > 500]
    for i in range(1, len(views)):
        if i not in keep:
            print(f'  {i + 1}枚目：顔の向きの読み取りが合っていないので使いません（ずれ {errs[i]:.3f}）')
    views = [views[i] for i in keep]
    before = [before[i] for i in keep]
    regions = [regions[i] for i in keep]
fix = [fix[i] for i in keep] if len(fix) != len(views) else fix
SNAPS = sorted({max(1, ITERS // 3), max(1, ITERS * 2 // 3), ITERS})
snaps = {}

print(f'■ {len(views)} 枚の写真に合うように磨いています（{ITERS} 回）')
t0 = time.time()
for it in range(ITERS):
    opt.zero_grad()
    loss = 0
    gs_now = model_now()
    for i, (v, f) in enumerate(zip(views, fix)):
        rgb, m = render(gs_now, v, f)
        if i > 0:                                                     # 写真ごとの明るさ・色合いの違いを吸収
            rgb = rgb * f['gain'] + f['bias']
        R_ = regions[i]
        wv = 3.0 if i == 0 else 1.0                                   # 正面写真は重く（正面の見た目を崩さない）
        l_rgb = ((rgb - v['rgb']).abs() * R_).sum() / (R_.sum() * 3 + 1)
        # 細かい模様（目・鼻すじ・口元）が合うように、少しぼかした画像同士でもくらべる
        Rp = F.avg_pool2d(R_.permute(2, 0, 1)[None], 4)
        l_lo = ((F.avg_pool2d(rgb.permute(2, 0, 1)[None], 4) - F.avg_pool2d(v['rgb'].permute(2, 0, 1)[None], 4)).abs()
                * Rp).sum() / (Rp.sum() * 3 + 1)
        loss = loss + wv * (l_rgb + 0.5 * l_lo)
    loss = loss / (len(views) + 2)
    # 写っていない所が崩れないように、出発点から離れすぎないようにする
    reg = 0.02 * ((col - col0) ** 2).mean() + 1e-3 * (d_raw ** 2).mean() \
        + 1e-3 * sum((f['ex'] ** 2).mean() + 10 * (f['rot'] ** 2).sum() + 10 * (f['tr'] ** 2).sum()
                     + ((f['gain'] - 1) ** 2).sum() + (f['bias'] ** 2).sum() for f in fix)
    (loss + reg).backward()
    opt.step()
    if it % 100 == 0 or it == ITERS - 1:
        print(f'  {it + 1} / {ITERS}：写真とのずれ {loss.item():.4f}（{time.time() - t0:.0f}秒）')
    if it + 1 in SNAPS:                                               # 途中の結果を残す
        with torch.no_grad():
            g = model_now()
            snaps[it + 1] = (GaussianModel(xyz=g.xyz.detach().clone(), opacity=g.opacity.detach().clone(),
                                           rotation=g.rotation.detach().clone(), scaling=g.scaling.detach().clone(),
                                           shs=g.shs.detach().clone(), offset=gs0.offset),
                             [render(g, v, f)[0].clamp(0, 1) for v, f in zip(views, fix)])

with torch.no_grad():
    # 写真｜磨く前｜100回｜200回｜…（1行目が正面写真）
    rows = [torch.cat([v['rgb'], before[i]] + [snaps[k][1][i] for k in SNAPS], 1) for i, v in enumerate(views)]
    grid = (torch.cat(rows, 0).cpu().numpy() * 255).astype(np.uint8)
    Image.fromarray(grid).save(os.path.join(OUT, f'{NAME}_compare.jpg'), quality=90)
    with open(os.path.join(OUT, f'{NAME}_compare.txt'), 'w') as fh:
        fh.write('写真｜磨く前｜' + '｜'.join(f'{k}回' for k in SNAPS))
    for k in SNAPS:
        g = snaps[k][0]
        g.save_ply(os.path.join(OUT, f'{NAME}_lam_refined_{k}.ply'), rgb2sh=False, offset2xyz=False)
    gs0.save_ply(os.path.join(OUT, f'{NAME}_lam_before.ply'), rgb2sh=False, offset2xyz=False)
    final = snaps[SNAPS[-1]][0]
    final.save_ply(os.path.join(OUT, f'{NAME}_lam_refined.ply'), rgb2sh=False, offset2xyz=False)
    off = final.offset
    final.offset = final.xyz - (xyz0 - gs0.offset)                     # 顔の形からのずれ（LAMのブラウザ表示用）
    final.save_ply(os.path.join(OUT, f'{NAME}_lam_refined_offset.ply'), rgb2sh=False, offset2xyz=True)
    final.offset = off

    print('■ 見本の表情で動かした動画を作っています')
    import imageio
    frames = []
    n = motion['render_c2ws'].shape[1]
    intr = motion['render_intrs'][0, 0]
    h, w = int(intr[1, 2] * 2), int(intr[0, 2] * 2)
    for k in range(n):
        out = R.forward_animate_gs([final], qp, R.get_single_view_smpl_data(motion_fp, k),
                                   motion['render_c2ws'][:, k:k + 1].to(dev), motion['render_intrs'][:, k:k + 1].to(dev),
                                   h, w, motion['render_bg_colors'][:, k:k + 1].to(dev))
        frames.append((out['comp_rgb'][0, 0].permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    imageio.mimwrite(os.path.join(OUT, f'{NAME}_lam_refined_talk.mp4'), frames, fps=30, quality=8)
print('完了')
