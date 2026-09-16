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
): Promise<{ markdown: string; title: string }> {
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