/**
 * Thematic grouping of a notebook's sources.
 *
 * A notebook with 30 sources is unusable as one flat list, so the LLM is
 * asked to split them into 2–6 named clusters. The result is cached in
 * the `source_groups` table keyed by a signature over the source set, so
 * the LLM is paid for once per actual change rather than once per panel
 * mount — `SourcesPanel` re-renders on every keystroke of its filter box.
 *
 * Two properties matter more than cluster quality:
 *  - every source lands in exactly one group, so the checkbox scope the
 *    user builds by clicking through the panel stays a partition;
 *  - a failure never loses sources. If the model is down or returns
 *    garbage, `fallbackGroups()` groups by shared topic chips, and if
 *    even that finds nothing the route returns no groups at all and the
 *    UI renders the flat list it always had.
 */

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { notebooks, sourceGroups as sourceGroupsTable, sources } from '../db/schema.js';
import { getProvider } from '../providers/index.js';
import type { ChatStreamEvent } from '@notebook/shared/providers';

export interface SourceGroup {
  title: string;
  sourceIds: string[];
}

interface GroupableSource {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  status: string;
  /** ISO timestamp of the last per-source summary. Part of the cache
   *  signature — re-summarising can change topics, which is exactly what
   *  the clustering is built on. */
  summarizedAt: string | null;
}

/** Below this, grouping adds chrome without adding meaning. */
export const MIN_SOURCES_FOR_GROUPS = 4;
const MAX_GROUPS = 6;
const TITLE_MAX = 60;
/** Characters of summary kept per source — enough for the model to judge. */
const SUMMARY_BUDGET = 240;

/* ------------------------------------------------------------------ */
/* Reading the sources                                                */
/* ------------------------------------------------------------------ */

function readSources(notebookId: string): GroupableSource[] {
  const db = getDb();
  return db
    .select({
      id: sources.id,
      title: sources.title,
      summary: sources.summary,
      summaryTopics: sources.summaryTopics,
      summarizedAt: sources.summarizedAt,
      status: sources.status,
    })
    .from(sources)
    .where(eq(sources.notebookId, notebookId))
    .all()
    .map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary ? r.summary.slice(0, SUMMARY_BUDGET) : null,
      topics: parseTopics(r.summaryTopics),
      status: r.status,
      summarizedAt: r.summarizedAt,
    }));
}

/**
 * Signature over everything the grouping depends on. `summarizedAt` is
 * included so a re-summarised source rebuilds the clusters — its topics
 * may have changed, which is exactly what the grouping is built on.
 */
