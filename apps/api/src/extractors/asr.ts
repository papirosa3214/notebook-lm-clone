/**
 * Send an audio file to a local ASR (Whisper) HTTP endpoint and return
 * the recognised text. Compatible with `whisper.cpp --server`
 * (`/inference` endpoint, returns `{ text }`) — the de-facto standard
 * for locally-hosted Whisper on Apple silicon.
 *
 * Configured via env: `WHISPER_BASE_URL` (default `http://127.0.0.1:8000`)
 * and `WHISPER_LANGUAGE` (default `ru`).
 *
 * If the file is a video container (mp4/mov/webm/mkv) we re-encode it to
 * 16-kHz mono WAV with ffmpeg before sending, because whisper-server's
 * `--convert` flag is opt-in and we don't want to depend on that flag being
 * set in every deployment.
 */
import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export interface TranscribeOpts {
  language?: string;
  /** Max seconds to wait for the ASR endpoint. */
  timeoutMs?: number;
}

export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOpts = {},
): Promise<{ text: string; durationSec: number }> {
  const base = (process.env.WHISPER_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
  const language = opts.language ?? process.env.WHISPER_LANGUAGE ?? 'ru';
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000; // 15 min

  const wavPath = await ensureWav(audioPath);

  try {
    // whisper-server's /inference endpoint accepts multipart form:
    //   file: the audio file
    //   language: e.g. "ru"
    //   response_format: "json" (default)
    // and returns JSON { text: string, ... }.
    const form = new FormData();
    const bytes = await readFile(wavPath);
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(wavPath));
    form.append('language', language);
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${base}/inference`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `ASR-эндпоинт вернул HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as { text?: string };
    const text = (data.text ?? '').trim();
    if (!text) {
      throw new Error('ASR-эндпоинт вернул пустой текст (аудио без речи?)');
    }
    const st = await stat(audioPath).catch(() => null);
    return { text, durationSec: 0 };
  } finally {
    // Clean up the WAV temp file but leave the original audioPath alone.
    if (wavPath !== audioPath) {
      const { unlink } = await import('node:fs/promises');
      await unlink(wavPath).catch(() => {});
    }
  }
}

/**
 * If `audioPath` is already a wav, return it as-is. Otherwise re-encode
 * via ffmpeg (which is on PATH on macOS via Homebrew; the API server
 * already has ffmpeg in its dev/runtime). Returns the wav path.
 */
async function ensureWav(audioPath: string): Promise<string> {
  const ext = extname(audioPath).toLowerCase();
  if (ext === '.wav') return audioPath;

  // Anything else (mp3/m4a/mp4/mov/webm/...) → transcode to 16k mono wav.
  const wavPath = audioPath.replace(/\.[^.]+$/, '') + '.asr.wav';
  await runFfmpeg([
    '-y',
    '-i', audioPath,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath,
  ], 5 * 60 * 1000);
  return wavPath;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg превысил таймаут ${Math.round(timeoutMs / 1000)} сек`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-400)}`));
    });
  });
}