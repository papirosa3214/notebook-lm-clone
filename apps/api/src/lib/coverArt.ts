/**
 * Notebook cover art.
 *
 * The model is never allowed to emit markup. It answers with a small
 * JSON recipe — three hex colours, one motif name, one symbol name and
 * a short tagline — and `renderCoverSvg()` draws that recipe with our
 * own hand-written geometry. That keeps the output valid SVG by
 * construction, keeps the endpoint free of any image-generation
 * dependency, and makes the same recipe render identically everywhere.
 *
 * Everything degrades: if the LLM is unreachable, times out, returns
 * prose, or invents a colour that is not a hex string, the missing
 * pieces are filled from a deterministic recipe derived from the
 * notebook title. A notebook therefore never shows an empty cover.
 */

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { getProvider } from '../providers/index.js';
import type { ChatStreamEvent } from '@notebook/shared/providers';

export const COVER_MOTIFS = ['waves', 'grid', 'circles', 'rays', 'bars', 'dots'] as const;
export const COVER_SYMBOLS = [
  'book',
  'magnifier',
  'brain',
  'chart',
  'rocket',
  'leaf',
  'code',
  'network',
] as const;

export type CoverMotif = (typeof COVER_MOTIFS)[number];
export type CoverSymbol = (typeof COVER_SYMBOLS)[number];

export interface CoverSpec {
  /** Gradient stops, back to front. Always 3 validated hex colours. */
  palette: [string, string, string];
  motif: CoverMotif;
  symbol: CoverSymbol;
  /** Short line rendered on the cover. Empty string when unknown. */
  tagline: string;
  /** What the recipe was built from: the title alone, or the sources too. */
  basedOn: 'title' | 'sources';
  /** Hash of the inputs. Equal signature → the recipe is still current. */
  signature: string;
  generatedAt: string;
}

const TAGLINE_MAX = 48;

/* ------------------------------------------------------------------ */
/* Deterministic fallback                                             */
/* ------------------------------------------------------------------ */

/** FNV-1a — small, stable across runs, no crypto cost. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Curated palettes. The model may pick its own colours, but when it
 * doesn't we rotate through these rather than hashing arbitrary HSL —
 * every pair here was chosen to stay legible with white foreground
 * text, which is what the card overlays.
 */
const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#1E3A8A', '#3B82F6', '#93C5FD'], // синий
  ['#4C1D95', '#7C3AED', '#C4B5FD'], // фиолетовый
  ['#134E4A', '#14B8A6', '#99F6E4'], // бирюзовый
  ['#7C2D12', '#F97316', '#FDBA74'], // оранжевый
  ['#831843', '#DB2777', '#F9A8D4'], // розовый
  ['#164E63', '#0891B2', '#A5F3FC'], // циан
  ['#365314', '#65A30D', '#D9F99D'], // зелёный
  ['#1C1917', '#57534E', '#D6D3D1'], // графит
];

/**
 * Build a usable recipe from the title alone. Deterministic: the same
 * title always produces the same cover, which matters because this is
 * also what un-summarised notebooks render.
 */
