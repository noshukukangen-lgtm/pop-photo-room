#!/bin/bash
# lhm_setup.sh — 写真（1〜8枚）から全身の立体人物を作るAI「LHM++」を、Colabで動くように準備する
#   LHM++ は Python 3.10・PyTorch 2.3 向けなので、Colab本体とは別の環境（/content/lhm_env）を作って入れる
#   一度終わった段階には印（/content/lhm_env/.ok_*）が残り、同じセッションで再実行すると飛ばす
#   初回は 15〜30分ほど
set -e
cd /content
step(){ echo; echo "■ $1"; }
done_(){ [ -f "/content/lhm_env/.ok_$1" ]; }
mark(){ touch "/content/lhm_env/.ok_$1"; }

nvidia-smi -L || { echo 'GPUがありません。ランタイムのタイプで L4 を選んでください'; exit 1; }

if [ ! -d /content/LHMPP ]; then
  step 'LHM++ 本体をダウンロード'
  git clone -q --depth 1 https://github.com/aigc3d/LHM-plusplus.git /content/LHMPP
fi

if [ ! -x /content/lhm_env/bin/python ]; then
  step 'Python 3.10 の環境を作成'
  pip -q install uv
  uv venv -q --seed --python 3.10 /content/lhm_env
fi
PY=/content/lhm_env/bin/python
PIP="$PY -m pip install -q"
export PATH=/content/lhm_env/bin:$PATH
export FORCE_CUDA=1

# Colab の CUDA は 13 だが、PyTorch 2.3 は CUDA 12.1 向け。版が違うとGPU向けの部品を組み立てられないので、
# CUDA 12.1 の組み立て道具（と、それに対応する gcc 12）を別に入れて、そちらを使う
if [ ! -x /content/cuda121/bin/nvcc ]; then
  step 'CUDA 12.1 の組み立て道具を入れる（PyTorchの版に合わせるため。数分）'
  apt-get -qq update > /dev/null && apt-get -qq install -y gcc-12 g++-12 > /dev/null
  [ -x /content/bin/micromamba ] || curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /content bin/micromamba
  /content/bin/micromamba create -y -q -p /content/cuda121 -c nvidia/label/cuda-12.1.1 \
    cuda-nvcc cuda-cudart-dev cuda-cccl cuda-nvrtc-dev cuda-nvtx cuda-profiler-api \
    libcublas-dev libcusparse-dev libcusolver-dev libcurand-dev > /dev/null
  # 部品の置き場所を、PyTorch が探すいつもの場所（include・lib64）にもそろえる
  for sub in include lib; do
    [ -d /content/cuda121/targets/x86_64-linux/$sub ] && cp -rsn /content/cuda121/targets/x86_64-linux/$sub/. /content/cuda121/$sub/ 2>/dev/null || true
  done
  [ -e /content/cuda121/lib64 ] || ln -s /content/cuda121/lib /content/cuda121/lib64
fi
export CUDA_HOME=/content/cuda121
export PATH=/content/cuda121/bin:$PATH
export CC=gcc-12 CXX=g++-12 CUDAHOSTCXX=g++-12
export NVCC_PREPEND_FLAGS='-ccbin /usr/bin/g++-12'
echo "（組み立ての道具：$(nvcc --version | tail -1) / $(g++-12 --version | head -1)）"
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

if ! done_ torch; then
  step 'PyTorch 2.3 を入れる（数分）'
  $PIP torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
  $PIP -U xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
  $PIP "setuptools==74.0.0" wheel ninja "numpy==1.23.0"
  mark torch
fi

if ! done_ reqs; then
  step 'LHM++ が使う部品を入れる（数分）'
  cd /content/LHMPP
  # torch・xformers・gsplat は別に入れる（ここで入れ直さない）
  grep -v -E '^(torch|torchvision|xformers|gsplat)==' requirements.txt > /tmp/lhm_req.txt
  $PIP --no-build-isolation -r /tmp/lhm_req.txt
  $PIP "rembg[cpu]==2.0.63"
  cd /content
  mark reqs
fi

if ! done_ ext; then
  step '組み立て済みの部品を入れる（PyTorch3D・torch_scatter・spconv・gsplat）'
  # PyTorch3D：組み立て済みのものを使う（それが使えなければ、その場で組み立てる。10〜20分）
  $PIP fvcore iopath
  $PIP --no-index --no-deps --no-cache-dir pytorch3d -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html \
    || $PIP --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git@v0.7.7"
  $PIP torch_scatter -f https://data.pyg.org/whl/torch-2.3.0+cu121.html
  $PIP spconv-cu121
  $PIP "gsplat==1.4.0+pt23cu121" --index-url https://docs.gsplat.studio/whl/pt23cu121 \
    || $PIP --no-build-isolation gsplat==1.4.0
  mark ext
fi

if ! done_ build; then
  step 'GPU向けの部品を組み立てる（pointops・ガウシアン描画。5〜15分）'
  $PIP --no-build-isolation /content/LHMPP/lib/pointops
  build diff-gauss https://github.com/ashawkey/diff-gaussian-rasterization.git
  build simple-knn https://github.com/camenduru/simple-knn.git
  mark build
fi

if ! done_ prior; then
  step 'AIの重み（体の形の知識など）をダウンロード（数GB・数分）'
  cd /content/LHMPP
  $PY scripts/download_pretrained_models.py --prior
  cd /content
  mark prior
fi

step '確認'
$PY - <<'PYEOF'
import torch, xformers, pytorch3d, torch_scatter, spconv, gsplat, diff_gaussian_rasterization, simple_knn, rembg
print('PyTorch', torch.__version__, '/ GPU', torch.cuda.get_device_name(0))
print('準備ができました')
PYEOF
