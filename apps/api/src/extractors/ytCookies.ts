/**
 * Куки YouTube: статус, импорт из DevTools, выгрузка из браузера.
 *
 * Зачем всё это: YouTube отдаёт «Sign in to confirm you're not a bot» без
 * живой сессии, и yt-dlp отличает один отказ от другого только по тексту
 * stderr. Здесь мы эти отказы разбираем и говорим пользователю, что
 * именно сломано и что с этим делать.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_COOKIES_PATH, runProc, which, ytCookiesPath } from './ytDlp.js';

const execFileAsync = promisify(execFile);

/** Без этих кук yt-dlp не узнаёт, что запрос от авторизованного юзера. */
const AUTH_COOKIES = ['__Secure-1PSID', '__Secure-3PSID'] as const;

/** Что вообще нужно, чтобы сессия считалась живой. */
const REQUIRED_COOKIES = [
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
];

export type CookieFileStatus = {
  path: string;
  exists: boolean;
  updatedAt: string | null;
  total: number;
  authCookies: string[];
  missing: string[];
  /** Файл есть и в нём есть всё, что нужно для сессии. */
  usable: boolean;
};

export async function readCookieStatus(): Promise<CookieFileStatus> {
  const path = (await ytCookiesPath()) ?? DEFAULT_COOKIES_PATH;
  const base: CookieFileStatus = {
    path,
    exists: false,
    updatedAt: null,
    total: 0,
    authCookies: [],
    missing: [...REQUIRED_COOKIES],
    usable: false,
  };
  try {
    const [raw, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const names = parseNetscapeNames(raw);
    const missing = REQUIRED_COOKIES.filter((c) => !names.has(c));
    return {
      path,
      exists: true,
      updatedAt: st.mtime.toISOString(),
      total: names.size,
      authCookies: AUTH_COOKIES.filter((c) => names.has(c)),
      missing,
      usable: missing.length === 0,
    };
  } catch {
    return base;
  }
}

function parseNetscapeNames(raw: string): Set<string> {
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) names.add(parts[5]!);
  }
  return names;
}

/**
 * Таблица кук, скопированная из DevTools → Application → Storage → Cookies.
 * Формат: TSV, где колонки `Name<TAB>Value<TAB>Domain<TAB>Path…`.
 * Оставляем только `.youtube.com` — остальное YouTube не примет.
 */
export function convertDevToolsTsv(tsv: string): {
  content: string;
  imported: string[];
  skipped: number;
} {
  const rows: string[] = [];
  const imported: string[] = [];
  let skipped = 0;

  for (const rawLine of tsv.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const [name, value, domain] = parts;
    // Первая строка копии — заголовок колонок.
    if (name === 'Name' || !name || !value) {
      skipped += 1;
      continue;
    }
    if (!domain || !/(^|\.)youtube\.com$/i.test(domain.trim())) {
      skipped += 1;
      continue;
    }
    rows.push(
      [domain.trim(), 'TRUE', '/', 'TRUE', '2145916800', name, value].join('\t'),
    );
    imported.push(name);
  }

  const content = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# Импортировано из DevTools (Application → Storage → Cookies).',
    ...rows,
    '',
  ].join('\n');

  return { content, imported, skipped };
}

