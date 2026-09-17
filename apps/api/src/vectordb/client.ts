/**
 * Local vector store on top of better-sqlite3 + sqlite-vec + Ollama embeddings.
 * Replaces the previous Ragflow dependency — chunks live in this process's
 * SQLite file, embeddings come from Ollama at config.EMBEDDING_BASE_URL.
 */
import { config } from '../config.js';
import { getRawSqlite } from '../db/index.js';

export class VectorDbError extends Error {
  constructor(public status: number, message: string) {
    super(`VectorDB ${status}: ${message}`);
    this.name = 'VectorDbError';
  }
}

// =========== Embeddings =========

/** Call Ollama embeddings API. Times out at 60 s — Ollama stalls long enough
 *  and the SSE ingest stream is going to die anyway, so fail fast. */
export async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(`${config.EMBEDDING_BASE_URL}/api/embeddings`, {
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
      options: { num_gpu: 999 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new VectorDbError(res.status, `embed failed: ${await res.text()}`);
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

  const insertVec = sqlite.prepare('INSERT INTO vec_chunks (embedding) VALUES (?)');
  const insertMeta = sqlite.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        insertMeta.run(
          vecRowid,
          input.notebookId,
          input.sourceId,
          input.kind,
          input.title,
          input.url,
          part,
          start + i,
        );
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
}

/**
 * KNN over the notebook's chunks. Returns top-K by cosine distance.
 * Shape mirrors what Ragflow returned so the LLM-side code stays untouched.
 */
export async function retrieve(
  notebookId: string,
  question: string,
  topK = 6,
): Promise<RetrievalChunk[]> {
  const vec = await embed(question);
  const sqlite = getRawSqlite();
  // KNN: sqlite-vec returns distance in [0..2] for cosine (0 = identical).
  const rows = sqlite
    .prepare(
      `SELECT c.id AS chunk_pk,
              c.source_id AS source_id,
              c.title AS title,
              c.url AS url,
              c.content AS content,
              v.distance AS distance
       FROM vec_chunks v
       JOIN chunks c ON c.vec_rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
         AND c.notebook_id = ?
       ORDER BY v.distance
       LIMIT ?`,
    )
    .all(Buffer.from(vec.buffer), topK, notebookId, topK) as Array<{
    chunk_pk: number;
    source_id: string;
    title: string;
    url: string | null;
    content: string;
    distance: number;
  }>;

  return rows.map((r) => ({
    id: `c${r.chunk_pk}`,
    doc_id: r.source_id,
    document_id: r.source_id,
    docnm_kwd: r.title,
    document_keyword: r.title,
    content: r.content,
    content_with_weight: r.content,
    // sqlite-vec returns a non-Euclidean distance on float vectors; values are
    // comparable (smaller = closer) but not bounded to [0..1]. Pass them through
    // as-is — the UI only uses them to order chips, not for display.
    similarity: r.distance,
    score: r.distance,
  }));
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