#!/usr/bin/env bash
set -euo pipefail

LLAMA_SERVER="$HOME/llama.cpp/build/bin/llama-server"
MODEL="$HOME/llama.cpp/Qwen3.5-27B-UD-Q4_K_XL.gguf"
HOST="127.0.0.1"
PORT="8001"
CTX="8192"
GPU_LAYERS="99"  # set to 0 if no GPU

echo "Starting llama-server..."
echo "  Model : $MODEL"
echo "  URL   : http://$HOST:$PORT/v1"
echo ""

exec "$LLAMA_SERVER" \
  --model "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  --ctx-size "$CTX" \
  --n-gpu-layers "$GPU_LAYERS" \
  --parallel 1 \
  --flash-attn \
  --log-disable
