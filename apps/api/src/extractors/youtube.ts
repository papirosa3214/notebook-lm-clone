import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractVideoId,
  lastErrorLine,
  runProc,
  which,
  ytCookiesPath,
} from './ytDlp.js';

/** Русский — единственный нужный язык. Другие дорожки не качаем никогда. */
const SUB_LANG = 'ru';
const SUB_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Транскрипт YouTube-видео в виде `[m:ss] текст`.
 *
 * Основной путь — бинарь `yt-dlp` с cookies пользователя: он берёт и
 * ручные субтитры, и автосубы, и проходит «Sign in to confirm you're not
 * a bot». Запасной путь (бинаря нет) — библиотека `youtube-transcript`:
 * она куки не поддерживает и на части видео упирается в бот-стену,
 * поэтому её ошибки мы показываем честно, без приукрашивания.
 */
export async function fetchYouTubeTranscript(urlOrId: string): Promise<{
  text: string;
  title: string;
}> {
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw new Error(`Не получилось распознать YouTube-ссылку: ${urlOrId}`);
  }

  const ytDlp = await which('yt-dlp');
  if (ytDlp) return fetchViaYtDlp(ytDlp, videoId);

  return fetchViaLibrary(videoId);
}

async function fetchViaYtDlp(ytDlp: string, videoId: string): Promise<{
  text: string;
  title: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-subs-'));
  const cookies = await ytCookiesPath();
  try {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      // Видео не качаем — только дорожка субтитров на русском.
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      SUB_LANG,
      '--sub-format',
      'json3',
      '-o',
      join(dir, `${videoId}.%(ext)s`),
      // Название видео печатаем вместо «YouTube <id>». --print по умолчанию
      // включает --simulate, поэтому файлы не писались бы — отключаем явно.
      '--print',
      'title',
      '--no-simulate',
      ...(cookies ? ['--cookies', cookies] : []),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const { stdout, stderr, code } = await runProc(ytDlp, args, SUB_TIMEOUT_MS);
    if (code !== 0) {
      throw new Error(ytDlpFailure(videoId, stderr, code));
    }

    const files = (await readdir(dir)).filter((f) => f.endsWith(`.${SUB_LANG}.json3`));
    const file = files.at(0);
    if (!file) {
      const reason = lastErrorLine(stderr);
      throw new Error(
        `yt-dlp не нашёл субтитров на языке «${SUB_LANG}» у видео ${videoId}.` +
          (reason ? ` yt-dlp сказал: ${reason}` : ' yt-dlp ничего не сообщил.'),
      );
    }

    const raw = await readFile(join(dir, file), 'utf8');
    const text = parseJson3Transcript(raw);
    if (!text) {
      throw new Error(`Файл субтитров ${file} есть, но текста в нём нет (${videoId}).`);
    }

    const title = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return { text, title: title || `YouTube ${videoId}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Разбор json3 (формат `--sub-format json3`) в `[m:ss] текст`.
 * Сегменты складываем в корзины по 30 секунд — так retrieval видит
 * осмысленные диапазоны времени. Экспортируется ради тестов.
 */
export function parseJson3Transcript(raw: string): string {
  const parsed = JSON.parse(raw) as {
    events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  const events = Array.isArray(parsed?.events) ? parsed.events : [];

  const buckets = new Map<number, string[]>();
  for (const ev of events) {
    const text = (ev?.segs ?? [])
      .map((s) => s?.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const startMs = Number(ev?.tStartMs ?? 0) || 0;
    const bucket = Math.floor(startMs / 30_000) * 30;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(text);
  }

  const lines: string[] = [];
  for (const [sec, texts] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`[${formatTs(sec)}] ${texts.join(' ')}`);
  }
  return lines.join('\n\n');
}

/** Причина отказа yt-dlp — показываем как есть, без приукрашивания. */
function ytDlpFailure(videoId: string, stderr: string, code: number | null): string {
  const reason = lastErrorLine(stderr) ?? `yt-dlp завершился с кодом ${code}`;
  let hint = '';
  if (/cookies are no longer valid/i.test(stderr)) {
    hint = ' Файл cookies.txt устарел: YouTube ротировал сессию, выгрузи куки заново.';
  } else if (/not a bot/i.test(stderr)) {
    hint = ' Бот-проверка YouTube. Помогают свежие куки (YT_COOKIES_PATH или ~/.config/yt.cookies.txt).';
  }
  return `YouTube не отдал субтитры (${videoId}): ${reason}${hint}`;
}

/* ------------------------------------------------------------------ */
/* Запасной путь: библиотека youtube-transcript (куки не поддерживает) */
/* ------------------------------------------------------------------ */

async function fetchViaLibrary(videoId: string): Promise<{ text: string; title: string }> {
  const lib = (await import('youtube-transcript')) as unknown as {
    fetchTranscript: (
      id: string,
      cfg?: { lang?: string },
    ) => Promise<Array<{ text: string; offset: number }>>;
    YoutubeTranscriptNotAvailableError: ErrorConstructor;
    YoutubeTranscriptNotAvailableLanguageError: ErrorConstructor;
  };

  // Русский, затем английский: InnerTube для не-англоязычных локалей
  // часто отдаёт пустоту. Только два языка, никакого перебора дорожек.
  let segments: Array<{ text: string; offset: number }> | null = null;
  let lastErr: unknown = null;
  for (const lang of [SUB_LANG, 'en']) {
    try {
      segments = await lib.fetchTranscript(videoId, { lang });
      if (segments?.length) break;
    } catch (err) {
      lastErr = err;
      if (
        !(err instanceof lib.YoutubeTranscriptNotAvailableLanguageError) &&
        !(err instanceof lib.YoutubeTranscriptNotAvailableError)
      ) {
        throw await libraryError(err, videoId);
      }
    }
  }
  if (!segments?.length) {
    if (lastErr) throw await libraryError(lastErr, videoId);
    throw new Error(
      `У видео ${videoId} нет доступных субтитров на русском. Поставь yt-dlp (brew install yt-dlp) — он берёт автосубы и работает с куками.`,
    );
  }

  const groups = new Map<number, string[]>();
  for (const seg of segments) {
    const bucket = Math.floor(seg.offset / 30_000) * 30;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(seg.text);
  }
  const lines: string[] = [];
  for (const [sec, texts] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`[${formatTs(sec)}] ${texts.join(' ').replace(/\s+/g, ' ').trim()}`);
  }
  return { text: lines.join('\n\n'), title: `YouTube ${videoId}` };
}

async function libraryError(err: unknown, videoId: string): Promise<Error> {
  const {
    YoutubeTranscriptDisabledError,
    YoutubeTranscriptNotAvailableError,
    YoutubeTranscriptNotAvailableLanguageError,
    YoutubeTranscriptTooManyRequestError,
    YoutubeTranscriptVideoUnavailableError,
  } = (await import('youtube-transcript')) as unknown as {
    YoutubeTranscriptDisabledError: ErrorConstructor;
    YoutubeTranscriptNotAvailableError: ErrorConstructor;
    YoutubeTranscriptNotAvailableLanguageError: ErrorConstructor;
    YoutubeTranscriptTooManyRequestError: ErrorConstructor;
    YoutubeTranscriptVideoUnavailableError: ErrorConstructor;
  };
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof YoutubeTranscriptDisabledError) {
    return new Error(`Автор отключил субтитры у видео ${videoId}.`);
  }
  if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
    return new Error(`У видео ${videoId} нет субтитров на русском и английском.`);
  }
  if (err instanceof YoutubeTranscriptNotAvailableError) {
    return new Error(`У видео ${videoId} нет доступных субтитров.`);
  }
  if (err instanceof YoutubeTranscriptTooManyRequestError) {
    return new Error(
      `YouTube потребовал подтверждение, что я не бот. Этот путь ходит без cookies; поставь yt-dlp для надёжного варианта.`,
    );
  }
  if (err instanceof YoutubeTranscriptVideoUnavailableError) {
    return new Error(
      `YouTube не отдал страницу видео ${videoId}: ${msg}. Обычно это бот-проверка или региональная блокировка; yt-dlp с куками это обходит.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
