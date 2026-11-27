#!/bin/bash
# lhm_setup.sh — 写真1枚から全身の立体人物を作るAI「LHM」を、Colabで動くように準備する
#   LHMは Python 3.10・PyTorch 2.3 向けに作られているので、Colab本体とは別の環境（/content/lhm_env）を作って入れる
#   一度終わると印（/content/lhm_env/.ok_*）が残り、同じセッションで再実行しても飛ばす
#   初回は 20〜40分ほどかかる（立体表示の部品をGPU向けに組み立てるため）
set -e
cd /content
step(){ echo; echo "■ $1"; }
done_(){ [ -f "/content/lhm_env/.ok_$1" ]; }
mark(){ touch "/content/lhm_env/.ok_$1"; }

nvidia-smi -L || { echo 'GPUがありません。ランタイムのタイプで L4 を選んでください'; exit 1; }

if [ ! -d /content/LHM ]; then
  step 'LHM本体をダウンロード'
  git clone -q --depth 1 https://github.com/aigc3d/LHM.git /content/LHM
fi

if [ ! -x /content/lhm_env/bin/python ]; then
  step 'Python 3.10 の環境を作成'
  pip -q install uv
  uv venv -q --seed --python 3.10 /content/lhm_env
fi
PY=/content/lhm_env/bin/python
PIP="$PY -m pip install -q"
export PATH=/content/lhm_env/bin:$PATH
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export FORCE_CUDA=1
export TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9"   # A100・L4 など
export MAX_JOBS=8

if ! done_ torch; then
  step 'PyTorch 2.3 を入れる（数分）'
  $PIP torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
  $PIP -U xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
  $PIP "setuptools==74.0.0" wheel ninja "numpy==1.23.0"
  mark torch
fi

if ! done_ reqs; then
  step 'LHMが使う部品を入れる（数分）'
  cd /content/LHM
  # torch・xformers は上で入れたものを使う（ここで入れ直さない）
  grep -v -E '^(torch|torchvision|xformers)==' requirements.txt > /tmp/lhm_req.txt
  $PIP --no-build-isolation -r /tmp/lhm_req.txt
  $PY -m pip uninstall -q -y basicsr
  $PIP --no-build-isolation git+https://github.com/XPixelGroup/BasicSR
  cd /content
  mark reqs
fi

if ! done_ p3d; then
  step 'PyTorch3D をGPU向けに組み立てる（いちばん時間がかかります。10〜20分）'
  $PIP --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git@v0.7.8"
  mark p3d
fi

if ! done_ gs; then
  step '立体表示（ガウシアン）の部品を組み立てる（数分）'
  $PIP --no-build-isolation git+https://github.com/hitsz-zuoqi/sam2/
  $PIP --no-build-isolation git+https://github.com/ashawkey/diff-gaussian-rasterization/
  $PIP --no-build-isolation git+https://github.com/camenduru/simple-knn/
  mark gs
fi

if ! done_ prior; then
  step 'AIの重みをダウンロード（数GB。数分）'
  cd /content/LHM
  if [ ! -d pretrained_models/human_model_files ]; then
    wget -q --show-progress https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LHM/LHM_prior_model.tar
    tar -xf LHM_prior_model.tar
    rm -f LHM_prior_model.tar
  fi
  cd /content
  mark prior
fi

step '確認'
$PY - <<'EOF'
import torch, xformers, pytorch3d, diff_gaussian_rasterization, simple_knn, gsplat
print('PyTorch', torch.__version__, '/ GPU', torch.cuda.get_device_name(0))
print('準備ができました')
EOF
