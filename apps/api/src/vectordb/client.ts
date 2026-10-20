/**
 * Local vector store on top of better-sqlite3 + sqlite-vec + Ollama embeddings.
 * Replaces the previous Ragflow dependency — chunks live in this process's
 * SQLite file, embeddings come from Ollama at config.EMBEDDING_BASE_URL.
 */
import { config } from '../config.js';
import { getRawSqlite } from '../db/index.js';
import { resolveEmbeddingPlacement } from '../embedding/lifecycle.js';
import { retrievalCache } from './cache.js';

export class VectorDbError extends Error {
  constructor(public status: number, message: string) {
    super(`VectorDB ${status}: ${message}`);
    this.name = 'VectorDbError';
  }
}

// FTS5 treats whitespace-separated terms as AND. That works for a compact
// keyword query, but a natural-language question such as "Как правильно
// настроить взаимодействие между агентами?" would require every chunk to
// contain every word and therefore often returns no context at all. Keep only
// meaningful terms and join them with OR; dense retrieval and RRF still do the
// precision work when embeddings are available.
const FTS_STOP_WORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'вы', 'для', 'до', 'же', 'за', 'и', 'из', 'или',
  'их', 'как', 'к', 'ко', 'ли', 'между', 'мы', 'на', 'над', 'не', 'но', 'о',
  'об', 'он', 'она', 'они', 'от', 'по', 'под', 'при', 'с', 'со', 'такое', 'ты',
  'у', 'что', 'это', 'этот', 'эта', 'эти', 'я',
]);

/** Build a safe, recall-oriented FTS5 expression from a user question. */
export function buildFtsQuery(question: string): string | null {
  const tokens = question.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = [...new Set(tokens.filter((token) => token.length > 1 && !FTS_STOP_WORDS.has(token)))];
  return terms.length > 0 ? terms.join(' OR ') : null;
}

// =========== Embeddings =========

/** Ollama answers "busy" with 503 and "too many" with 429 — both mean
 *  "come back in a moment", not "broken". A dead server still answers,
 *  so retrying a 503 is safe; retrying a 500 with a bad payload is not. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Backoff for a busy model server: 0.5s, 1s, 2s, 4s, plus jitter so
 *  parallel chunk embeds don't wake up in lockstep and re-collide.
 *  Budget is deliberately short (~7.5s): past that the server is not
 *  "busy", it is down, and holding an ingest open helps nobody. */
const EMBED_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

