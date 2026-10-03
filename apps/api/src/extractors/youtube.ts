import {
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from 'youtube-transcript';

/**
 * Fetch the transcript of a YouTube video. youtube-transcript returns
 * segments with text + offset; we join them into timestamped paragraphs.
 *
 * Throws human-readable Russian errors instead of the upstream
 * `[YoutubeTranscript] 🚫 ... (videoId)` strings so the UI doesn't
 * look like a stack trace.
 */
export async function fetchYouTubeTranscript(urlOrId: string): Promise<{
  text: string;
  title: string;
}> {
  const { fetchTranscript } = (await import('youtube-transcript')) as unknown as {
    fetchTranscript(
      videoId: string,
      config?: { lang?: string },
    ): Promise<Array<{ text: string; offset: number; duration: number }>>;
  };
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw new Error(`Не получилось распознать YouTube-ссылку: ${urlOrId}`);
  }

  // Try Russian first, then English; youtube-transcript picks the first
  // available track in its own order when `lang` is omitted, but the
  // InnerTube fallback often returns empty for non-English-first locales.
  let segments: Array<{ text: string; offset: number; duration: number }> | null = null;
  let lastErr: unknown = null;
  for (const lang of ['ru', 'en']) {
    try {
      segments = await fetchTranscript(videoId, { lang });
      if (segments?.length) break;
    } catch (err) {
      lastErr = err;
      // For "not available in <lang>" keep trying the next language;
      // for hard failures (disabled / unavailable / captcha) rethrow.
      if (
        !(err instanceof YoutubeTranscriptNotAvailableLanguageError) &&
        !(err instanceof YoutubeTranscriptNotAvailableError)
      ) {
        throw friendlyYouTubeError(err, videoId);
      }
    }
  }
  if (!segments?.length) {
    if (lastErr) throw friendlyYouTubeError(lastErr, videoId);
    throw new Error(`У этого видео (${videoId}) нет доступных субтитров. Попробуй другое видео или включи у этого автора субтитры на YouTube.`);
  }

  // Group segments into ~30s buckets so each chunk has a useful timestamp range.
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
  const text = lines.join('\n\n');
  const title = `YouTube ${videoId}`;
  return { text, title };
}

/** Translate the raw `youtube-transcript` error classes into a Russian
 *  message the UI can show as-is. We strip the `[YoutubeTranscript] 🚫 …`
 *  prefix because it looks like a stack trace to non-developers. */
function friendlyYouTubeError(err: unknown, videoId: string): Error {
  if (err instanceof YoutubeTranscriptDisabledError) {
    return new Error(`У этого видео (${videoId}) автор отключил субтитры на YouTube. Выбери другое видео или то, где сабы включены.`);
  }
  if (err instanceof YoutubeTranscriptVideoUnavailableError) {
    return new Error(`YouTube говорит, что видео (${videoId}) недоступно (закрытое/удалённое/региональная блокировка). Проверь ссылку в браузере.`);
  }
  if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
    return new Error(`У видео (${videoId}) нет субтитров на русском и английском. Попробуй включить сабы в другом языке на самом YouTube или выбрать другое видео.`);
  }
  if (err instanceof YoutubeTranscriptNotAvailableError) {
    return new Error(`У видео (${videoId}) нет доступных субтитров. Попробуй другое видео.`);
  }
  if (err instanceof YoutubeTranscriptTooManyRequestError) {
    return new Error(`YouTube попросил подтвердить, что я не бот (капча). Подожди минуту и попробуй снова.`);
  }
  if (err instanceof YoutubeTranscriptError) {
    // Unknown YoutubeTranscriptError subclass — surface a clean message
    // instead of the raw `[YoutubeTranscript] 🚨 ...` prefix.
    const msg = (err.message || '').replace(/^\[YoutubeTranscript\]\s*[^\s]*\s*/, '').trim();
    return new Error(`YouTube вернул ошибку для видео ${videoId}: ${msg || 'неизвестная ошибка субтитров'}`);
  }
  // Anything else (network, parse, etc.) — pass through the raw message
  // so we don't swallow real bugs.
  return err instanceof Error ? err : new Error(String(err));
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

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
