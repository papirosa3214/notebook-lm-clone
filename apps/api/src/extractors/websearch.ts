/**
 * Web search for the Discover flow — no API key required.
 *
 * Primary backend: DuckDuckGo's server-rendered HTML endpoint. DDG
 * throttles per IP and answers automated queries with an "anomaly
 * detected" page returned as **HTTP 202**, which contains zero
 * `result__a` anchors. The old code only threw on `!res.ok`, so a 202
 * parsed to an empty list and the UI showed "Найдено 0" — indistinguishable
 * from "nothing exists", while the real cause was a bot wall.
 *
 * Now the DDG result is treated as authoritative ONLY when it actually
 * parsed something. Otherwise we fan out to keyless knowledge APIs that
 * stay reachable from the same host and merge their hits, so a search
 * returns usable sources instead of nothing.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Every outbound call is bounded — a hanging search must not hang the UI. */
const TIMEOUT_MS = 8000;

async function fetchText(url: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
): Promise<T | null> {
  try {
    const res = await fetchText(url, { Accept: 'application/json', ...headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ============ Primary: DuckDuckGo HTML ============

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** DDG's bot wall. Either signal means "no real results", never "no hits". */
function isDdgBotWall(status: number, html: string): boolean {
  return status === 202 || /anomaly|challenge/i.test(html.slice(0, 4000));
}

async function duckDuckGo(query: string, maxResults: number): Promise<WebSearchResult[]> {
  try {
    const res = await fetchText(`${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`, {
      Accept: 'text/html,application/xhtml+xml',
    });
    const html = await res.text();
    if (!res.ok || isDdgBotWall(res.status, html)) return [];
    return parseDuckDuckGo(html, maxResults);
  } catch {
    return [];
  }
}

function parseDuckDuckGo(html: string, maxResults: number): WebSearchResult[] {
  // DDG "html." renders results as <a class="result__a" href="...">title</a>
  // inside <div class="result ...">, each with a following result__snippet.
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] ? decodeDDGRedirect(m[1]) : '';
    const title = m[2] ? stripTags(m[2]).trim() : '';
    if (!href || !title || !href.startsWith('http') || seen.has(href)) continue;
    const snippetMatch = html
      .slice(m.index + m[0].length, m.index + m[0].length + 2000)
      .match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch?.[1] ? stripTags(snippetMatch[1]).trim() : '';
    seen.add(href);
    results.push({ title, url: href, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function decodeDDGRedirect(href: string): string {
  // DDG wraps outbound links in //duckduckgo.com/l/?uddg=<encoded>&...
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    /* not a URL, leave as-is */
  }
  return href;
}

// ============ Fallbacks: keyless knowledge APIs ============

async function hackerNews(query: string, n: number): Promise<WebSearchResult[]> {
  const data = await fetchJson<{
    hits?: Array<{ title?: string; url?: string; story_text?: string; objectID?: string }>;
  }>(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${n}`);
  return (data?.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title!,
      // Ask HN posts have no external url — link to the discussion itself.
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID ?? ''}`,
      snippet: stripTags(h.story_text ?? '').slice(0, 240),
    }));
}

async function stackExchange(query: string, n: number): Promise<WebSearchResult[]> {
  const data = await fetchJson<{
    items?: Array<{ title?: string; link?: string; body?: string }>;
  }>(
    'https://api.stackexchange.com/2.3/search/advanced' +
      `?order=desc&sort=relevance&site=stackoverflow&pagesize=${n}` +
      `&q=${encodeURIComponent(query)}&filter=withbody`,
  );
  return (data?.items ?? [])
    .filter((i) => i.title && i.link)
    .map((i) => ({
      title: stripTags(i.title!),
      url: i.link!,
      snippet: stripTags(i.body ?? '').slice(0, 240),
    }));
}

async function wikipedia(
  query: string,
  n: number,
  lang: 'en' | 'ru',
): Promise<WebSearchResult[]> {
  const data = await fetchJson<{
    query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
  }>(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*` +
      `&srlimit=${n}&srsearch=${encodeURIComponent(query)}`,
  );
  return (data?.query?.search ?? [])
    .filter((s) => s.title && s.pageid)
    .map((s) => ({
      title: stripTags(s.title!),
      // Link the article itself, not `?curid=`: the latter is a
      // special-redirect URL that some fetchers resolve slowly or not
      // at all, and the page never gets ingested.
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title!.replace(/ /g, '_'))}`,
      snippet: stripTags(s.snippet ?? ''),
    }));
}

async function github(query: string, n: number): Promise<WebSearchResult[]> {
  const data = await fetchJson<{
    items?: Array<{
      full_name?: string;
      html_url?: string;
      description?: string;
      stargazers_count?: number;
    }>;
  }>(
    `https://api.github.com/search/repositories?per_page=${n}&q=${encodeURIComponent(query)}`,
    { Accept: 'application/vnd.github+json' },
  );
  return (data?.items ?? [])
    .filter((i) => i.html_url && i.full_name)
    .map((i) => ({
      title: i.full_name!,
      url: i.html_url!,
      snippet: `${i.description ?? ''}${i.stargazers_count != null ? ` (★ ${i.stargazers_count})` : ''}`.trim(),
    }));
}

async function arxiv(query: string, n: number): Promise<WebSearchResult[]> {
  let xml = '';
  try {
    const res = await fetchText(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${n}`,
      { Accept: 'application/atom+xml' },
    );
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }
  const out: WebSearchResult[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1];
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    if (!title || !link) continue;
    out.push({
      title: stripTags(title),
      url: link.trim(),
      snippet: stripTags(summary ?? '').slice(0, 240),
    });
    if (out.length >= n) break;
  }
  return out;
}

// ============ Relevance filter for the fallback path ============

/** Words that carry no topical signal — matching them proves nothing. */
const STOP = new Set([
  'что','как','для','этот','эта','эти','того','так','при','про','или','если','все','весь',
  'быть','есть','более','менее','очень','также','their','the','and','for','with','that','this',
  'from','are','was','were','will','can','how','what','which','about','into','your','you',
]);

/** Content words of the query, longest first so prefixes match properly. */
function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((w) => !STOP.has(w)) ?? [];
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

/**
 * Does this hit actually talk about the query?
 *
 * Prefix matching, because the same idea is written several ways across
 * languages and forms: "криптография" / "криптографии" / "криптограф".
 * Terms shorter than 4 characters are matched whole — "блокчейн" vs
 * "блок" must not count as a hit.
 */
function matchesTerm(text: string, term: string): boolean {
  if (term.length < 4) return text.includes(term);
  if (text.includes(term)) return true;
  const stem = term.length >= 6 ? term.slice(0, 6) : term;
  return stem.length >= 4 && text.includes(stem);
}

/**
 * Drop fallback hits that ignore the question.
 *
 * The fallback APIs answer *anything*: arxiv matches `all:` and happily
 * returns papers about speech recognition for a question about quantum
 * cryptography. Merged unfiltered, those five confident wrong answers
 * crowd out the good ones and the report cites nothing relevant. A short
 * question is better served by zero hits than by wrong ones — the caller
 * says "ничего не нашлось", which is true and actionable.
 */
function dropIrrelevant(hits: WebSearchResult[], query: string): WebSearchResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return hits;
  // Half the query, rounded down but never below one: a two-word query
  // still needs just one match, a long one needs substance.
  const minHits = Math.max(1, Math.floor(terms.length / 2));
  return hits.filter((h) => {
    const text = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
    return terms.filter((t) => matchesTerm(text, t)).length >= minHits;
  });
}

// ============ Merge ============

/**
 * Round-robin across groups so a single source can't fill the whole list,
 * dropping duplicate URLs (Wikipedia/GitHub/HN overlap surprisingly often).
 */
function interleave(groups: WebSearchResult[][], limit: number): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const g of groups) {
      const item = g[i];
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const ddg = await duckDuckGo(q, maxResults);
  if (ddg.length > 0) return ddg;

  // DDG blocked (or throttled) — fan out to keyless APIs in parallel.
  const groups = await Promise.all([
    hackerNews(q, maxResults),
    stackExchange(q, maxResults),
    // Both language editions: DuckDuckGo — the only engine that ranks a
    // Russian query against Russian pages — currently answers 202, so
    // without ru-wiki every Russian question ends up with nothing.
    wikipedia(q, maxResults, 'en'),
    wikipedia(q, maxResults, 'ru'),
    github(q, maxResults),
    arxiv(q, maxResults),
  ]);
  // These APIs answer anything, so filter before merging — otherwise one
  // chatty source (arxiv especially) fills the whole budget with papers
  // that have nothing to do with the question.
  const relevant = groups.map((g) => dropIrrelevant(g, q));
  return interleave(relevant, maxResults);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
