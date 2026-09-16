import { config } from '../config.js';

const BASE = config.RAGFLOW_BASE_URL.replace(/\/$/, '');

export class RagflowError extends Error {
  constructor(public status: number, message: string) {
    super(`Ragflow ${status}: ${message}`);
    this.name = 'RagflowError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.RAGFLOW_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new RagflowError(res.status, msg);
  }
  if (typeof body === 'object' && body && 'code' in body) {
    const code = (body as { code: unknown }).code;
    if (code !== 0) {
      const msg =
        'message' in body
          ? String((body as { message: unknown }).message)
          : 'unknown error';
      throw new RagflowError(res.status, msg);
    }
  }
  return body as T;
}

// === Datasets ===

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  document_count: number;
  chunk_count: number;
  embedding_model: string;
  chunk_method: string;
  language?: string;
  create_date: string;
}

export async function listDatasets(page = 1, pageSize = 30): Promise<Dataset[]> {
  const res = await request<{ data: Dataset[] }>(
    `/api/v1/datasets?page=${page}&page_size=${pageSize}`,
  );
  return res.data;
}

export async function createDataset(
  name: string,
  description = '',
): Promise<{ id: string }> {
  // chunk_token_num=256 keeps Ragflow's naive splitter under the 512-token
  // input window of bge-m3-embed@Ollama on .110. The default 512 chunks can
  // exceed the embedder's context and fail with "input length exceeds context".
  const res = await request<{ data: { id: string } }>(`/api/v1/datasets`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      embedding_model: 'bge-m3-embed@Ollama',
      parser_config: { chunk_token_num: 256 },
    }),
  });
  return res.data;
}

// === Documents ===

export type RagflowRunStatus = 'UNSTART' | 'RUNNING' | 'CANCEL' | 'DONE' | 'FAIL';

export interface DocumentInfo {
  id: string;
  name: string;
  run: RagflowRunStatus;
  status: string;
  progress: number;
  chunk_count: number;
  token_count: number;
  size: number;
  create_date: string;
  update_date?: string;
  suffix?: string;
  source_type?: string;
}

export async function listDocuments(
  datasetId: string,
): Promise<DocumentInfo[]> {
  // GET /datasets/{id}/documents returns JSON metadata; the {doc_id}-suffixed
  // variant returns the raw file content instead — surprising but that's how
  // Ragflow v0.25 ships it.
  const res = await request<{ data: { docs: DocumentInfo[]; total: number } }>(
    `/api/v1/datasets/${datasetId}/documents?page=1&page_size=100`,
  );
  return res.data.docs ?? [];
}

export async function addDocumentFromUrl(
  datasetId: string,
  url: string,
): Promise<DocumentInfo> {
  // Ragflow v0.25 does NOT crawl URLs server-side — we must fetch and upload.
  // This helper only handles the upload step; the route does the fetching.
  throw new RagflowError(501, 'use fetchUrlToHtml + uploadDocumentFile instead');
}

/** Fetch a URL and convert HTML → Markdown. Ragflow's naive splitter works
 * best on flat text (markdown/plain) — feeding raw HTML makes it produce
 * one huge first chunk that exceeds Ollama's embedding context. */
export async function fetchUrlToMarkdown(
  url: string,
): Promise<{ markdown: string; title: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NotebookBot/0.1)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new RagflowError(res.status, `fetch ${url} failed: ${res.statusText}`);
  }
  const raw = await res.text();
  const title = extractTitle(raw) ?? new URL(url).hostname;
  const stripped = stripNonContent(raw);
  const { htmlToText } = (await import('html2text')) as unknown as {
    htmlToText: (html: string, opts?: Record<string, unknown>) => string;
  };
  const md = htmlToText(stripped, {
    wordwrap: false,
    preserveImageAlt: false,
    uppercaseHeadings: false,
  });
  const markdown = md.replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, title };
}

function stripNonContent(html: string): string {
  let s = html;
  for (const tag of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'svg', 'iframe', 'form']) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  // Prefer <article>, then <main>, then <body>
  for (const tag of ['article', 'main', 'body']) {
    const m = s.match(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'i'));
    if (m) return m[0];
  }
  return s;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  return m && m[1] ? m[1].trim() : null;
}

export async function uploadDocumentFile(
  datasetId: string,
  file: { buffer: Buffer; filename: string },
): Promise<DocumentInfo> {
  const form = new FormData();
  form.append('file', new Blob([file.buffer]), file.filename);
  const res = await fetch(`${BASE}/api/v1/datasets/${datasetId}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RAGFLOW_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    throw new RagflowError(res.status, await res.text());
  }
  const body = (await res.json()) as { data: DocumentInfo[] };
  const doc = body.data[0];
  if (!doc) throw new RagflowError(500, 'no document returned');
  return doc;
}

/**
 * Kick the Ragflow parser for one or more documents. In v0.25 the upload
 * endpoint leaves run=UNSTART until this call is made.
 */
export async function parseDocuments(
  datasetId: string,
  documentIds: string[],
): Promise<void> {
  if (documentIds.length === 0) return;
  const res = await fetch(`${BASE}/api/v1/datasets/${datasetId}/chunks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RAGFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ document_ids: documentIds }),
  });
  if (!res.ok) {
    throw new RagflowError(res.status, await res.text());
  }
}

export async function getDocument(
  datasetId: string,
  docId: string,
): Promise<DocumentInfo> {
  const res = await request<{ data: DocumentInfo }>(
    `/api/v1/datasets/${datasetId}/documents/${docId}`,
  );
  return res.data;
}

// === Retrieval ===

export interface RetrievalChunk {
  chunk_id?: string;             // legacy alias from older Ragflow versions
  id?: string;                   // Ragflow chunk id
  doc_id: string;
  document_id?: string;          // newer Ragflow uses document_id
  docnm_kwd: string;
  document_keyword?: string;     // newer field name
  content: string;
  content_with_weight?: string;
  similarity: number;
  vector_similarity?: number;
  term_similarity?: number;
  score?: number;
  positions?: Array<unknown>;
}

export interface RetrievalResponse {
  chunks: RetrievalChunk[];
  doc_aggs?: Array<{ doc_id: string; doc_name: string; count: number }>;
}

export async function retrieve(
  datasetId: string,
  question: string,
  topK = 6,
): Promise<RetrievalChunk[]> {
  const res = await request<{ data: RetrievalResponse }>(
    `/api/v1/retrieval`,
    {
      method: 'POST',
      body: JSON.stringify({
        question,
        dataset_ids: [datasetId],
        top_k: topK,
        similarity_threshold: 0.2,
        page_size: topK,
      }),
    },
  );
  return res.data.chunks ?? [];
}

// === Health probe ===

export async function ping(): Promise<boolean> {
  try {
    await request(`/api/v1/datasets?page=1&page_size=1`);
    return true;
  } catch {
    return false;
  }
}
