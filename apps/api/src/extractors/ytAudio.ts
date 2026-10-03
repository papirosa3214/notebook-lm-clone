/**
 * Download YouTube audio via the local `yt-dlp` binary.
 *
 * We shell out to yt-dlp (not the node.js `ytdl-core` / `youtube-transcript`
 * packages) because:
 *   - node.js packages now hit YouTube's "Sign in to confirm you're not a bot"
 *     wall for almost every video as of late 2025;
 *   - `yt-dlp --cookies` keeps working with the user's exported cookies.txt;
 *   - audio-only format `m4a` is small and fast.
 *
 * Returns the path to the downloaded file (caller is responsible for cleanup).
 * Throws a Russian error message if yt-dlp is missing or fails.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fetchYouTubeAudio(urlOrId: string): Promise<{
  audioPath: string;
  title: string;
  durationSec: number;
  cleanup: () => Promise<void>;
}> {
  const id = extractVideoId(urlOrId);
  if (!id) {
    throw new Error(`Не получилось распознать YouTube-ссылку: ${urlOrId}`);
  }

  const ytDlp = await which('yt-dlp');
  if (!ytDlp) {
    throw new Error(
      'yt-dlp не найден в PATH. Поставь: brew install yt-dlp',
    );
  }

  const cookies = process.env.YT_COOKIES_PATH;
  const dir = await mkdtemp(join(tmpdir(), 'yt-audio-'));
  // Use plain id-based template (no title) so the filename has no spaces,
  // special characters, or unicode that can confuse downstream parsers.
  const outTemplate = join(dir, `${id}.%(ext)s`);

  // Prefer bestaudio m4a (smaller, opus/aac). Fallback to bestaudio.
  // We pin to ios/web_safari clients because they often bypass YouTube's
  // LOGIN_REQUIRED wall for fresh cookies that haven't been re-validated.
  // Falls back gracefully when those clients are blocked.
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    '--extractor-args', 'youtube:player_client=ios,web_safari,android,web',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-o', outTemplate,
    '--print', '%(title)s',
    '--print', '%(duration)s',
    '--print', 'after_move:filepath',
    ...(cookies ? ['--cookies', cookies] : []),
    `https://www.youtube.com/watch?v=${id}`,
  ];

  const { stdout, code } = await runProc(ytDlp, args, 10 * 60 * 1000);
  if (code !== 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `yt-dlp не смог скачать аудио (код ${code}). Проверь ссылку или обнови cookies.`,
    );
  }

  // Three \n-separated prints come on stdout, in order:
//   1. title (may contain spaces, $, etc.)
//   2. duration (numeric seconds as string)
//   3. after_move:filepath (absolute path on disk; comes last because
//      `after_move` runs after the file is in its final location).
const lines = stdout.split('\n').filter((l) => l.length > 0);
const title = lines[0] ?? `YouTube ${id}`;
const durationSec = Number(lines[1] ?? '0') || 0;
const audioPath = lines[2] ?? '';

  if (!audioPath) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('yt-dlp не вернул путь к файлу');
  }
  // Sanity check: file exists and is non-empty.
  try {
    const s = await stat(audioPath);
    if (s.size === 0) {
      throw new Error('скачанный файл пустой');
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`yt-dlp: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    audioPath,
    title,
    durationSec,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function extractVideoId(input: string): string | null {
  const patterns = [
    /(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function which(bin: string): Promise<string | null> {
  // PATH-search. Spawn `which` once; on macOS it's at /usr/bin/which.
  return new Promise<string | null>((resolve) => {
    const proc = spawn('/usr/bin/which', [bin], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (b) => (out += b.toString()));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim() || null);
      else resolve(null);
    });
  });
}

function runProc(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString()));
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`yt-dlp превысил таймаут ${Math.round(timeoutMs / 1000)} сек`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}