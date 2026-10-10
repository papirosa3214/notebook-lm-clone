import { describe, expect, it } from 'vitest';
import { parseJson3Transcript } from '../extractors/youtube.js';

describe('parseJson3Transcript', () => {
  it('склеивает сегменты в 30-секундные корзины с метками времени', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Первая' }, { utf8: ' фраза' }] },
        { tStartMs: 5_000, segs: [{ utf8: 'и вторая' }] },
        { tStartMs: 65_000, segs: [{ utf8: 'Минута\nчерез одну' }] },
      ],
    });

    // 65 секунд попадают в корзину, начинающуюся на 60-й секунде.
    expect(parseJson3Transcript(raw)).toBe(
      '[0:00] Первая фраза и вторая\n\n[1:00] Минута через одну',
    );
  });

  it('пропускает события без текста (переносы строк, служебные метки)', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [] },
        { tStartMs: 1000, segs: [{ utf8: '   ' }] },
        { tStartMs: 2000, segs: [{ utf8: 'Слова' }] },
      ],
    });

    expect(parseJson3Transcript(raw)).toBe('[0:00] Слова');
  });

  it('на пустом файле возвращает пустую строку', () => {
    expect(parseJson3Transcript(JSON.stringify({ events: [] }))).toBe('');
    expect(parseJson3Transcript(JSON.stringify({}))).toBe('');
  });
});
