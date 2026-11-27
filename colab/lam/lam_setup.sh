#!/bin/bash
# lam_setup.sh — 顔写真1枚から、髪まで含めた頭部の立体（3Dガウシアン）を作るAI「LAM」を、Colabで動くように準備する
#   LAM は Python 3.10・PyTorch 2.3 向けなので、Colab本体とは別の環境（/content/lam_env）を作って入れる
#   （全身用の LHM++ とは必要な部品の版が違うので、環境も分けておく）
#   一度終わった段階には印（/content/lam_env/.ok_*）が残り、同じセッションで再実行すると飛ばす。初回は 15〜30分ほど
set -e
cd /content
step(){ echo; echo "■ $1"; }
done_(){ [ -f "/content/lam_env/.ok_$1" ]; }
mark(){ touch "/content/lam_env/.ok_$1"; }

nvidia-smi -L || { echo 'GPUがありません。ランタイムのタイプで L4 を選んでください'; exit 1; }

if [ ! -d /content/LAM ]; then
  step 'LAM 本体をダウンロード'
  git clone -q --depth 1 https://github.com/aigc3d/LAM.git /content/LAM
fi

# 頭部の立体を「位置そのもの」でも保存するように1行足す（元は顔の形からのずれだけを保存している）
python3 - <<'PYEOF'
p = '/content/LAM/lam/runners/infer/lam.py'
s = open(p).read()
key = "res['cano_gs_lst'][0].save_ply(cano_ply_pth, rgb2sh=False, offset2xyz=True)\n"
add = "            res['cano_gs_lst'][0].save_ply(cano_ply_pth.replace('_gs_offset.ply', '_gs_abs.ply'), rgb2sh=False, offset2xyz=False)\n"
if key in s and add not in s:
    s = s.replace(key, key + add, 1)
    open(p, 'w').write(s)
    print('頭部の保存方法を追加しました')
PYEOF

if [ ! -x /content/lam_env/bin/python ]; then
  step 'Python 3.10 の環境を作成'
  pip -q install uv
  uv venv -q --seed --python 3.10 /content/lam_env
fi
PY=/content/lam_env/bin/python
PIP="$PY -m pip install -q"
export PATH=/content/lam_env/bin:/usr/local/cuda/bin:$PATH
export CUDA_HOME=/usr/local/cuda
export FORCE_CUDA=1
export TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9"   # A100・L4 など
export MAX_JOBS=8

# GPU向けの部品を、ソースを手元に置いてから組み立てる。失敗したら原因が分かるように記録の最後を表示する
build(){
  local name=$1 url=$2 d=/content/build_$1
  [ -d "$d" ] || git clone -q --recursive "$url" "$d"
  case $name in
    simple-knn) grep -q '<cfloat>' "$d/simple_knn.cu" || sed -i '1i #include <cfloat>' "$d/simple_knn.cu" ;;
    diff-gauss) grep -q '<cstdint>' "$d/cuda_rasterizer/rasterizer_impl.h" || sed -i '1i #include <cstdint>' "$d/cuda_rasterizer/rasterizer_impl.h" ;;
  esac
  if ! $PY -m pip install --no-build-isolation -v "$d" > "/content/build_$name.log" 2>&1; then
    echo "「$name」の組み立てに失敗しました。記録の最後："
    grep -iE 'error|nvcc fatal|unsupported' "/content/build_$name.log" | grep -v 'Werror' | tail -15
    echo '----'
    tail -25 "/content/build_$name.log"
    exit 1
  fi
}
echo "（組み立ての道具：$(nvcc --version | tail -1) / $(gcc --version | head -1)）"

if ! done_ torch; then
  step 'PyTorch 2.3 を入れる（数分）'
  $PIP torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
  $PIP -U xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
  $PIP "setuptools==74.0.0" wheel ninja Cython "numpy==1.23.0"
  mark torch
fi

if ! done_ reqs; then
  step 'LAM が使う部品を入れる（数分）'
  cd /content/LAM
  # GPU向けに組み立てる部品は、あとで別に入れる
  grep -v -E '^(git\+|nvdiffrast@)' requirements.txt > /tmp/lam_req.txt
  $PIP --no-build-isolation -r /tmp/lam_req.txt
  cd /content
  mark reqs
fi

if ! done_ ext; then
  step 'GPU向けの部品を入れる（PyTorch3D・ガウシアン描画・nvdiffrast。5〜15分）'
  # PyTorch3D：組み立て済みのものを使う（それが使えなければ、その場で組み立てる。10〜20分）
  $PIP fvcore iopath
  $PIP --no-index --no-deps --no-cache-dir pytorch3d -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html \
    || $PIP --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git@v0.7.7"
  build diff-gauss https://github.com/ashawkey/diff-gaussian-rasterization.git
  build simple-knn https://github.com/camenduru/simple-knn.git
  $PIP --no-build-isolation "nvdiffrast@git+https://github.com/ShenhanQian/nvdiffrast@backface-culling"
  $PIP "gsplat==1.4.0+pt23cu121" --index-url https://docs.gsplat.studio/whl/pt23cu121 \
    || $PIP --no-build-isolation gsplat==1.4.0      # 確認動画を作るのに使う
  $PIP imageio imageio-ffmpeg
  cd /content/LAM/external/landmark_detection/FaceBoxesV2/utils/ && PATH=/content/lam_env/bin:$PATH sh make.sh
  cd /content
  mark ext
fi

if ! done_ weights; then
  step 'AIの重みをダウンロード（数GB・数分）'
  cd /content/LAM
  /content/lam_env/bin/huggingface-cli download 3DAIGC/LAM-assets --local-dir ./tmp
  tar -xf ./tmp/LAM_assets.tar && rm ./tmp/LAM_assets.tar
  tar -xf ./tmp/thirdparty_models.tar && rm -r ./tmp/
  /content/lam_env/bin/huggingface-cli download 3DAIGC/LAM-20K --local-dir ./model_zoo/lam_models/releases/lam/lam-20k/step_045500/
  cd /content
  mark weights
fi

step '確認'
$PY - <<'PYEOF'
import torch, xformers, pytorch3d, diff_gaussian_rasterization, simple_knn, nvdiffrast, gsplat
print('PyTorch', torch.__version__, '/ GPU', torch.cuda.get_device_name(0))
print('準備ができました')
PYEOF
