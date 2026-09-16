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
  const res = await request<{ data: { id: string } }>(`/api/v1/datasets`, {
    method: 'POST',
    body: JSON.stringify({ name, description, embedding_model: 'bge-m3-embed@Ollama' }),
  });
  return res.data;
}

// === Documents ===

export type DocRunStatus = '0' | '1' | '2' | '3' | '4';
// 0 pending, 1 parsing, 2 splitting, 3 indexing, 4 done; or 'FAIL' string

export interface DocumentInfo {
  id: string;
  name: string;
  status: DocRunStatus | 'FAIL';
  chunk_count: number;
  run: string;
  create_date: string;
  source_type?: string;
}

export async function addDocumentFromUrl(
  datasetId: string,
  url: string,
): Promise<DocumentInfo> {
  const res = await request<{ data: DocumentInfo[] }>(
    `/api/v1/datasets/${datasetId}/documents`,
    {
      method: 'POST',
      body: JSON.stringify({ name: url, url }),
    },
  );
  const doc = res.data[0];
  if (!doc) throw new RagflowError(500, 'no document returned');
  return doc;
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
  chunk_id: string;
  doc_id: string;
  docnm_kwd: string;
  content_with_weight: string;
  score: number;
  // optional positional hints Ragflow may attach
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