function retryDelayMs(attempt: number): number {
  const base = EMBED_RETRY_DELAYS_MS[attempt] ?? EMBED_RETRY_DELAYS_MS.at(-1)!;
  return base + Math.floor(Math.random() * 250);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** One embeddings round-trip. No retry — the caller owns that policy. */
async function embedOnce(text: string): Promise<Response> {
  // Placement is decided from actual free VRAM, not hardcoded to GPU: a
  // resident 27B chat model leaves too little room for bge-m3, and a
  // request that insists on GPU makes Ollama park the model without
  // video memory and wedge the whole server. See resolveEmbeddingPlacement.
  const num_gpu = await resolveEmbeddingPlacement();
  return fetch(`${config.EMBEDDING_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.EMBEDDING_MODEL,
      prompt: text,
      // Override the systemd default OLLAMA_KEEP_ALIVE=0 so bge-m3-embed
      // stays in VRAM between requests. Otherwise Ollama evicts it the
      // instant the request finishes, and the next embed call has to
      // cold-load from disk while chat is still resident.
      keep_alive: '30m',
      options: { num_gpu },
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

/**
 * Call Ollama embeddings API. Times out at 60 s per attempt — Ollama stalls
 * long enough and the SSE ingest stream is going to die anyway, so fail fast.
 *
 * Retries while the server answers "busy". A busy model server is the normal
 * state of this setup: the embed model is loaded on demand next to a resident
 * 27B chat model, and every chunk of every source goes through here. Without
 * the retry, one momentary 503 aborts the whole source (addSourceText rolls it
 * back) and the user sees "источников нет" for a server that is merely busy.
 */
export async function embed(text: string): Promise<Float32Array> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await embedOnce(text);
    if (res.ok || !isRetryableStatus(res.status) || attempt >= EMBED_RETRY_DELAYS_MS.length) {
      break;
    }
    await sleep(retryDelayMs(attempt));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new VectorDbError(
      res.status,
      res.status === 503 || res.status === 429
        ? `модель эмбеддингов занята (Ollama: ${body.slice(0, 120)})`
        : `embed failed: ${body}`,
    );
  }
  const body = (await res.json()) as { embedding: number[] };
  const arr = new Float32Array(body.embedding);
  if (arr.length !== config.EMBEDDING_DIM) {
    throw new VectorDbError(
      500,
      `embedding dim mismatch: model returned ${arr.length}, expected ${config.EMBEDDING_DIM}`,
    );
  }
  return arr;
}

// =========== Chunking =========

/**
 * Recursive splitter: split on \n\n first (paragraphs), then \n (lines), then words,
 * to produce chunks of roughly `targetChars` characters. Overlap keeps retrieval
 * continuous across boundaries.
 *
 * bge-m3 has ~4 chars per token on average; 512 tokens ≈ 2048 chars is a sweet spot
 * between retrieval precision and embed latency (one Wikipedia page → ~30 chunks).
 */
export function chunkText(text: string, targetChars = 2048, overlapChars = 200): string[] {
  const norm = text.replace(/\r\n/g, '\n').trim();
  if (norm.length === 0) return [];
  if (norm.length <= targetChars) return [norm];

  const out: string[] = [];
  const paragraphs = norm.split(/\n\n+/);
  let buf = '';

  function flush() {
    if (buf.trim().length === 0) return;
    out.push(buf.trim());
    if (buf.length > overlapChars) {
      buf = buf.slice(buf.length - overlapChars);
    } else {
      buf = '';
    }
  }

  for (const para of paragraphs) {
    const piece = para.trim();
    if (!piece) continue;
    if ((buf + '\n\n' + piece).length > targetChars && buf.length > 0) {
      flush();
    }
    if (piece.length > targetChars) {
      // single paragraph too big — split by lines, then by words
      const lines = piece.split(/\n/);
      for (const line of lines) {
        if ((buf + '\n' + line).length > targetChars && buf.length > 0) flush();
        if (line.length > targetChars) {
          // word-split
          const words = line.split(/\s+/);
          for (const w of words) {
            if ((buf + ' ' + w).length > targetChars && buf.length > 0) flush();
            buf = buf ? buf + ' ' + w : w;
          }
          buf = buf + '\n';
        } else {
          buf = buf ? buf + '\n' + line : line;
        }
      }
      buf = buf + '\n\n';
    } else {
      buf = buf ? buf + '\n\n' + piece : piece;
    }
  }
  flush();
  return out;
}

// =========== Persist =========

export interface AddSourceInput {
  notebookId: string;
  sourceId: string;
  kind: 'url' | 'file' | 'youtube';
  title: string;
  url: string | null;
  content: string;
}

/**
 * Insert a source's markdown into the local vector store.
 *
 * For each chunk:
 *   - embed via Ollama (concurrent, batched by EMBED_CONCURRENCY)
 *   - INSERT INTO vec_chunks (embedding) VALUES (...)
 *   - lastInsertRowid → chunks metadata row
 *
 * If any chunk's embed call fails, we delete everything we already inserted
 * for this source so the caller can mark the source 'failed' cleanly.
 *
 * `onBatch(done, total)` fires after each successful batch — the API uses it
 * to push per-chunk progress to the SSE stream so the client sees movement
 * during the long embedding pass (otherwise the stream appears idle and a
 * proxy can drop it on idle timeout).
 */
export async function addSourceText(
  input: AddSourceInput,
  onBatch?: (done: number, total: number) => void,
): Promise<number> {
  const sqlite = getRawSqlite();
  const parts = chunkText(input.content);
  if (parts.length === 0) {
    throw new VectorDbError(400, 'document has no extractable text');
  }

  // New chunks means cached retrieval results for this notebook are stale —
  // any answer that landed before this add missed what we're about to ingest.
  retrievalCache.invalidateNotebook(input.notebookId);

  const insertVec = sqlite.prepare('INSERT INTO vec_chunks (embedding) VALUES (?)');
  const insertMeta = sqlite.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // FTS5 is in external-content mode keyed on chunks.id, so we just need
  // to keep it in sync via triggers — see migrate(). Inserts here are
  // a defensive no-op if the trigger is active.
  const insertFts = sqlite.prepare(
    `INSERT INTO chunks_fts (rowid, title, content) VALUES (?, ?, ?)`,
  );

  const inserted: number[] = [];

  try {
    // Embed in concurrent batches. Ollama bge-m3-embed processes one prompt per
    // request and takes ~1.5s; doing 8 in parallel keeps the GPU saturated
    // without overwhelming the model server.
    const CONCURRENCY = 8;
    const total = parts.length;
    for (let start = 0; start < total; start += CONCURRENCY) {
      const end = Math.min(start + CONCURRENCY, total);
      const slice = parts.slice(start, end);
      const vecs = await Promise.all(slice.map((p) => embed(p)));
      for (let i = 0; i < slice.length; i++) {
        const part = slice[i]!;
        const vec = vecs[i]!;
        const info = insertVec.run(Buffer.from(vec.buffer));
        const vecRowid = Number(info.lastInsertRowid);
        inserted.push(vecRowid);
        const metaInfo = insertMeta.run(
          vecRowid,
          input.notebookId,
          input.sourceId,
          input.kind,
          input.title,
          input.url,
          part,
          start + i,
        );
        // Keep the FTS index in sync with chunks. lastInsertRowid on the
        // chunks row gives us the chunks.id we'll match against in the
        // FTS rowid.
        insertFts.run(metaInfo.lastInsertRowid, input.title, part);
      }
      onBatch?.(end, total);
    }
  } catch (err) {
    if (inserted.length > 0) {
      sqlite.prepare(`DELETE FROM chunks WHERE source_id = ?`).run(input.sourceId);
      const placeholders = inserted.map(() => '?').join(',');
      sqlite.prepare(`DELETE FROM vec_chunks WHERE rowid IN (${placeholders})`).run(...inserted);
    }
    throw err;
  }

  return parts.length;
}

/** Drop all chunks for a given source. Used by DELETE /sources/:id. */
export function removeSource(sourceId: string): void {
  const sqlite = getRawSqlite();
  const rows = sqlite
    .prepare(`SELECT vec_rowid FROM chunks WHERE source_id = ?`)
    .all(sourceId) as Array<{ vec_rowid: number }>;
  if (rows.length === 0) return;
  sqlite.prepare(`DELETE FROM chunks WHERE source_id = ?`).run(sourceId);
  const ids = rows.map((r) => r.vec_rowid);
  const placeholders = ids.map(() => '?').join(',');
  sqlite.prepare(`DELETE FROM vec_chunks WHERE rowid IN (${placeholders})`).run(...ids);
}

// =========== Retrieval =========

export interface RetrievalChunk {
  id: string;
  doc_id: string;
  document_id: string;
  docnm_kwd: string;
  document_keyword: string;
  content: string;
  content_with_weight: string;
  similarity: number;
  vector_similarity?: number;
  term_similarity?: number;
  score?: number;
  /**
   * Source kind ('url' | 'file' | 'youtube') and id — added so the
   * chat pipeline can populate CitationChunk.sourceKind without a
   * second DB roundtrip. ordinal is the chunk's 0-based position
   * inside the source (used to render "Фрагмент N").
   */
  sourceKind?: 'url' | 'file' | 'youtube';
  sourceId?: string;
  ordinal?: number;
}

/**
 * KNN over the notebook's chunks. Returns top-K by cosine distance.
 * Shape mirrors what Ragflow returned so the LLM-side code stays untouched.
 *
 * If `sourceIds` is non-empty, the result is restricted to chunks whose
 * source_id is in that list. The list is validated by the route handler
 * to belong to `notebookId` — we trust the caller here.
 */
export async function retrieve(
  notebookId: string,
  question: string,
  topK = 6,
  sourceIds?: string[],
): Promise<RetrievalChunk[]> {
  return retrieveRaw(notebookId, question, topK, false, sourceIds);
}

export async function retrieveWithRerank(
  notebookId: string,
  question: string,
  topK = 6,
  opts: { provider?: string; model?: string; sourceIds?: string[] } = {},
): Promise<RetrievalChunk[]> {
  // Pull a wider candidate pool than topK so reranker has room to work.
  const CANDIDATE_POOL = 16;
  const candidates = await retrieveRaw(notebookId, question, CANDIDATE_POOL, true, opts.sourceIds);
  if (candidates.length <= 1) return candidates;
  const { getRerankProvider } = await import('../lib/rerank/factory.js');
  return getRerankProvider().rerank(question, candidates, topK, {
    provider: opts.provider,
    model: opts.model,
  });
}

async function retrieveRaw(
  notebookId: string,
  question: string,
  topK: number,
  _useFts: boolean,
  sourceIds?: string[],
): Promise<RetrievalChunk[]> {
  // Source-scope filter. When sourceIds is non-empty we restrict BOTH
  // the KNN and the BM25 query to chunks belonging to those sources.
  // The route handler validates that every id belongs to notebookId
  // before this point, so the SQL filter is a defence-in-depth check.
  const scoped = sourceIds && sourceIds.length > 0;
  const sourceFilter = scoped
    ? ` AND c.source_id IN (${sourceIds!.map(() => '?').join(',')})`
    : '';
  const sourceParams = scoped ? sourceIds! : [];

  // Cache check — short-circuits the Ollama embeddings round-trip on repeat
  // questions. Cache key includes notebookId + normalized question + topK +
  // sorted sourceIds so asking the same thing twice in the same source
  // scope is free; asking across a different scope misses.
  const cached = retrievalCache.get({ notebookId, question, topK, sourceIds });
  if (cached) return cached as RetrievalChunk[];

  const sqlite = getRawSqlite();
  type DenseRow = {
    chunk_pk: number;
    source_id: string;
    title: string;
    url: string | null;
    content: string;
    kind: 'url' | 'file' | 'youtube';
    ordinal: number;
    distance: number;
  };
  let rows: DenseRow[] = [];
  try {
    const vec = await embed(question);
    // KNN: sqlite-vec returns distance in [0..2] for cosine (0 = identical).
    rows = sqlite
      .prepare(
        `SELECT c.id AS chunk_pk,
                c.source_id AS source_id,
                c.title AS title,
                c.url AS url,
                c.content AS content,
                c.kind AS kind,
                c.ordinal AS ordinal,
                v.distance AS distance
         FROM vec_chunks v
         JOIN chunks c ON c.vec_rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
           AND c.notebook_id = ?${sourceFilter}
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(Buffer.from(vec.buffer), topK, notebookId, ...sourceParams, topK) as DenseRow[];
  } catch {
    // A chat must remain grounded when the embedding server is restarting or
    // unavailable. The lexical branch below is independent of Ollama.
    rows = [];
  }

  const ftsQuery = buildFtsQuery(question);
  const ftsRows = ftsQuery
    ? (sqlite
        .prepare(
          `SELECT c.id AS chunk_pk,
                  c.source_id AS source_id,
                  c.title AS title,
                  c.url AS url,
                  c.content AS content,
                  c.kind AS kind,
                  c.ordinal AS ordinal,
                  bm25(chunks_fts) AS bm25_score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ?
             AND c.notebook_id = ?${sourceFilter}
           ORDER BY bm25_score
           LIMIT ?`,
        )
        .all(ftsQuery, notebookId, ...sourceParams, topK) as Array<{
    chunk_pk: number;
    source_id: string;
    title: string;
    url: string | null;
    content: string;
    kind: 'url' | 'file' | 'youtube';
    ordinal: number;
    bm25_score: number;
  }>)
    : [];

  // Hybrid retrieval: dense (sqlite-vec) + lexical (FTS5 BM25), merged
  // with Reciprocal Rank Fusion. We fetch topK from each side so the
  // union has at most 2*topK candidates before RRF cuts it back to topK.
  //
  // RRF: score = sum(1 / (k0 + rank)) across retrieval systems where
  // rank is 1-based. k0=60 is the original Cormack/Clarke/Buettcher
  // default that flattens rank differences sensibly. A chunk that
  // shows up in BOTH lists scores higher than one that shows up in
  // only one — that's the whole point of the merge.
  const K0 = 60;
  type Hit = {
    chunk_pk: number;
    source_id: string;
    source_kind: 'url' | 'file' | 'youtube';
    ordinal: number;
    title: string;
    url: string | null;
    content: string;
    rrf: number;
  };
  const hits = new Map<number, Hit>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    hits.set(r.chunk_pk, {
      chunk_pk: r.chunk_pk,
      source_id: r.source_id,
      source_kind: r.kind,
      ordinal: r.ordinal,
      title: r.title,
      url: r.url,
      content: r.content,
      // dense rank: 1 for the closest, growing by 1
      rrf: 1 / (K0 + (i + 1)),
    });
  }
  for (let i = 0; i < ftsRows.length; i++) {
    const r = ftsRows[i]!;
    const existing = hits.get(r.chunk_pk);
    if (existing) {
      existing.rrf += 1 / (K0 + (i + 1));
    } else {
      hits.set(r.chunk_pk, {
        chunk_pk: r.chunk_pk,
        source_id: r.source_id,
        source_kind: r.kind,
        ordinal: r.ordinal,
        title: r.title,
        url: r.url,
        content: r.content,
        rrf: 1 / (K0 + (i + 1)),
      });
    }
  }

  // Sort by RRF score desc, take topK.
  const merged = [...hits.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);

  const result = merged.map((r) => ({
    id: `c${r.chunk_pk}`,
    doc_id: r.source_id,
    document_id: r.source_id,
    docnm_kwd: r.title,
    document_keyword: r.title,
    content: r.content,
    content_with_weight: r.content,
    // RRF score is unbounded but monotonic — UI uses it for ordering only.
    similarity: r.rrf,
    score: r.rrf,
    // Chat pipeline reads these to populate CitationChunk without a
    // second DB lookup per chunk.
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    ordinal: r.ordinal,
  }));

  // Cache the result for repeat questions. Empty result is cached too — an
  // empty notebook shouldn't hammer Ollama every retry.
  retrievalCache.set({ notebookId, question, topK, sourceIds }, result);

  return result;
}

// =========== Health =========

export async function ping(): Promise<boolean> {
  try {
    await embed('health probe');
    return true;
  } catch {
    return false;
  }
}

// =========== Helpers =========

// Re-export the raw handle getter for callers that need direct SQL access.
export { getRawSqlite };
