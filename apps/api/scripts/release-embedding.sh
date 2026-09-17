#!/bin/bash
# Unload bge-m3-embed from Ollama by sending an embedding request with
# keep_alive=0. Idempotent — safe to run even if the model is already gone.
#
# Env (optional):
#   OLLAMA_URL       — Ollama endpoint (default http://192.168.1.110:11434)
#   EMBEDDING_MODEL  — model name     (default bge-m3-embed)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://192.168.1.110:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-bge-m3-embed}"

payload=$(printf '{"model":"%s","prompt":"bye","keep_alive":0}' "$EMBEDDING_MODEL")

# Tolerate errors (model may already be unloaded, server may be down).
curl --max-time 10 -sf "$OLLAMA_URL/api/embeddings" \
  -H "Content-Type: application/json" \
  -d "$payload" > /dev/null || true

echo "released $EMBEDDING_MODEL from $OLLAMA_URL"