export function fallbackCoverSpec(
  title: string,
  opts: { basedOn?: 'title' | 'sources'; signature?: string } = {},
): CoverSpec {
  const seed = hashString(title.trim().toLowerCase() || 'untitled');
  const palette = PALETTES[seed % PALETTES.length]!;
  return {
    palette: [palette[0], palette[1], palette[2]],
    motif: COVER_MOTIFS[(seed >>> 3) % COVER_MOTIFS.length]!,
    symbol: COVER_SYMBOLS[(seed >>> 8) % COVER_SYMBOLS.length]!,
    tagline: '',
    basedOn: opts.basedOn ?? 'title',
    signature: opts.signature ?? `title:${hashString(title.trim())}`,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Accept only 6-digit hex. Anything else falls back to the curated palette. */
export function sanitizePalette(value: unknown): [string, string, string] | null {
  if (!Array.isArray(value)) return null;
  const colors = value
    .slice(0, 3)
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .map((c) => (c.startsWith('#') ? c : `#${c}`))
    .filter((c) => HEX_RE.test(c))
    .map((c) => c.toUpperCase());
  if (colors.length < 2) return null;
  while (colors.length < 3) colors.push(colors[colors.length - 1]!);
  return [colors[0]!, colors[1]!, colors[2]!];
}

export function sanitizeMotif(value: unknown): CoverMotif | null {
  return typeof value === 'string' && (COVER_MOTIFS as readonly string[]).includes(value)
    ? (value as CoverMotif)
    : null;
}

export function sanitizeSymbol(value: unknown): CoverSymbol | null {
  return typeof value === 'string' && (COVER_SYMBOLS as readonly string[]).includes(value)
    ? (value as CoverSymbol)
    : null;
}

/** Strip control characters and cap the length. Text-only, never markup. */
export function sanitizeTagline(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, TAGLINE_MAX);
}

/**
 * Parse the model's reply into a recipe. Tolerant of markdown fences
 * and a leading prose paragraph, like the rest of the codebase's JSON
 * handling. Missing fields are filled from the deterministic fallback.
 */
export function parseCoverResponse(raw: string, title: string): CoverSpec | null {
  const fallback = fallbackCoverSpec(title);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    const palette = sanitizePalette(obj.palette);
    const motif = sanitizeMotif(obj.motif);
    const symbol = sanitizeSymbol(obj.symbol);
    if (!palette && !motif && !symbol) continue; // useless reply, try next

    return {
      palette: palette ?? fallback.palette,
      motif: motif ?? fallback.motif,
      symbol: symbol ?? fallback.symbol,
      tagline: sanitizeTagline(obj.tagline),
      basedOn: fallback.basedOn,
      signature: fallback.signature,
      generatedAt: fallback.generatedAt,
    };
  }
  return null;
}

