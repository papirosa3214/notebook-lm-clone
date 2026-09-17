#!/bin/bash
# Probe VRAM; load bge-m3-embed onto GPU if there's room, else onto CPU.
# After this returns, the model is warm in Ollama for KEEP_ALIVE.
# Run release-embedding.sh to drop it.
#
# Env (all optional):
#   OLLAMA_URL        — Ollama endpoint       (default http://192.168.1.110:11434)
#   EMBEDDING_MODEL   — model name           (default bge-m3-embed)
#   REQUIRED_VRAM_MB  — min free VRAM for GPU (default 800)
#   KEEP_ALIVE        — warm window          (default 30m)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://192.168.1.110:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-bge-m3-embed}"
REQUIRED_VRAM_MB="${REQUIRED_VRAM_MB:-800}"
KEEP_ALIVE="${KEEP_ALIVE:-30m}"

probe_free_vram_mb() {
  nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null \
    | head -1 \
    | tr -d '[:space:]' \
    || echo 0
}

free_mb="$(probe_free_vram_mb)"
if [ "${free_mb:-0}" -ge "$REQUIRED_VRAM_MB" ]; then
  mode="gpu"
  # 999 = offload every layer that fits; Ollama spills the rest to CPU itself.
  num_gpu=999
else
  mode="cpu"
  # 0 = skip GPU entirely; model lives in RAM only.
  num_gpu=0
fi

# Warm the model with a throwaway embedding. keep_alive keeps it loaded across
# the chunking pass; release-embedding.sh drops it.
payload=$(printf '{"model":"%s","prompt":"warmup","options":{"num_gpu":%d},"keep_alive":"%s"}' \
  "$EMBEDDING_MODEL" "$num_gpu" "$KEEP_ALIVE")

if ! curl --max-time 60 -sf "$OLLAMA_URL/api/embeddings" \
    -H "Content-Type: application/json" \
    -d "$payload" > /dev/null; then
  echo "prepare-embedding: warmup request to $OLLAMA_URL failed" >&2
  exit 1
fi

# Emit a single-line JSON status so callers (and humans) can parse it.
printf '{"mode":"%s","url":"%s","model":"%s","free_vram_mb":%s,"num_gpu":%d,"keep_alive":"%s"}\n' \
  "$mode" "$OLLAMA_URL" "$EMBEDDING_MODEL" "${free_mb:-0}" "$num_gpu" "$KEEP_ALIVE"