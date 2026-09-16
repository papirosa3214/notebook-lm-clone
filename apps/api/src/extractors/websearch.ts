/**
 * DuckDuckGo HTML search — no API key required.
 * Scrapes https://html.duckduckgo.com/html/?q=... (the lite version,
 * which serves server-rendered HTML and doesn't need JS).
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENDPOINT = 'https://html.duckduckgo.com/html/';

export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`duckduckgo http ${res.status}: ${await res.text()}`);
  }
  const html = await res.text();
  return parseDuckDuckGo(html, maxResults);
}

function parseDuckDuckGo(html: string, maxResults: number): WebSearchResult[] {
  // DDG "html." endpoint renders results as <a class="result__a" href="...">title</a>
  // inside <div class="result ...">. Each result has a snippet <a class="result__snippet">.
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  // Find every result__a anchor and look up its surrounding snippet.
  // We use a regex pass because the DOM is messy whitespace-wise.
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] ? decodeDDGRedirect(m[1]) : '';
    const title = m[2] ? stripTags(m[2]).trim() : '';
    if (!href || !title) continue;
    if (seen.has(href)) continue;
    // Find the next snippet after this link in the document.
    const snippetMatch = html
      .slice(m.index + m[0].length, m.index + m[0].length + 2000)
      .match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch && snippetMatch[1] ? stripTags(snippetMatch[1]).trim() : '';
    if (!href.startsWith('http')) continue;
    seen.add(href);
    results.push({ title, url: href, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function decodeDDGRedirect(href: string): string {
  // DDG wraps external links in //duckduckgo.com/l/?uddg=<encoded>&...
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    /* not a URL, leave as-is */
  }
  return href;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
