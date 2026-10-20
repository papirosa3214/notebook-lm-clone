/**
 * The cover a notebook gets is a picture lifted from its own sources, so
 * this parser is the whole feature: pick the right tag, resolve it
 * against the final URL after redirects, and refuse the junk every real
 * page is full of.
 */
import { describe, expect, it } from 'vitest';
import { extractCoverImage } from '../extractors/url.js';
import { youtubeThumbnailUrl } from '../extractors/youtube.js';

const BASE = 'https://example.com/articles/quantum';

describe('extractCoverImage', () => {
  it('prefers og:image', () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.example.com/hero.jpg">
        <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
      </head></html>`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/hero.jpg');
  });

  it('accepts single-quoted attributes and extra attributes in any order', () => {
    const html = `<meta content='https://cdn.example.com/a.png' property='og:image'>`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/a.png');
  });

  it('falls back to twitter:image when there is no og:image', () => {
    const html = `<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/tw.jpg');
  });

  it('falls back to <link rel="image_src">', () => {
    const html = `<link rel="image_src" href="https://cdn.example.com/link.jpg">`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/link.jpg');
  });

  it('reads image_src with href before rel', () => {
    const html = `<link href="https://cdn.example.com/link2.jpg" rel="image_src">`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/link2.jpg');
  });

  it('resolves a relative path against the page, not the site root', () => {
    const html = `<meta property="og:image" content="/static/hero.png">`;
    expect(extractCoverImage(html, BASE)).toBe('https://example.com/static/hero.png');
  });

  it('resolves a path-relative URL against the current directory', () => {
    const html = `<meta property="og:image" content="cover.jpg">`;
    expect(extractCoverImage(html, BASE)).toBe('https://example.com/articles/cover.jpg');
  });

  it('resolves against the redirected URL when the fetch landed elsewhere', () => {
    // arXiv-style: www → non-www redirect plus a relative og:image. Using
    // the requested URL would point the cover at a 404 host.
    const html = `<meta property="og:image" content="/static/logo.png">`;
    expect(extractCoverImage(html, 'https://arxiv.org/abs/1706.03762')).toBe(
      'https://arxiv.org/static/logo.png',
    );
  });

  it('skips tracking pixels and data URIs, taking the next candidate', () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.com/pixel-1x1.gif">
      <meta name="twitter:image" content="https://cdn.example.com/real.jpg">`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/real.jpg');
  });

  it('skips inline data URIs entirely', () => {
    const html = `
      <meta property="og:image" content="data:image/png;base64,iVBORw0KGgo=">
      <meta name="twitter:image" content="https://cdn.example.com/real.jpg">`;
    expect(extractCoverImage(html, BASE)).toBe('https://cdn.example.com/real.jpg');
  });

  it('returns null rather than falling back to the favicon', () => {
    // A 32×32 icon stretched over a card banner reads as a bug; the
    // notebook draws its own cover instead.
    expect(extractCoverImage('<html><body>hi</body></html>', BASE)).toBeNull();
  });

  it('gives up on a page whose only image is a tracking pixel', () => {
    const html = `<meta property="og:image" content="https://cdn.example.com/pixel.gif">`;
    expect(extractCoverImage(html, BASE)).toBeNull();
  });

  it('returns null rather than throwing on an unparseable base URL', () => {
    expect(extractCoverImage(`<meta property="og:image" content="a.png">`, 'не url')).toBeNull();
  });
});

describe('youtubeThumbnailUrl', () => {
  it('derives the poster frame from the video id', () => {
    expect(youtubeThumbnailUrl('dQw4w9WgXcQ')).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    );
  });

  it('produces a URL with no spaces or query junk', () => {
    expect(youtubeThumbnailUrl('abc123')).not.toMatch(/\s/);
  });
});