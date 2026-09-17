# Model-lifecycle scripts

Three small bash helpers for managing both the embedding model
(`bge-m3-embed`) and the chat model (`qwen3.6-27b-iq4-16k`) on the Ollama
server that the API talks to (default `http://192.168.1.110:11434`).

NotebookLM-style workflow needs both models simultaneously:
- `bge-m3-embed` produces the 1024-dim vectors used by retrieval (chunk →
  vec_chunks during ingest, question → KNN during chat/summary).
- `qwen3.6-27b-iq4-16k` is the chat model that summarises sources and
  answers questions with citations.

## Usage

```bash
# 1. Warm both models: probe VRAM, load each on GPU if room, else CPU.
./prepare-models.sh
# → {"step":"probe","free_vram_mb":...}
#   {"step":"embed","model":"bge-m3-embed","mode":"gpu"}
#   {"step":"chat","model":"qwen3.6-27b-iq4-16k:latest","mode":"gpu"}
#   {"step":"done","ollama_url":"...","embedding":"bge-m3-embed","chat":"qwen3.6-27b-iq4-16k:latest","keep_alive":"30m"}

# 2. Run your ingest / chat / summary work.

# 3. Verify what's loaded.
./embedding-status.sh
# → {"models":[{"name":"bge-m3-embed",...},{"name":"qwen3.6-27b-iq4-16k:latest",...}]}

# 4. Drop both from Ollama.
./release-models.sh
```

## Decision logic (prepare)

- Probe free VRAM via `nvidia-smi --query-gpu=memory.free`.
- Embedding model (~0.6 GB):
  - If free VRAM ≥ `REQUIRED_VRAM_MB` (default 800 MB): warmup with
    `options.num_gpu=999` — Ollama offloads every layer that fits on the GPU.
  - Else: `options.num_gpu=0` — model lives in RAM only.
- Chat model (~15 GB):
  - If free VRAM ≥ 16 GB: `num_gpu=999` (full GPU).
  - Else: `num_gpu=0` (CPU only) — Ollama would otherwise thrash spilling
    layers in and out of a too-small VRAM budget.
- Either model, either mode: `keep_alive=KEEP_ALIVE` (default `30m`)
  keeps the model warm for the work session.

## Env overrides

All scripts honour:

| Var | Default | Used by |
|---|---|---|
| `OLLAMA_URL` | `http://192.168.1.110:11434` | all three |
| `EMBEDDING_MODEL` | `bge-m3-embed` | prepare, release |
| `CHAT_MODEL` | `qwen3.6-27b-iq4-16k:latest` | prepare, release |
| `REQUIRED_VRAM_MB` | `800` (embedding floor) | prepare |
| `KEEP_ALIVE` | `30m` | prepare |

## What this is NOT

These scripts don't tie into the API process. They are a manual hand-off:
you (or a future orchestrator) run `prepare-models.sh` before kicking off
heavy work that needs both models warm, `release-models.sh` after.

The API has its own lighter-touch lifecycle at
`apps/api/src/embedding/lifecycle.ts` (auto-prepare/release around ingest
with a refcount) so the embedding model is ready by the time a source
ingest starts, but it doesn't touch the chat model — chat loads lazily on
first request. Use these scripts when you want everything prewarmed.