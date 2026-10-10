// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  lineCountFromContent,
  parseAudioFilename,
  parseStatus,
  styleFromMeta,
  durationFromMeta,
} from './ArtifactsPanel';

describe('ArtifactsPanel meta helpers', () => {
  describe('parseAudioFilename', () => {
    it('extracts audioFilename from valid meta JSON', () => {
      expect(parseAudioFilename('{"audioFilename":"abc.mp3"}')).toBe('abc.mp3');
    });
    it('returns null when meta is missing or unparseable', () => {
      expect(parseAudioFilename(null)).toBeNull();
      expect(parseAudioFilename(undefined)).toBeNull();
      expect(parseAudioFilename('not json')).toBeNull();
    });
    it('returns null when audioFilename is explicitly null', () => {
      expect(parseAudioFilename('{"audioFilename":null}')).toBeNull();
    });
  });

  describe('parseStatus', () => {
    it('returns the status field', () => {
      expect(parseStatus('{"status":"ready"}')).toBe('ready');
      expect(parseStatus('{"status":"failed"}')).toBe('failed');
    });
    it('returns null on missing/garbage', () => {
      expect(parseStatus(null)).toBeNull();
      expect(parseStatus('garbage')).toBeNull();
    });
  });

  describe('styleFromMeta', () => {
    it('returns the style when present', () => {
      expect(styleFromMeta('{"style":"short"}')).toBe('short');
    });
    it('returns null on missing meta or unparseable JSON', () => {
      expect(styleFromMeta(null)).toBeNull();
      expect(styleFromMeta('{')).toBeNull();
    });
  });

  describe('durationFromMeta', () => {
    it('formats seconds as MM:SS', () => {
      expect(durationFromMeta('{"durationSec":42}')).toBe('0:42');
      expect(durationFromMeta('{"durationSec":60}')).toBe('1:00');
      expect(durationFromMeta('{"durationSec":125}')).toBe('2:05');
      expect(durationFromMeta('{"durationSec":3600}')).toBe('60:00');
    });
    it('returns null when durationSec is null or zero', () => {
      expect(durationFromMeta('{"durationSec":null}')).toBeNull();
      expect(durationFromMeta('{"durationSec":0}')).toBeNull();
    });
    it('returns null on missing meta or unparseable JSON', () => {
      expect(durationFromMeta(null)).toBeNull();
      expect(durationFromMeta('not json')).toBeNull();
    });
  });

  describe('lineCountFromContent', () => {
    it('counts SCRIPT / MIRA / STAGE lines', () => {
      const md = [
        '**SCRIPT:** Привет',
        '**MIRA:** И тебе',
        '**STAGE:** Пауза',
        '**SCRIPT:** Поехали',
      ].join('\n');
      expect(lineCountFromContent(md)).toBe(4);
    });
    it('returns 0 for an empty or plain body', () => {
      expect(lineCountFromContent('')).toBe(0);
      expect(lineCountFromContent('просто текст без префиксов')).toBe(0);
    });
    it('matches case-insensitively (real transcripts sometimes lowercase the prefix)', () => {
      const md = 'script: a\nmira: b\nscript: c';
      expect(lineCountFromContent(md)).toBe(3);
    });
  });
});
