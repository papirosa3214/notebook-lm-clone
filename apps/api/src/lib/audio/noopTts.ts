import { stat } from 'node:fs/promises';
import type { TtsProvider, TtsRequest, TtsResult } from './tts.js';

/**
 * TTS provider that does nothing.
 *
 * Used when the user explicitly wants "script only" (no audio rendering
 * — useful for reviewing / editing the dialogue before committing to a
 * TTS job), and as the implicit fallback when the configured provider
 * fails on every attempt. The route's persistence layer writes a
 * placeholder `audioFilename=null` and `status='ready'` so the UI can
 * still show the script with a "no audio" badge.
 *
 * This is intentionally cheap to construct — the factory keeps a
 * module-level singleton, the route calls `synthesize` only on jobs
 * that opt in to TTS.
 */
export class NoopTtsProvider implements TtsProvider {
  readonly id = 'noop';

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    // Count non-STAGE lines as a reasonable "duration" estimate so the
    // UI has something to display (≈ 3 words/sec Russian TTS).
    const spoken = req.lines.filter((l) => l.speaker !== 'STAGE');
    const words = spoken.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0);
    const estimatedDurationSec = Math.max(1, Math.round(words / 2.5));

    // We don't write an mp3; we touch a zero-byte file at outputPath so
    // the route's existence check after TTS still passes. The route
    // treats zero-byte files as "no audio" and sets audioFilename=null.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(req.outputPath, '', { flag: 'a' });
    const st = await stat(req.outputPath).catch(() => null);
    return {
      durationSec: estimatedDurationSec,
      bytes: st?.size ?? 0,
    };
  }
}
