#!/bin/bash
# Probe VRAM and warm both the embedding model (bge-m3-embed) and the chat
# model (coder30b-abl:latest by default — qwen3 MoE 30.5B/3B active).
# After this returns, both models are loaded in Ollama for KEEP_ALIVE;
# run release-models.sh to drop them.
#
# Env (all optional):
#   OLLAMA_URL        — Ollama endpoint       (default http://192.168.1.110:11434)
#   EMBEDDING_MODEL   — embedding model name  (default bge-m3-embed)
#   CHAT_MODEL        — chat model name       (default coder30b-abl:latest)
#   REQUIRED_VRAM_MB  — min free VRAM for GPU (default 800 for embedding; chat
#                       uses its own threshold via the 16 GB total heuristic)
#   KEEP_ALIVE        — warm window for both models (default 30m)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://192.168.1.110:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-bge-m3-embed}"
CHAT_MODEL="${CHAT_MODEL:-coder30b-abl:latest}"
KEEP_ALIVE="${KEEP_ALIVE:-30m}"

probe_free_vram_mb() {
  nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null \
    | head -1 \
    | tr -d '[:space:]' \
    || echo 0
}

warm_model() {
  local model="$1"
  local num_gpu="$2"
  local label="$3"
  local payload
  payload=$(printf '{"model":"%s","prompt":"warmup","options":{"num_gpu":%d},"keep_alive":"%s"}' \
    "$model" "$num_gpu" "$KEEP_ALIVE")
  if curl --max-time 90 -sf "$OLLAMA_URL/api/embeddings" \
      -H "Content-Type: application/json" \
      -d "$payload" > /dev/null; then
    echo "{\"step\":\"$label\",\"model\":\"$model\",\"mode\":\"$([ "$num_gpu" -gt 0 ] && echo gpu || echo cpu)\"}"
  else
    echo "{\"step\":\"$label\",\"model\":\"$model\",\"mode\":\"$([ "$num_gpu" -gt 0 ] && echo gpu || echo cpu)\",\"status\":\"failed\"}" >&2
    return 1
  fi
}

free_mb="$(probe_free_vram_mb)"
echo "{\"step\":\"probe\",\"free_vram_mb\":${free_mb:-0}}"

# Embedding model: ~0.6 GB — always fits on GPU when there's any room.
if [ "${free_mb:-0}" -ge 800 ]; then
  warm_model "$EMBEDDING_MODEL" 999 "embed" || true
else
  warm_model "$EMBEDDING_MODEL" 0 "embed" || true
fi

# Chat model: coder30b-abl — qwen3 MoE 30.5B/3B active, IQ3_M. Active params
# per token are ~3B, so Ollama should keep ~1.5 GB of weights in VRAM and the
# rest of the experts in RAM. Together with bge-m3-embed fp16 (~1.1 GB) and
# KV cache (capped via num_ctx) this fits a 16 GB GPU. Let Ollama decide
# layer placement — it will spill cleanly to CPU if VRAM is tight rather
# than failing to load.
warm_model "$CHAT_MODEL" 999 "chat" || true

echo "{\"step\":\"done\",\"ollama_url\":\"$OLLAMA_URL\",\"embedding\":\"$EMBEDDING_MODEL\",\"chat\":\"$CHAT_MODEL\",\"keep_alive\":\"$KEEP_ALIVE\"}"