/** Parse a stored recipe back, repairing anything a past bug let through. */
export function reviveCoverSpec(raw: string | null | undefined, title: string): CoverSpec {
  const fallback = fallbackCoverSpec(title);
  if (!raw) return fallback;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const palette = sanitizePalette(obj.palette) ?? fallback.palette;
    return {
      palette,
      motif: sanitizeMotif(obj.motif) ?? fallback.motif,
      symbol: sanitizeSymbol(obj.symbol) ?? fallback.symbol,
      tagline: sanitizeTagline(obj.tagline),
      basedOn: obj.basedOn === 'sources' ? 'sources' : 'title',
      signature: typeof obj.signature === 'string' ? obj.signature : fallback.signature,
      generatedAt:
        typeof obj.generatedAt === 'string' ? obj.generatedAt : fallback.generatedAt,
    };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Generation                                                         */
/* ------------------------------------------------------------------ */

export interface SourceTopicHint {
  title: string;
  topics: string[];
}

/** Signature covering everything the recipe depends on. */
export function coverSignature(title: string, hints: SourceTopicHint[] = []): string {
  const parts = [
    'title',
    title.trim(),
    ...hints
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((h) => `${h.title}|${[...h.topics].sort().join(',')}`),
  ];
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

async function collectLlm(
  providerId: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string | null> {
  const provider = getProvider(providerId as 'ollama' | 'anthropic' | 'openai');
  let acc = '';
  try {
    for await (const ev of provider.chat({
      providerId: providerId as 'ollama' | 'anthropic' | 'openai',
      model,
      context: [],
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      maxTokens,
    })) {
      const e = ev as ChatStreamEvent;
      if (e.text) acc += e.text;
      if (e.done) break;
    }
  } catch {
    return null;
  }
  return acc || null;
}

/**
 * Ask the model for a cover recipe. Returns the deterministic fallback
 * when the model fails — this function never throws and never returns
 * null, so callers can fire it in the background without a try/catch.
 */
export async function generateCoverSpec(opts: {
  title: string;
  hints?: SourceTopicHint[];
  provider: string;
  model: string;
}): Promise<CoverSpec> {
  const hints = opts.hints ?? [];
  const signature = coverSignature(opts.title, hints);
  const basedOn: 'title' | 'sources' = hints.length > 0 ? 'sources' : 'title';
  const fallback = fallbackCoverSpec(opts.title, { basedOn, signature });

  const systemPrompt = [
    'Ты — арт-директор обложек. Ты НЕ пишешь SVG и НЕ пишешь код.',
    'Верни строго JSON без markdown-обёрток:',
    '{"palette":["#RRGGBB","#RRGGBB","#RRGGBB"],"motif":"waves|grid|circles|rays|bars|dots",',
    '"symbol":"book|magnifier|brain|chart|rocket|leaf|code|network","tagline":"до 4 слов на русском"}',
    'Палитра: от тёмного к светлому, все три цвета заметно различаются, светлые акценты — белые или светлые.',
    'Мотив — геометрический фон, символ — что изображает тема. Отвечай один раз, без пояснений.',
  ].join('\n');

  const topicLines = hints
    .slice(0, 12)
    .map((h) => `- ${h.title}${h.topics.length ? ` (${h.topics.slice(0, 4).join(', ')})` : ''}`)
    .join('\n');
  const userPrompt = [
    `Тема ноутбука: ${opts.title}`,
    topicLines ? `\nИсточники ноутбука:\n${topicLines}` : '',
  ].join('');

  const raw = await collectLlm(opts.provider, opts.model, systemPrompt, userPrompt, 200);
  if (!raw) return fallback;

  const parsed = parseCoverResponse(raw, opts.title);
  if (!parsed) return fallback;

  return {
    ...parsed,
    basedOn,
    signature,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

/** Read the stored recipe, falling back to one derived from the title. */
export function readCoverSpec(notebookId: string): CoverSpec {
  const db = getDb();
  const nb = db
    .select({ title: notebooks.title, coverSpec: notebooks.coverSpec })
    .from(notebooks)
    .where(eq(notebooks.id, notebookId))
    .get();
  if (!nb) return fallbackCoverSpec('');
  return reviveCoverSpec(nb.coverSpec, nb.title);
}

function writeCoverSpec(notebookId: string, spec: CoverSpec): void {
  getDb()
    .update(notebooks)
    .set({ coverSpec: JSON.stringify(spec) })
    .where(eq(notebooks.id, notebookId))
    .run();
}

/** True when at least one source of the notebook offered a real picture. */
export function hasSourcePicture(notebookId: string): boolean {
  const row = getDb()
    .select({ coverImage: sources.coverImage })
    .from(sources)
    .where(eq(sources.notebookId, notebookId))
    .all()
    .find((r) => Boolean(r.coverImage));
  return Boolean(row?.coverImage);
}

/** Topic hints from summarized sources — what makes the cover specific. */
export function readSourceTopicHints(notebookId: string): SourceTopicHint[] {
  const db = getDb();
  const rows = db
    .select({ title: sources.title, summaryTopics: sources.summaryTopics })
    .from(sources)
    .where(eq(sources.notebookId, notebookId))
    .all();
  return rows.map((r) => ({
    title: r.title,
    topics: safeTopics(r.summaryTopics),
  }));
}

function safeTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === 'string').slice(0, 6);
  } catch {
    return [];
  }
}

export interface EnsureCoverResult {
  spec: CoverSpec;
  /** False when the stored recipe already matched the signature. */
  changed: boolean;
}

/**
 * Ensure a notebook has a current cover. Regenerates only when the
 * inputs moved (new sources, re-summarised summaries) or when forced.
 *
 * Never throws: a failed LLM call leaves the stored recipe alone and
 * the caller still gets a renderable spec.
 */
export async function ensureCoverSpec(
  notebookId: string,
  opts: { provider?: string; model?: string; force?: boolean } = {},
): Promise<EnsureCoverResult> {
  const db = getDb();
  const nb = db
    .select({
      title: notebooks.title,
      coverSpec: notebooks.coverSpec,
      defaultProvider: notebooks.defaultProvider,
      defaultModel: notebooks.defaultModel,
    })
    .from(notebooks)
    .where(eq(notebooks.id, notebookId))
    .get();
  if (!nb) return { spec: fallbackCoverSpec(''), changed: false };

  const hints = readSourceTopicHints(notebookId);
  const signature = coverSignature(nb.title, hints);
  const current = reviveCoverSpec(nb.coverSpec, nb.title);

  if (!opts.force && nb.coverSpec && current.signature === signature) {
    return { spec: current, changed: false };
  }

  // The notebook's own provider/model — a hardcoded default would fail
  // on every host that doesn't serve it and leave the title-derived
  // recipe in place forever.
  const provider = opts.provider ?? nb.defaultProvider;
  const model = opts.model ?? nb.defaultModel;
  const spec = await generateCoverSpec({
    title: nb.title,
    hints,
    provider,
    model,
  });

  // The LLM path can degrade to the deterministic recipe — in that case
  // storing it would pin a title-only cover to a sources signature and
  // suppress every later regeneration. Keep the previous recipe instead
  // so the next call retries the model.
  const degraded = spec.palette.join('') === fallbackCoverSpec(nb.title).palette.join('');
  if (degraded && !opts.force) {
    return { spec: current, changed: false };
  }

  writeCoverSpec(notebookId, spec);
  return { spec, changed: true };
}

/* ------------------------------------------------------------------ */
/* SVG rendering                                                      */
/* ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Escape text for XML content. The tagline is the only free-text node. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function motifMarkup(motif: CoverMotif, accent: string, w: number, h: number): string {
  switch (motif) {
    case 'waves': {
      const paths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const y = h * (0.25 + i * 0.15);
        const amp = h * 0.06;
        paths.push(
          `<path d="M0 ${y.toFixed(1)} C ${(w * 0.25).toFixed(1)} ${(y - amp).toFixed(1)}, ${(w * 0.75).toFixed(1)} ${(y + amp).toFixed(1)}, ${w} ${y.toFixed(1)}" fill="none" stroke="${accent}" stroke-opacity="0.28" stroke-width="${(h * 0.018).toFixed(1)}"/>`,
        );
      }
      return paths.join('');
    }
    case 'grid': {
      const cells: string[] = [];
      const cols = 7;
      const rows = 4;
      const cw = w / cols;
      const ch = h / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Skip a few cells so the grid reads as a pattern, not a table.
          if ((r * 3 + c * 5) % 7 === 0) continue;
          cells.push(
            `<rect x="${(c * cw + cw * 0.14).toFixed(1)}" y="${(r * ch + ch * 0.14).toFixed(1)}" width="${(cw * 0.72).toFixed(1)}" height="${(ch * 0.72).toFixed(1)}" rx="${(cw * 0.14).toFixed(1)}" fill="${accent}" fill-opacity="0.14"/>`,
          );
        }
      }
      return cells.join('');
    }
    case 'circles': {
      const circles: string[] = [];
      for (let i = 0; i < 6; i++) {
        const cx = w * (0.1 + (i % 3) * 0.4);
        const cy = h * (0.2 + Math.floor(i / 3) * 0.5);
        const r = h * (0.18 + (i % 2) * 0.1);
        circles.push(
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${accent}" stroke-opacity="0.3" stroke-width="${(h * 0.016).toFixed(1)}"/>`,
        );
      }
      return circles.join('');
    }
    case 'rays': {
      const rays: string[] = [];
      const cx = w * 0.8;
      const cy = h * 0.15;
      for (let i = 0; i < 9; i++) {
        const a = (i * Math.PI) / 9;
        const x = cx + Math.cos(a) * w;
        const y = cy + Math.sin(a) * w;
        rays.push(
          `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${accent}" stroke-opacity="0.18" stroke-width="${(h * 0.014).toFixed(1)}"/>`,
        );
      }
      return rays.join('');
    }
    case 'bars': {
      const bars: string[] = [];
      const count = 9;
      const bw = (w * 0.8) / count;
      for (let i = 0; i < count; i++) {
        // Deterministic pseudo-height — no Math.random(), or the same
        // cover would differ on every request and defeat caching.
        const t = (Math.sin(i * 1.7) + 1) / 2;
        const bh = h * (0.12 + t * 0.45);
        bars.push(
          `<rect x="${(w * 0.1 + i * bw).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${bh.toFixed(1)}" rx="${(bw * 0.2).toFixed(1)}" fill="${accent}" fill-opacity="0.22"/>`,
        );
      }
      return bars.join('');
    }
    case 'dots': {
      const dots: string[] = [];
      const cols = 9;
      const rows = 5;
      const sx = w / cols;
      const sy = h / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const t = (Math.sin(r * 2.3 + c * 1.1) + 1) / 2;
          dots.push(
            `<circle cx="${(c * sx + sx * 0.5).toFixed(1)}" cy="${(r * sy + sy * 0.5).toFixed(1)}" r="${(sx * (0.12 + t * 0.2)).toFixed(1)}" fill="${accent}" fill-opacity="${(0.12 + t * 0.3).toFixed(2)}"/>`,
          );
        }
      }
      return dots.join('');
    }
  }
}

/**
 * Symbol geometry, drawn inside a 100×100 box. Each entry returns
 * stroke-based paths so the glyph inherits one width and one colour.
 */
const SYMBOL_PATHS: Record<CoverSymbol, string> = {
  book: 'M20 30 Q35 22 50 32 L50 74 Q35 64 20 72 Z M50 32 Q65 22 80 30 L80 72 Q65 64 50 74',
  magnifier: 'M44 20 A24 24 0 1 0 44 68 A24 24 0 1 0 44 20 M62 62 L82 82',
  brain:
    'M50 24 C40 18 28 24 28 36 C20 40 20 54 28 58 C28 70 40 76 50 70 C60 76 72 70 72 58 C80 54 80 40 72 36 C72 24 60 18 50 24 M50 24 L50 70',
  chart: 'M22 78 L22 22 M22 78 L80 78 M32 66 L32 46 M48 66 L48 32 M64 66 L64 40 M80 66 L80 26',
  rocket:
    'M50 14 C60 26 64 40 62 54 L38 54 C36 40 40 26 50 14 M38 54 L28 70 L38 66 L44 76 M62 54 L72 70 L62 66 L56 76 M46 60 L46 68 M54 60 L54 68',
  leaf: 'M50 20 C74 30 76 58 50 78 C24 58 26 30 50 20 M50 78 L50 44',
  code: 'M36 34 L18 50 L36 66 M64 34 L82 50 L64 66 M56 26 L44 74',
  network:
    'M50 30 L26 44 M50 30 L74 44 M50 30 L50 66 M26 44 L26 68 M74 44 L74 68 M26 68 L50 78 M74 68 L50 78',
};

/**
 * Render a recipe as a self-contained SVG string. Deterministic: the
 * same spec always produces byte-identical output, so the route can
 * serve it with a long-lived cache header.
 */
export function renderCoverSvg(
  spec: CoverSpec,
  opts: { width?: number; height?: number } = {},
): string {
  const w = Math.max(64, Math.min(2048, Math.round(opts.width ?? 640)));
  const h = Math.max(36, Math.min(2048, Math.round(opts.height ?? 360)));
  const [c0, c1, c2] = spec.palette;
  const gid = `g${hashString(`${c0}${c1}${c2}${spec.motif}${spec.symbol}`).toString(36)}`;
  const sid = `${gid}s`;

  const symbolSize = h * 0.42;
  const symbolX = w * 0.5 - symbolSize / 2;
  const symbolY = h * 0.36 - symbolSize / 2;

  // Palettes end in a light accent, so white text over the bottom of the
  // gradient can land on near-white. The scrim keeps the tagline legible
  // whatever the model picked.
  const scrim =
    spec.tagline || spec.symbol
      ? `<linearGradient id="${sid}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0.35" stop-color="#000000" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="#000000" stop-opacity="0.42"/>` +
        `</linearGradient>`
      : '';

  const tagline = spec.tagline
    ? `<text x="${(w / 2).toFixed(1)}" y="${(h * 0.88).toFixed(1)}" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="${(h * 0.07).toFixed(1)}" fill="#FFFFFF" fill-opacity="0.96">${xmlEscape(spec.tagline)}</text>`
    : '';

  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${xmlEscape(spec.tagline || 'Обложка ноутбука')}">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c0}"/><stop offset="0.55" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
    `</linearGradient>${scrim}</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#${gid})"/>` +
    motifMarkup(spec.motif, '#FFFFFF', w, h) +
    // Scrim sits above the motif but below the glyph and the tagline.
    (scrim ? `<rect width="${w}" height="${h}" fill="url(#${sid})"/>` : '') +
    `<g transform="translate(${symbolX.toFixed(1)} ${symbolY.toFixed(1)}) scale(${(symbolSize / 100).toFixed(3)})" fill="none" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${SYMBOL_PATHS[spec.symbol]}"/></g>` +
    tagline +
    `</svg>`;
}