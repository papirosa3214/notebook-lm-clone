/**
 * Tests for the Audio Overview script builder.
 *
 * The builder is split in two: `parseScriptText` (pure) and `buildScript`
 * (LLM-driven). We exercise the pure function directly here — it owns
 * all the parsing logic. The end-to-end route is covered by
 * `__tests__/audioOverview.smoke.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { linesToMarkdown, parseScriptText } from '../scriptBuilder.js';

describe('parseScriptText', () => {
  it('parses a clean SCRIPT:/MIRA: stream into lines', () => {
    const out = Array.from(
      parseScriptText(
        [
          'SCRIPT: Привет, это подкаст о [1].',
          'MIRA: Давайте начнём с ключевого тезиса.',
          'SCRIPT: Что думаешь про деталь?',
          'MIRA: Я думаю, тут есть нюанс.',
        ].join('\n'),
      ),
    );
    expect(out).toHaveLength(4);
    expect(out.map((l) => l.speaker)).toEqual(['SCRIPT', 'MIRA', 'SCRIPT', 'MIRA']);
    expect(out[0]!.text).toContain('[1]');
    expect(out[1]!.text).toBe('Давайте начнём с ключевого тезиса.');
  });

  it('fires onLine once per parsed line in order', () => {
    const emitted: string[] = [];
    Array.from(
      parseScriptText(
        'SCRIPT: a\nMIRA: b\nSCRIPT: c',
        (line) => emitted.push(`${line.speaker}: ${line.text}`),
      ),
    );
    expect(emitted).toEqual(['SCRIPT: a', 'MIRA: b', 'SCRIPT: c']);
  });

  it('falls back to SCRIPT when the first line has no prefix', () => {
    const out = Array.from(parseScriptText('Сразу без префикса.\nMIRA: Дальше штатно.'));
    expect(out[0]!.speaker).toBe('SCRIPT');
    expect(out[1]!.speaker).toBe('MIRA');
  });

  it('keeps STAGE directions and renders them as italic markdown', () => {
    const out = Array.from(
      parseScriptText('STAGE: Музыкальная пауза.\nMIRA: Возвращаемся к теме.'),
    );
    expect(out[0]).toEqual({ speaker: 'STAGE', text: 'Музыкальная пауза.' });
    const md = linesToMarkdown(out);
    expect(md).toContain('*Музыкальная пауза.*');
  });

  it('skips blank lines without dropping non-empty ones', () => {
    const out = Array.from(
      parseScriptText('SCRIPT: a\n\n\nMIRA: b\n   \nSCRIPT: c'),
    );
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('returns a single SCRIPT line for a no-prefix blob', () => {
    const out = Array.from(
      parseScriptText('Модель ушла в свободное повествование без префиксов.'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.speaker).toBe('SCRIPT');
  });

  it('accepts full-width colon (：) as a speaker delimiter', () => {
    const out = Array.from(parseScriptText('SCRIPT：a\nMIRA：b'));
    expect(out.map((l) => l.speaker)).toEqual(['SCRIPT', 'MIRA']);
  });

  it('handles an empty string without throwing', () => {
    expect(Array.from(parseScriptText(''))).toEqual([]);
  });
});

describe('linesToMarkdown', () => {
  it('renders SCRIPT/MIRA as bold, STAGE as italic', () => {
    const md = linesToMarkdown([
      { speaker: 'SCRIPT', text: 'a' },
      { speaker: 'MIRA', text: 'b' },
      { speaker: 'STAGE', text: 'пауза' },
    ]);
    expect(md).toContain('**SCRIPT:** a');
    expect(md).toContain('**MIRA:** b');
    expect(md).toContain('*пауза*');
  });
});
