/**
 * Fetch a URL and convert HTML → Markdown.
 *
 * We always normalise to Markdown before feeding the local vector store, because
 * the local splitter works best on flat text — raw HTML produces one giant first
 * chunk that doesn't fit a useful retrieval unit.
 */

export class FetchError extends Error {
  constructor(public status: number, message: string) {
    super(`Fetch ${status}: ${message}`);
    this.name = 'FetchError';
  }
}

export async function fetchUrlToMarkdown(
  url: string,
): Promise<{ markdown: string; title: string; coverImage: string | null }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NotebookBot/0.1)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new FetchError(res.status, `fetch ${url} failed: ${res.statusText}`);
  }
  const raw = await res.text();
  const title = extractTitle(raw) ?? new URL(url).hostname;
  // Resolve the picture against the *final* URL, not the one we asked
  // for — most sites redirect www/non-www and emit a relative og:image.
  const baseUrl = res.url || url;
  const coverImage = extractCoverImage(raw, baseUrl);
  const stripped = stripNonContent(raw);
  // html2text is CommonJS-only — use createRequire so it works under ESM/tsx.
  const { createRequire } = await import('node:module');
  const requireFromHere = createRequire(import.meta.url);
  const { htmlToText } = requireFromHere('html2text') as {
    htmlToText: (html: string, opts?: Record<string, unknown>) => string;
  };
  const md = htmlToText(stripped, {
    wordwrap: false,
    preserveImageAlt: false,
    uppercaseHeadings: false,
  });
  const markdown = md.replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, title, coverImage };
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

/** Skip tiny tracking pixels and data URIs — they make a useless cover. */
function isUsableImage(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('data:')) return false;
  return !/(pixel|spacer|blank|1x1|beacon|transparent)/i.test(src);
}

/**
 * Read every <meta property/name="…"> pair into a map.
 *
 * Attribute order is not fixed in real pages, so `content` may come
 * before `property`; a single combined regex silently misses those and
 * falls through to the favicon. Parsing the tag's own attributes is the
 * only order-independent way to do it.
 */
function readMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const tagRe = /<meta\b([^>]*)>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const attrs = tag[1] ?? '';
    const key = readAttr(attrs, /(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const content = readAttr(attrs, /content\s*=\s*["']([^"']*)["']/i);
    if (!key || !content) continue;
    const k = key.trim().toLowerCase();
    if (!out.has(k)) out.set(k, content.trim());
  }
  return out;
}

function readAttr(attrs: string, re: RegExp): string | null {
  const m = attrs.match(re);
  return m?.[1] ?? null;
}

/** `<link rel="image_src" href="…">`, attribute order independent. */
function readImageSrcLink(html: string): string | null {
  const tagRe = /<link\b([^>]*)>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const attrs = tag[1] ?? '';
    const rel = readAttr(attrs, /rel\s*=\s*["']([^"']+)["']/i);
    if (!rel || !/image_src/i.test(rel)) continue;
    return readAttr(attrs, /href\s*=\s*["']([^"']+)["']/i);
  }
  return null;
}

/**
 * Pick the picture a page declares as its own face.
 *
 * Order follows what social previews actually use: og:image, then
 * twitter:image, then <link rel="image_src">. Deliberately no favicon
 * fallback — a 32×32 icon stretched across a card banner looks like a
 * bug, and the notebook falls back to a drawn cover instead, which is
 * honest about having no real picture.
 */
export function extractCoverImage(html: string, baseUrl: string): string | null {
  const meta = readMetaTags(html);
  const candidates = [
    meta.get('og:image:secure_url'),
    meta.get('og:image'),
    meta.get('twitter:image:src'),
    meta.get('twitter:image'),
    readImageSrcLink(html),
  ];

  for (const raw of candidates) {
    if (!raw || !isUsableImage(raw)) continue;
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}