/**
 * Общие помощники для всех YouTube-путей (субтитры и ASR).
 *
 * Мы намеренно работаем через бинарь `yt-dlp`, а не через node-пакеты:
 * с 2025 года `youtube-transcript` и прочие библиотеки упираются в
 * «Sign in to confirm you're not a bot» почти на каждом видео с
 * дата-центрового IP. `yt-dlp --cookies` с живой сессией пользователя
 * этот стен проходит.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Куки по умолчанию — то, что использует yt-dlp из коробки. */
export const DEFAULT_COOKIES_PATH = join(homedir(), '.config', 'yt.cookies.txt');

/**
 * Путь к cookies.txt в формате Netscape или `undefined`, если кук нет.
 * Явный `YT_COOKIES_PATH` в окружении важнее умолчания.
 */
export async function ytCookiesPath(): Promise<string | undefined> {
  const fromEnv = process.env.YT_COOKIES_PATH?.trim();
  if (fromEnv) return fromEnv;
  try {
    await access(DEFAULT_COOKIES_PATH);
    return DEFAULT_COOKIES_PATH;
  } catch {
    return undefined;
  }
}

export async function which(bin: string): Promise<string | null> {
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

export function runProc(
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
      reject(new Error(`${bin} превысил таймаут ${Math.round(timeoutMs / 1000)} сек`));
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

export function extractVideoId(input: string): string | null {
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

/** Последняя строка `ERROR:` из stderr — там yt-dlp пишет настоящую причину. */
export function lastErrorLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('ERROR:') || line.startsWith('WARNING:')) {
      return line.replace(/^(ERROR|WARNING):\s*/, '');
    }
  }
  return lines.at(-1) ?? null;
}
