import { config } from '../../config.js';
import type { TtsProvider } from './tts.js';
import { NoopTtsProvider } from './noopTts.js';

/**
 * Resolve the active TtsProvider from environment configuration.
 *
 * - `TTS_PROVIDER=noop`  (default) — script-only mode. No audio.
 *   Safe for the first iteration while we pick / set up a real TTS
 *   engine.
 * - `TTS_PROVIDER=openai` — OpenAI TTS (`/v1/audio/speech`), needs
 *   `OPENAI_API_KEY`. Two voices per line via `voices` map.
 * - `TTS_PROVIDER=mac-say` — dev fallback using `/usr/bin/say` on
 *   macOS. Robotic but free and offline.
 *
 * The OpenAI and MacSay providers will land in subsequent commits;
 * for now the factory returns Noop for any non-'noop' value so the
 * route can be wired and tested end-to-end before we pick an engine.
 *
 * The returned instance is cached at module level.
 */
let cached: TtsProvider | null = null;

export function getTtsProvider(): TtsProvider {
  if (cached) return cached;
  cached = resolveTtsProvider();
  return cached;
}

export function resetTtsProvider(): void {
  cached = null;
}

function resolveTtsProvider(): TtsProvider {
  const id = (config.TTS_PROVIDER ?? 'noop').toLowerCase();
  switch (id) {
    case 'openai':
    case 'mac-say':
    case 'macsay':
    case 'kokoro':
      // Real providers land in subsequent commits. Until then we
      // surface a clear log line and return Noop so the route still
      // works (script-only output).
      // eslint-disable-next-line no-console
      console.warn(
        `[audio] TTS_PROVIDER=${id} requested but not yet implemented; ` +
          `falling back to noop. Set TTS_PROVIDER=noop to silence this.`,
      );
      return new NoopTtsProvider();
    case 'noop':
    default:
      return new NoopTtsProvider();
  }
}
