#!/bin/bash
# Probe VRAM and warm both the embedding model (bge-m3-embed) and the chat
# model (qwen3.6-27b-iq4-16k by default). After this returns, both models are
# loaded in Ollama for KEEP_ALIVE; run release-models.sh to drop them.
#
# Env (all optional):
#   OLLAMA_URL        — Ollama endpoint       (default http://192.168.1.110:11434)
#   EMBEDDING_MODEL   — embedding model name  (default bge-m3-embed)
#   CHAT_MODEL        — chat model name       (default qwen3.6-27b-iq4-16k:latest)
#   REQUIRED_VRAM_MB  — min free VRAM for GPU (default 800 for embedding; chat
#                       uses its own threshold via the 16 GB total heuristic)
#   KEEP_ALIVE        — warm window for both models (default 30m)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://192.168.1.110:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-bge-m3-embed}"
CHAT_MODEL="${CHAT_MODEL:-qwen3.6-27b-iq4-16k:latest}"
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

# Chat model: ~15 GB — only fit on GPU if there's actual room for it.
# 16 GB is the practical floor (15 GB model + 0.6 GB embed + headroom).
if [ "${free_mb:-0}" -ge 16000 ]; then
  warm_model "$CHAT_MODEL" 999 "chat" || true
else
  # Ollama will spill layers to CPU/RAM automatically when num_gpu is non-zero
  # but the model doesn't fully fit. Asking for 0 layers on GPU forces CPU
  # cleanly so we don't end up with a half-loaded model thrashing.
  warm_model "$CHAT_MODEL" 0 "chat" || true
fi

echo "{\"step\":\"done\",\"ollama_url\":\"$OLLAMA_URL\",\"embedding\":\"$EMBEDDING_MODEL\",\"chat\":\"$CHAT_MODEL\",\"keep_alive\":\"$KEEP_ALIVE\"}"