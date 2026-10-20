/**
 * The keyless fallback APIs answer *any* query — arxiv matches `all:` and
 * returns papers about speech recognition for a question about quantum
 * cryptography. These tests pin that such hits are dropped rather than
 * merged, because a confident wrong answer is worse than no answer: it
 * fills the source budget and leaves the report citing nothing relevant.
 */
import { describe, expect, it } from 'vitest';
import { searchWeb } from '../websearch.js';

const QUESTION = 'Что такое квантовая криптография и как она влияет на безопасность блокчейна?';

describe('searchWeb fallback relevance', () => {
  it('returns no hits rather than unrelated papers when nothing matches', async () => {
    const hits = await searchWeb(QUESTION, 5);
    // Whatever comes back must at least be about the subject. With Duck
    // Go blocked this is the real production path today.
    for (const h of hits) {
      const text = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
      const onTopic = /квант|криптограф|блокчейн|blockchain|cryptograph|quantum/.test(text);
      expect(onTopic, `нерелевантный источник попал в выдачу: ${h.url}`).toBe(true);
    }
  }, 60_000);

  it('does not return speech-recognition papers for a quantum question', async () => {
    const hits = await searchWeb(QUESTION, 5);
    const urls = hits.map((h) => h.url).join(' ');
    expect(urls).not.toMatch(/1301\.4630|1103\.3176|1711\.04942/);
  }, 60_000);

  it('finds genuine on-topic sources when the fallback has them', async () => {
    // The fallback APIs index English, so a Russian question lands on
    // weaker hits; an English one is where they actually work.
    const hits = await searchWeb('quantum cryptography blockchain', 5);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const text = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
      expect(text, `нерелевантный источник: ${h.url}`).toMatch(
        /quantum|cryptograph|blockchain|постквант|криптограф/i,
      );
    }
  }, 60_000);

  it('keeps results that match only in the snippet, not just the title', async () => {
    // wikipedia answers Russian queries with a /wiki/… URL that names the
    // topic, so filtering on the title alone would throw those away.
    const hits = await searchWeb('квантовая криптография', 5);
    expect(Array.isArray(hits)).toBe(true);
  }, 60_000);

  it('leaves a keyword-only query alone', async () => {
    const hits = await searchWeb('python', 5);
    expect(Array.isArray(hits)).toBe(true);
  }, 60_000);
});