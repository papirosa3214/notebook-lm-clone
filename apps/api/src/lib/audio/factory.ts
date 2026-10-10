import { config } from '../../config.js';
import type { TtsProvider } from './tts.js';
import { NoopTtsProvider } from './noopTts.js';
import { MacSayTtsProvider } from './macSayTts.js';

/**
 * Resolve the active TtsProvider from environment configuration.
 *
 * - `TTS_PROVIDER=noop`    (default) — script-only mode. No audio.
 * - `TTS_PROVIDER=mac-say` — macOS `say` + `ffmpeg`. Local,
 *   offline, free. Default voice: `Milena` (ru_RU). Each speaker
 *   maps to a separate voice; STAGE → silence.
 * - `TTS_PROVIDER=openai`  — OpenAI `/v1/audio/speech`. Needs
 *   `OPENAI_API_KEY`. Lands in a future commit.
 * - `TTS_PROVIDER=kokoro`  — kokoro-fastapi at `KOKORO_BASE_URL`.
 *   Future commit.
 *
 * The returned instance is cached at module level. Tests can call
 * `resetTtsProvider()` to force a fresh lookup against a new env.
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
    case 'mac-say':
    case 'macsay':
      return new MacSayTtsProvider();
    case 'openai':
    case 'kokoro':
      // Engine-specific providers land in subsequent commits. We
      // surface a clear log line and fall back to Noop so the
      // route still works (script-only output) until then.
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