/** Пишем куки, предварительно сохранив предыдущие в .bak. */
export async function writeCookieFile(content: string): Promise<string> {
  const path = (await ytCookiesPath()) ?? DEFAULT_COOKIES_PATH;
  await mkdir(join(path, '..'), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch {
    // Бэкапа нет — это нормально для первого запуска.
  }
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

/**
 * Кандидаты в браузерах: Chromium хранит куки в `Network/Cookies`, но
 * только если браузером пользовались. Нас интересует лишь наличие
 * сессионных кук YouTube — по имени файла и размеру.
 */
const BROWSER_DIRS: Array<{ label: string; dir: string }> = [
  { label: 'Chrome', dir: 'Google/Chrome' },
  { label: 'Comet', dir: 'Comet' },
  { label: 'Dia', dir: 'Dia/User Data' },
  { label: 'Arc', dir: 'Arc/User Data' },
  { label: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { label: 'Yandex', dir: 'Yandex/YandexBrowser' },
  { label: 'Edge', dir: 'Microsoft Edge' },
  { label: 'Chromium', dir: 'Chromium' },
];

export type BrowserCookieSource = {
  label: string;
  profilePath: string;
};

export async function listBrowserCookieSources(): Promise<BrowserCookieSource[]> {
  const root = join(homedir(), 'Library', 'Application Support');
  const found: BrowserCookieSource[] = [];
  const seen = new Set<string>();

  for (const browser of BROWSER_DIRS) {
    const browserRoot = join(root, browser.dir);
    for (const profile of ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5', 'Profile 6']) {
      const db = join(browserRoot, profile, 'Network', 'Cookies');
      if (seen.has(db)) continue;
      let size = 0;
      try {
        size = (await stat(db)).size;
      } catch {
        continue;
      }
      // Пустая база — профиль не использовали, сессии там нет.
      if (size < 4096) continue;
      seen.add(db);
      found.push({
        label: profile === 'Default' ? browser.label : `${browser.label} (${profile})`,
        profilePath: join(browserRoot, profile),
      });
    }
  }
  return found;
}

export type BrowserExportResult = {
  ok: boolean;
  message: string;
  /** Сколько кук yt-dlp не смог расшифровать. */
  undecrypted: number | null;
  extracted: number | null;
};

/**
 * Выгружает куки из профиля браузера через yt-dlp. На macOS значения кук
 * зашифрованы ключом из связки ключей (Keychain), поэтому процесс может
 * потребовать пароль один раз — это ожидаемо, а не поломка.
 */
export async function exportFromBrowser(profilePath: string): Promise<BrowserExportResult> {
  const ytDlp = await which('yt-dlp');
  if (!ytDlp) {
    return {
      ok: false,
      message: 'yt-dlp не найден в PATH. Поставь: brew install yt-dlp',
      undecrypted: null,
      extracted: null,
    };
  }

  const target = (await ytCookiesPath()) ?? DEFAULT_COOKIES_PATH;
  const probe = await execFileAsync(ytDlp, [
    '--cookies-from-browser',
    `chrome:${profilePath}`,
    '--cookies',
    target,
    '--skip-download',
    '--simulate',
    '--no-warnings',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ]).catch((e: { stderr?: string; stdout?: string; message: string }) => {
    return { stderr: e.stderr ?? e.message, stdout: e.stdout ?? '' };
  });

  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const undecrypted = /(\d+) could not be decrypted/.exec(output)?.[1];
  const extracted = /Extracted (\d+) cookies/.exec(output)?.[1];

  if (undecrypted) {
    return {
      ok: false,
      extracted: extracted ? Number(extracted) : null,
      undecrypted: Number(undecrypted),
      message:
        `yt-dlp прочитал ${extracted} кук из «${basename(profilePath)}», ` +
        `но ${undecrypted} не расшифровал — macOS не отдала ключ. ` +
        'Нужен одноразовый доступ к Keychain, см. подсказку в интерфейсе.',
    };
  }

  const status = await readCookieStatus();
  if (!status.usable) {
    return {
      ok: false,
      extracted: extracted ? Number(extracted) : null,
      undecrypted: null,
      message:
        `Куки выгружены из «${basename(profilePath)}», но в них нет ` +
        `${status.missing.join(', ')}. В этом браузере нет сессии YouTube.`,
    };
  }

  return {
    ok: true,
    extracted: extracted ? Number(extracted) : null,
    undecrypted: 0,
    message: `Куки обновлены из «${basename(profilePath)}»: ${status.authCookies.length} сессионные из ${status.total}.`,
  };
}

/**
 * Разбирает stderr yt-dlp в конкретный диагноз. Раньше все отказы
 * выглядели одинаково, и приходилось гадать, чинить куки или менять IP.
 */
export async function diagnoseYtFailure(stderr: string): Promise<string> {
  const status = await readCookieStatus();

  if (/cookies are no longer valid/i.test(stderr)) {
    return 'Куки YouTube протухли — сессия ротирована. Нажми «Обновить куки».';
  }
  if (/not a bot/i.test(stderr)) {
    if (!status.exists) {
      return 'YouTube требует подтверждения, что ты не бот. Файла кук нет — нажми «Обновить куки».';
    }
    if (!status.usable) {
      return `YouTube требует подтверждения, что ты не бот. В файле кук не хватает: ${status.missing.join(', ')}. Выгрузи куки заново.`;
    }
    return 'YouTube требует подтверждения, что ты не бот, хотя куки на месте. Похоже, IP заблокирован — тогда нужен резидентный вход.';
  }
  return lastLine(stderr) ?? 'yt-dlp не сообщил причину.';
}

function lastLine(stderr: string): string | null {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}
