# Embedding-model lifecycle scripts

Three small bash helpers for managing the `bge-m3-embed` model on the Ollama
server that the API talks to (default `http://192.168.1.110:11434`).

## Usage

```bash
# 1. Warm the model: probe VRAM, load on GPU if free, else CPU.
./prepare-embedding.sh
# → {"mode":"gpu","url":"...","model":"bge-m3-embed","free_vram_mb":4218,"num_gpu":999,"keep_alive":"30m"}

# 2. Run your ingest / batch.

# 3. Verify it's loaded.
./embedding-status.sh
# → {"models":[{"name":"bge-m3-embed", ... "size_vram":...}, ...]}

# 4. Drop it from Ollama.
./release-embedding.sh
```

## Decision logic (prepare)

- Probe free VRAM via `nvidia-smi --query-gpu=memory.free`.
- If free VRAM ≥ `REQUIRED_VRAM_MB` (default 800 MB): warmup with
  `options.num_gpu=999` — Ollama offloads every layer that fits on the GPU,
  spills the rest to CPU itself.
- Else: warmup with `options.num_gpu=0` — model lives in RAM only, full CPU.
- Either way, `keep_alive=KEEP_ALIVE` (default `30m`) keeps the model warm
  for the duration of the chunking pass.

## Env overrides

All scripts honour:

| Var | Default | Used by |
|---|---|---|
| `OLLAMA_URL` | `http://192.168.1.110:11434` | all three |
| `EMBEDDING_MODEL` | `bge-m3-embed` | prepare, release |
| `REQUIRED_VRAM_MB` | `800` | prepare |
| `KEEP_ALIVE` | `30m` | prepare |

## What this is NOT

These scripts don't tie into the API process. They are a manual hand-off:
you (or a future orchestrator) run `prepare` before kicking off heavy ingest,
`release` after. Wiring this into the API's startup/shutdown is a separate
step.