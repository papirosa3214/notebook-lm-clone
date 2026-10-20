/**
 * Auto-prepare / auto-release of the bge-m3-embed model on Ollama around
 * ingest operations. Mirrors apps/api/scripts/prepare-embedding.sh so the
 * API can drive the lifecycle from inside its own process — no subprocess
 * spawn, no shell-quoting headaches, ref-counted for concurrent ingests.
 *
 * Spec (from Maks):
 *   1. Probe VRAM availability.
 *   2. If free → load model on GPU; if busy → load on CPU.
 *   3. After ingest → unload from whichever device it was on.
 *
 * Env (optional):
 *   EMBEDDING_REQUIRED_VRAM_MB  — min free VRAM to prefer GPU (default 800)
 *   EMBEDDING_KEEP_ALIVE        — warm window for the prepared model (default 30m)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileP = promisify(execFile);

const OLLAMA_URL = config.EMBEDDING_BASE_URL;
const MODEL = config.EMBEDDING_MODEL;
const REQUIRED_VRAM_MB = Number(process.env.EMBEDDING_REQUIRED_VRAM_MB ?? 800);
const KEEP_ALIVE = process.env.EMBEDDING_KEEP_ALIVE ?? '30m';
const TIMEOUT_MS = 60_000;
const RELEASE_TIMEOUT_MS = 10_000;

let activeRefs = 0;

async function probeFreeVramMb(): Promise<number> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3_000 },
    );
    const first = stdout.trim().split('\n')[0] ?? '';
    const n = parseInt(first, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // nvidia-smi missing or GPU unavailable → CPU mode is the only option.
    return 0;
  }
}

async function ollamaEmbeddings(payload: string, timeoutMs: number): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain so the connection can be reused; ignore body.
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Probe VRAM, warm the model on GPU or CPU. Best-effort — logs and
 *  swallows warmup failures so ingest can still attempt the real call
 *  (which will surface its own error if Ollama is truly down). */
export async function prepareEmbedding(): Promise<{ mode: 'gpu' | 'cpu'; freeVramMb: number }> {
  const freeVramMb = await probeFreeVramMb();
  const mode: 'gpu' | 'cpu' = freeVramMb >= REQUIRED_VRAM_MB ? 'gpu' : 'cpu';
  const num_gpu = mode === 'gpu' ? 999 : 0;
  const payload = JSON.stringify({
    model: MODEL,
    prompt: 'warmup',
    options: { num_gpu },
    keep_alive: KEEP_ALIVE,
  });
  try {
    await ollamaEmbeddings(payload, TIMEOUT_MS);
  } catch (err) {
    console.warn(
      `[embedding-lifecycle] prepare warmup failed (mode=${mode}, free_vram_mb=${freeVramMb}):`,
      err instanceof Error ? err.message : err,
    );
  }
  return { mode, freeVramMb };
}

/**
 * Where the embed request should run, cached briefly.
 *
 * bge-m3 in fp16 needs roughly 2.3 GB of VRAM. A resident 27B chat model
 * leaves ~1.7 GB free on a 16 GB card, so demanding GPU placement
 * (`num_gpu: 999`) there makes Ollama park the model with **no** VRAM
 * allocated — after which every request, embeddings and chat alike, is
 * answered with "server busy, maximum pending requests exceeded", because
 * the loading slot never resolves. Asking for CPU placement when VRAM is
 * tight avoids parking the model at all: slower, but it answers.
 *
 * Cached because nvidia-smi costs a process spawn and every chunk embed
 * would otherwise pay for one.
 */
let placementCache: { num_gpu: number; at: number } | null = null;
const PLACEMENT_TTL_MS = 30_000;

export async function resolveEmbeddingPlacement(): Promise<number> {
  if (placementCache && Date.now() - placementCache.at < PLACEMENT_TTL_MS) {
    return placementCache.num_gpu;
  }
  const freeVramMb = await probeFreeVramMb();
  // Headroom on purpose: "free" fluctuates, and a model that just misses
  // the fit is far worse than one that simply runs on CPU.
  const num_gpu = freeVramMb >= REQUIRED_VRAM_MB + 512 ? 999 : 0;
  placementCache = { num_gpu, at: Date.now() };
  if (num_gpu === 0 && freeVramMb > 0) {
    console.warn(
      `[embedding-lifecycle] свободно ${freeVramMb} МБ VRAM — эмбеддинги уходят на CPU, ` +
        'иначе Ollama припаркует модель без видеопамяти и заблокирует очередь',
    );
  }
  return num_gpu;
}

/** Drop the model from Ollama by sending an embedding request with
 *  keep_alive=0. Idempotent. Best-effort. */
export async function releaseEmbedding(): Promise<void> {
  const payload = JSON.stringify({ model: MODEL, prompt: 'bye', keep_alive: 0 });
  try {
    await ollamaEmbeddings(payload, RELEASE_TIMEOUT_MS);
  } catch (err) {
    console.warn(
      `[embedding-lifecycle] release failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Increment refcount; warm the model on first call. */
export async function autoPrepareEmbedding(): Promise<void> {
  if (activeRefs === 0) {
    await prepareEmbedding();
  }
  activeRefs++;
}

/** Decrement refcount; release the model when the last ref drops.
 *  Floors at 0 — calling release more than acquire is a no-op. */
export async function autoReleaseEmbedding(): Promise<void> {
  activeRefs = Math.max(0, activeRefs - 1);
  if (activeRefs === 0) {
    await releaseEmbedding();
  }
}

/** Test/admin introspection — current outstanding ingest count. */
export function getActiveIngestCount(): number {
  return activeRefs;
}