export function groupsSignature(rows: GroupableSource[]): string {
  const parts = rows
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}|${r.title}|${r.summarizedAt ?? ''}`);
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 6);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic fallback                                             */
/* ------------------------------------------------------------------ */

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

/**
 * Group by shared topic chips when the model is unavailable. Ranks
 * topics by how many sources carry them, opens a group for the strongest
 * ones, and files every source under its first matching topic. Sources
 * with no topics (or none that match) go to «Другие».
 */
export function fallbackGroups(rows: GroupableSource[]): SourceGroup[] {
  if (rows.length < MIN_SOURCES_FOR_GROUPS) return [];

  const topicFrequency = new Map<string, { label: string; ids: string[] }>();
  for (const row of rows) {
    for (const rawTopic of row.topics) {
      const key = normalizeTopic(rawTopic);
      if (!key) continue;
      const entry = topicFrequency.get(key) ?? { label: rawTopic.trim(), ids: [] };
      entry.ids.push(row.id);
      topicFrequency.set(key, entry);
    }
  }

  const ranked = [...topicFrequency.values()]
    .filter((t) => t.ids.length >= 2)
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, MAX_GROUPS - 1);

  if (ranked.length === 0) return [];

  const assigned = new Set<string>();
  const groups: SourceGroup[] = [];
  for (const topic of ranked) {
    const ids = topic.ids.filter((id) => !assigned.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => assigned.add(id));
    groups.push({ title: topic.label, sourceIds: ids });
  }

  const rest = rows.map((r) => r.id).filter((id) => !assigned.has(id));
  if (rest.length > 0) groups.push({ title: 'Другие', sourceIds: rest });
  return groups;
}

/* ------------------------------------------------------------------ */
/* Validation of the model's answer                                   */
/* ------------------------------------------------------------------ */

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, TITLE_MAX);
}

/**
 * Turn the model's reply into a partition of `rows`.
 *
 * Unknown source ids are dropped, and a source claimed by two groups is
 * kept only in the first — a duplicated row in the panel would let the
 * user toggle the same source twice with different outcomes. Returns
 * null when nothing usable survived, so the caller can fall back.
 */
export function validateGroups(parsed: unknown, rows: GroupableSource[]): SourceGroup[] | null {
  if (!Array.isArray(parsed)) return null;
  const known = new Set(rows.map((r) => r.id));
  const seen = new Set<string>();
  const groups: SourceGroup[] = [];

  for (const item of parsed.slice(0, MAX_GROUPS)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { title?: unknown; sourceIds?: unknown };
    const title = cleanTitle(record.title);
    if (!title) continue;

    const rawIds = Array.isArray(record.sourceIds) ? record.sourceIds : [];
    const ids = rawIds
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => known.has(id) && !seen.has(id));
    if (ids.length === 0) continue;

    ids.forEach((id) => seen.add(id));
    groups.push({ title, sourceIds: ids });
  }

  if (groups.length === 0) return null;

  // Anything the model forgot still belongs in the panel.
  const leftovers = rows.map((r) => r.id).filter((id) => !seen.has(id));
  if (leftovers.length > 0) groups.push({ title: 'Другие', sourceIds: leftovers });

  return groups;
}

/* ------------------------------------------------------------------ */
/* Model call                                                         */
/* ------------------------------------------------------------------ */

async function callModel(opts: {
  provider: string;
  model: string;
  rows: GroupableSource[];
}): Promise<unknown | null> {
  const providerId = opts.provider as 'ollama' | 'anthropic' | 'openai';
  const provider = getProvider(providerId);

  const listing = opts.rows
    .map((r, i) => {
      const bits = [`id=${r.id}`];
      if (r.topics.length) bits.push(`темы: ${r.topics.join(', ')}`);
      if (r.summary) bits.push(`суть: ${r.summary}`);
      return `[${i + 1}] ${r.title} — ${bits.join(' | ')}`;
    })
    .join('\n');

  const systemPrompt = [
    'Ты — куратор библиотеки. Ты разбиваешь источники ноутбука на тематические разделы.',
    'Верни строго JSON-массив без markdown-обёрток:',
    '[{"title":"Название раздела на русском","sourceIds":["id1","id2"]}]',
    'Требования: 2–6 разделов, каждый id должен встречаться РОВНО ОДИН РАЗ, id бери только из списка ниже,',
    'название раздела — 1–3 слова, название одного раздела не должно повторяться.',
    'Раздел из одного источника не создавай. Не выдумывай разделы, которых нет в списке.',
  ].join('\n');
  const userPrompt = `Источники ноутбука:\n${listing}`;

  let acc = '';
  try {
    for await (const ev of provider.chat({
      providerId,
      model: opts.model,
      context: [],
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: 800,
    })) {
      const e = ev as ChatStreamEvent;
      if (e.text) acc += e.text;
      if (e.done) break;
    }
  } catch {
    return null;
  }

  const trimmed = acc.trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fence?.[1] ?? trimmed;
  const first = candidate.indexOf('[');
  const last = candidate.lastIndexOf(']');
  const slice = first !== -1 && last > first ? candidate.slice(first, last + 1) : candidate;
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                 */
/* ------------------------------------------------------------------ */

export interface GroupsResult {
  groups: SourceGroup[];
  signature: string;
  /** 'llm' | 'fallback' | 'none' — surfaced in the response so the UI
   *  can stay quiet and the user can tell why sections look rough. */
  strategy: 'llm' | 'fallback' | 'none';
  cached: boolean;
}

function readCached(notebookId: string, signature: string): SourceGroup[] | null {
  const row = getDb()
    .select()
    .from(sourceGroupsTable)
    .where(eq(sourceGroupsTable.notebookId, notebookId))
    .get();
  if (!row || row.signature !== signature) return null;
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return validateGroups(parsed, readSources(notebookId));
  } catch {
    return null;
  }
}

function writeCached(notebookId: string, signature: string, groups: SourceGroup[]): void {
  const db = getDb();
  db.insert(sourceGroupsTable)
    .values({ id: nanoid(12), notebookId, payload: JSON.stringify(groups), signature })
    .onConflictDoUpdate({
      target: sourceGroupsTable.notebookId,
      set: { payload: JSON.stringify(groups), signature, createdAt: new Date().toISOString() },
    })
    .run();
}

/**
 * Return the notebook's thematic groups, rebuilding them only when the
 * source set actually changed (or `force` is set).
 *
 * Never throws — an unreachable LLM degrades to topic-based groups and
 * then to no groups at all.
 */
export async function ensureSourceGroups(
  notebookId: string,
  opts: { provider?: string; model?: string; force?: boolean } = {},
): Promise<GroupsResult> {
  const db = getDb();
  const nb = db
    .select({ id: notebooks.id, defaultProvider: notebooks.defaultProvider, defaultModel: notebooks.defaultModel })
    .from(notebooks)
    .where(eq(notebooks.id, notebookId))
    .get();
  if (!nb) return { groups: [], signature: '', strategy: 'none', cached: false };

  const rows = readSources(notebookId);
  const signature = groupsSignature(rows);

  if (rows.length < MIN_SOURCES_FOR_GROUPS) {
    return { groups: [], signature, strategy: 'none', cached: false };
  }

  if (!opts.force) {
    const cached = readCached(notebookId, signature);
    if (cached) return { groups: cached, signature, strategy: 'llm', cached: true };
  }

  // Group with the notebook's own provider/model, like every other LLM
  // feature here. Defaulting to a hardcoded 'llama3.2' silently fails on
  // any host that doesn't serve it, and the user only sees the flat list.
  const provider = opts.provider ?? nb.defaultProvider;
  const model = opts.model ?? nb.defaultModel;

  const parsed = await callModel({ provider, model, rows });
  const groups = validateGroups(parsed, rows);
  if (groups) {
    writeCached(notebookId, signature, groups);
    return { groups, signature, strategy: 'llm', cached: false };
  }

  const fallback = fallbackGroups(rows);
  if (fallback.length > 0) {
    writeCached(notebookId, signature, fallback);
    return { groups: fallback, signature, strategy: 'fallback', cached: false };
  }

  return { groups: [], signature, strategy: 'none', cached: false };
}