/**
 * TtsProvider factory tests. We mutate the live `config.TTS_PROVIDER`
 * and call `resetTtsProvider()` so each test gets a fresh instance.
 * Vitest runs files in parallel by default — these tests only touch
 * `config` and the module-level cache, so we mark them serial via
 * `describe.sequential`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../../config.js';
import { getTtsProvider, resetTtsProvider } from '../factory.js';
import { MacSayTtsProvider } from '../macSayTts.js';
import { NoopTtsProvider } from '../noopTts.js';

describe.sequential('TtsProvider factory', () => {
  beforeEach(() => {
    resetTtsProvider();
  });

  it('returns NoopTtsProvider when TTS_PROVIDER=noop (default)', () => {
    (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = 'noop';
    resetTtsProvider();
    expect(getTtsProvider()).toBeInstanceOf(NoopTtsProvider);
  });

  it('returns MacSayTtsProvider when TTS_PROVIDER=mac-say', () => {
    (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = 'mac-say';
    resetTtsProvider();
    expect(getTtsProvider()).toBeInstanceOf(MacSayTtsProvider);
  });

  it('falls back to Noop for unimplemented providers (openai)', () => {
    (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = 'openai';
    resetTtsProvider();
    expect(getTtsProvider()).toBeInstanceOf(NoopTtsProvider);
  });

  it('caches the resolved provider until reset', () => {
    (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = 'noop';
    resetTtsProvider();
    const first = getTtsProvider();
    const second = getTtsProvider();
    expect(first).toBe(second);
  });
});
