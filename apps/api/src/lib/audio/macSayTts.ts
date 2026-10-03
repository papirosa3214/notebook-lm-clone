import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TtsProvider, TtsRequest, TtsResult } from './tts.js';

const SAY_BIN = '/usr/bin/say';
const FFMPEG_BIN = 'ffmpeg';

const PER_LINE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * macOS `say` TTS provider.
 *
 * Strategy: one `say` invocation per non-STAGE line, render to AIFF,
 * ffmpeg-convert to MP3 chunks, then ffmpeg-concat into a single MP3
 * (with silence padding for STAGE pauses). The provider is best-
 * effort: any spawn / ffmpeg failure throws and the route catches.
 *
 * Voice mapping (overridable via the `voices` field on TtsRequest):
 *   - SCRIPT → 'Milena'   (default host; en/ru voice, Apple)
 *   - MIRA   → 'Milena'   (no second native Russian voice that's
 *                          consistently available across macOS
 *                          versions; using the same voice with
 *                          slightly higher pitch via ffmpeg is
 *                          a future enhancement)
 *   - STAGE  → silence     (treated as a 0.8 s pause)
 *
 * The provider depends on `/usr/bin/say` and `ffmpeg` being on
 * PATH. On non-macOS hosts the spawn will fail with ENOENT and
 * the route marks the artifact as failed. Set TTS_PROVIDER=noop
 * for those environments.
 */
export class MacSayTtsProvider implements TtsProvider {
  readonly id = 'mac-say';

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (req.lines.length === 0) {
      throw new Error('MacSayTtsProvider: empty lines');
    }
    const voiceForSpeaker = (sp: 'SCRIPT' | 'MIRA' | 'STAGE'): string | null => {
      if (sp === 'STAGE') return null; // silence
      return req.voices?.[sp] ?? 'Milena';
    };
    const stagePauseSec = 0.8;

    const tmpDir = await mkdtemp(join(tmpdir(), 'tts-macsay-'));
    const start = Date.now();
    try {
      // 1. Render each line to an MP3 chunk (or silence for STAGE).
      const chunks: string[] = [];
      for (let i = 0; i < req.lines.length; i++) {
        if (Date.now() - start > TOTAL_TIMEOUT_MS) {
          throw new Error('MacSayTtsProvider: total timeout exceeded');
        }
        const line = req.lines[i]!;
        const chunkPath = join(tmpDir, `chunk-${String(i).padStart(3, '0')}.mp3`);
        if (line.speaker === 'STAGE') {
          // Synthesize silence of the requested duration. We
          // approximate the pause by routing through ffmpeg's
          // anullsrc filter with a fixed 0.8 s — the LLM is
          // expected to keep STAGE lines short ("Музыкальная пауза").
          await runFfmpeg(
            [
              '-y',
              '-f', 'lavfi',
              '-i', `anullsrc=r=22050:cl=mono`,
              '-t', String(stagePauseSec),
              '-q:a', '9',
              '-codec:a', 'libmp3lame',
              chunkPath,
            ],
            PER_LINE_TIMEOUT_MS,
          );
        } else {
          const voice = voiceForSpeaker(line.speaker);
          if (!voice) {
            throw new Error(`MacSayTtsProvider: no voice for ${line.speaker}`);
          }
          const aiffPath = join(tmpDir, `chunk-${String(i).padStart(3, '0')}.aiff`);
          // `say` writes an AIFF. `-o` accepts a file path. We pass
          // the text last; if the LLM emits a stray double-quote the
          // shell would still see it as part of the text because
          // we use spawn (no shell).
          await runSay(['-v', voice, '-o', aiffPath, line.text], PER_LINE_TIMEOUT_MS);
          // AIFF → MP3.
          await runFfmpeg(
            [
              '-y',
              '-i', aiffPath,
              '-codec:a', 'libmp3lame',
              '-b:a', '96k',
              chunkPath,
            ],
            PER_LINE_TIMEOUT_MS,
          );
        }
        chunks.push(chunkPath);
      }

      // 2. Concat all chunks into a single MP3. ffmpeg's concat
      //    demuxer is the cheapest way: a text file with the
      //    chunk paths.
      const listPath = join(tmpDir, 'list.txt');
      const listBody = chunks.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await writeFile(listPath, listBody, 'utf8');

      await runFfmpeg(
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          req.outputPath,
        ],
        PER_LINE_TIMEOUT_MS,
      );

      // 3. Stats for the route's progress payload.
      const st = await stat(req.outputPath);
      // Estimate duration: sum of the LLM-reported seconds when
      // synthesised, or stagePauseSec per STAGE line; the route
      // uses this to populate meta.durationSec. We don't have a
      // cheap way to ask ffmpeg for the exact duration of the
      // output, so we approximate: ~150 wpm Russian speech +
      // stagePause per STAGE.
      const totalSpokenSec = req.lines.reduce((acc, l) => {
        if (l.speaker === 'STAGE') return acc + stagePauseSec;
        const words = l.text.split(/\s+/).filter((w) => w.length > 0).length;
        // ~2.5 words/sec Russian TTS is a conservative mid-range.
        return acc + Math.max(0.5, words / 2.5);
      }, 0);
      return {
        durationSec: Math.round(totalSpokenSec),
        bytes: st.size,
      };
    } finally {
      // Best-effort cleanup; the AIFF/MP3 chunks are in tmpdir
      // anyway and the OS will reap them, but we tidy up early.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function runSay(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(SAY_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`say timeout ${timeoutMs}ms (${stderr.slice(0, 200)})`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`say spawn failed: ${err.message} (${SAY_BIN} present?)`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say exited ${code}: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timeout ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      }
    });
  });
}

/** Read the entire MP3 file into a Buffer. Used by tests to
 *  verify the provider wrote something without parsing audio. */
export async function readMp3(path: string): Promise<Buffer> {
  return readFile(path);
}
