#!/bin/bash
# Show what models are currently loaded in Ollama (GET /api/ps).
# Useful right after prepare-embedding.sh to verify the model is warm,
# and right before release-embedding.sh to confirm it'll be released.
#
# Env (optional):
#   OLLAMA_URL — Ollama endpoint (default http://192.168.1.110:11434)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://192.168.1.110:11434}"

raw=$(curl --max-time 5 -sf "$OLLAMA_URL/api/ps" || true)

if [ -z "$raw" ]; then
  echo "embedding-status: could not reach $OLLAMA_URL" >&2
  exit 1
fi

# Pretty-print if python3 is around, else raw.
if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$raw" | python3 -m json.tool
else
  printf '%s\n' "$raw"
fi