# NotebookLM Clone

Веб-приложение в духе Google NotebookLM: источники + чат с LLM + markdown-артефакты.
Локальный vector store на базе SQLite + sqlite-vec, embeddings через Ollama.

## Стек

- **Frontend:** Vite 5 + React 19 + TypeScript, Tailwind CSS 3, TanStack Query, React Router
- **Backend:** Fastify 5 + TypeScript, Drizzle ORM + SQLite (better-sqlite3)
- **Vector store / Retrieval:** локальный, через `sqlite-vec` (виртуальная таблица + KNN по `embedding float[1024]`) + FTS5/BM25 с RRF-merge, embed-fallback на FTS5 при падении Ollama
- **Embeddings:** `bge-m3-embed@Ollama` на `.110:11434` (1024-dim, один запрос на чанк; вставляем батчами по 8 параллельно)
- **LLM providers:** Ollama (qwen3.6-27b-iq4-16k по умолчанию), Anthropic, OpenAI
- **Парсинг:** html2text (URL → markdown), pdf-parse (PDF), mammoth (DOCX), youtube-transcript (субтитры)
- **YouTube → ASR (опционально):** yt-dlp (внешний бинарь) скачивает аудио, локальный whisper.cpp `--server` распознаёт речь, ffmpeg нормализует в 16k mono wav. Используется когда youtube-transcript не справляется (login-wall, отключённые сабы, региональная блокировка).
- **Workspace:** pnpm monorepo (`apps/*` + `packages/*`)

## Структура

```
apps/
├── web/      # React UI (Vite, :5173, proxy /api → :4001)
│   └── src/
│       ├── pages/{HomePage, NotebookPage}.tsx
│       ├── components/{SourcesPanel, ChatPanel, ArtifactsPanel, SourceDetailSheet, SummaryPanel}.tsx
│       └── lib/{api, stream, types, useSourceScope, sourceScopeContext, chatHistory, markdownLite}.ts
└── api/      # Fastify API (:4001)
    ├── src/
    │   ├── routes/{notebooks, sources, chat, artifacts, summary, search, discover, graph, mindmap}.ts
    │   ├── providers/{ollama, anthropic, openai}.ts
    │   ├── extractors/{index, url, youtube, ytAudio, asr, websearch}.ts
    │   ├── vectordb/{client, cache, graph}.ts        # sqlite-vec + FTS5/BM25 + RRF
    │   ├── embedding/lifecycle.ts                     # refcount вокруг embed-модели
    │   ├── lib/{ingestRun, ingestStream, rerank, summarizeSource}.ts
    │   └── db/{schema, index}.ts
packages/
└── shared/   # Zod-схемы + LLMProvider интерфейс
```

## Запуск

### 1. Установить

```bash
pnpm install
```

### 2. (опционально) Установить внешние бинари для YouTube → ASR

Эти зависимости нужны **только** если собираешься пользоваться кнопкой
«YouTube → ASR» в `SourcesPanel`. Без них всё остальное работает.

```bash
brew install yt-dlp ffmpeg
# плюс поднять whisper.cpp --server (по умолчанию ждём на 127.0.0.1:8000):
#   https://github.com/ggerganov/whisper.cpp/tree/master/examples/server
```

### 3. Сконфигурировать API

```bash
cp apps/api/.env.example apps/api/.env
# Для чата: хотя бы один из ANTHROPIC_API_KEY / OPENAI_API_KEY, либо Ollama (по умолчанию)
# Embeddings идут через Ollama (EMBEDDING_BASE_URL) — должен быть запущен bge-m3-embed.
# Для YouTube → ASR: заполнить WHISPER_BASE_URL, WHISPER_LANGUAGE, опционально YT_COOKIES_PATH.
```

### 4. Запустить dev

```bash
pnpm dev
```

Открыть `http://localhost:5173`. API на `http://localhost:4001`.

Альтернативно по-отдельности:

```bash
pnpm --filter @notebook/api dev      # API на :4001
pnpm --filter @notebook/web dev      # Web на :5173
```

## PWA / мобильное использование

Приложение — прогрессивное веб-приложение: ставится через
«Add to Home Screen» на iOS/Android и работает в standalone-режиме.

- `public/manifest.webmanifest` — name, theme/background color,
  `display=standalone`. Две иконки: `any` (icon.svg) +
  `maskable` (icon-maskable.svg с 80% safe zone для adaptive
  icons).
- `public/sw.js` — service worker. Stale-while-revalidate для
  app shell, **bypass `/api/*`** (chat/search/retrieval никогда
  не подают stale — лучше ошибка, чем устаревший ответ). Версия
  кэша инкрементируется в `SW_VERSION`, deploy эвиктит старый.
- `src/pwa.ts` — `registerServiceWorker()`, idempotent, только
  в production (чтобы HMR в dev не ломал кэш).
- iOS meta: `apple-mobile-web-app-capable`, `status-bar-style`,
  `format-detection=telephone=no`. Viewport: `viewport-fit=cover`.
- CSS-утилиты: `.p-safe` / `.pt-safe` для safe-area-inset,
  `.touch-target` (44×44), `.no-zoom` (touch-action: manipulation).

Все API-запросы всегда идут на сеть, поэтому чат и поиск
деградируют «честно» (UI покажет ошибку при отсутствии связи),
а не отдают устаревшие ответы.

## Как это работает

### Pipeline источника (синхронный, в момент POST)

```
URL         → fetch → html2text    → .md → recursive splitter (~2 KB chunks) → Ollama bge-m3 embed (8 параллельно) → vec_chunks + chunks
PDF/DOCX    → extractXxx           → .md → то же
TXT/MD      → как есть              → .md → то же
YouTube URL → youtube-transcript   → [m:ss] text → то же
YouTube URL → yt-dlp audio → ffmpeg → 16k wav → whisper.cpp --server → [m:ss] text → то же
              (используется когда youtube-transcript не смог:
               login-wall, отключённые сабы, региональная блокировка)
```

К моменту завершения POST источник уже `ready` (или `failed` с error) — никакого
отдельного статуса `parsing` и фонового polling в UI не нужно.

### Retrieval + Chat (устойчивость)

1. Вопрос → `buildFtsQuery()` для FTS5-ветки (OR, без стоп-слов).
2. Dense-ветка: `embed()` → KNN `WHERE vec_chunks MATCH ? AND k = ? AND notebook_id = ?`.
   Если embed() бросил (Ollama рестартует, нет сети) — dense-ветка возвращает
   пустой массив, и retrieval остаётся на FTS5-результатах. Чат не «пустеет».
3. FTS5-ветка: `bm25(chunks_fts) ORDER BY bm25_score LIMIT ?`.
4. RRF-merge двух веток → top-16 → `RerankProvider.rerank()` → top-K.
5. `RerankProvider` — pluggable (env `RERANK_PROVIDER`):
   - `llm` (default) — qwen3.6 / Haiku ставит score 0-10 каждому кандидату.
   - `http` — POST /rerank на TEI / FlagEmbedding / Infinity
     (bge-reranker-v2-m3). ~10× быстрее, требует отдельного сервиса.
   - `noop` — pass-through, только RRF.
   Все best-effort: на любой ошибке провайдер возвращает input order.
6. System prompt: `CITATION_INSTRUCTIONS` + пронумерованные источники.
7. LLM provider стримит ответ через SSE: `citations` → `token`×N → `done`.
8. После стрима `sanitizeCitations(textBuf, citations.length)` — backstop,
   чтобы out-of-range `[N]` в persisted-строке был заменён на `[?]`.
   UNSUPPORTED-ответы (LLM сказала «не знаю») сохраняются verbatim.
9. LLM обязана возвращать `[N]`-маркеры в тексте — клиент рендерит
   как чипы. Hover/focus на чипе показывает popover с snippet
   (CitationChip); на touch — клик открывает `CitationDialog`.

### Retrieval + Chat

1. Вопрос → `embed()` → KNN `WHERE vec_chunks MATCH ? AND k = ? AND notebook_id = ?`
2. JOIN с метаданными чанков → `CitationChunk[]` с нашими sourceId/title
3. System prompt: `CITATION_INSTRUCTIONS` + пронумерованные источники
4. LLM provider стримит ответ через SSE: `citations` → `token`×N → `done`
5. LLM обязана возвращать `[N]`-маркеры в тексте — клиент рендерит как чипы

### SSE-формат

```
data: {"type":"citations","chunks":[{"id":"...","sourceTitle":"...","text":"..."}]}\n\n
data: {"type":"token","text":"Ret"}\n\n
data: {"type":"token","text":"rie"}\n\n
...
data: {"type":"done","messageId":"abc123"}\n\n
```

## Audio Overview TTS

Audio Overview script-only mode работает из коробки. Чтобы получить
**реальный mp3** на этом Mac — включи `mac-say` provider:

```bash
# apps/api/.env
TTS_PROVIDER=mac-say
```

mac-say — zero-deps, offline, бесплатный TTS через `/usr/bin/say`
+ `ffmpeg`. Default voice `Milena` (ru_RU). SCRIPT и MIRA говорят
одним голосом (на macOS нет двух стабильно доступных русских
голосов). STAGE → 0.8 s silence. Output: 96 kbps mono MP3.

Для разных голосов (будущие провайдеры):
- `openai` — `OPENAI_API_KEY` (не реализован)
- `kokoro` — `KOKORO_BASE_URL` (не реализован)

## API

| Endpoint | Назначение |
|---|---|
| `GET /api/health` | Статус API |
| `POST /api/notebooks` | Создать ноутбук |
| `GET /api/notebooks` | Список ноутбуков |
| `GET /api/notebooks/:id` | Один ноутбук |
| `DELETE /api/notebooks/:id` | Удалить ноутбук (и его источники из `vec_chunks`) |
| `GET /api/notebooks/:id/sources` | Список источников |
| `POST /api/notebooks/:id/sources/url` | Добавить URL |
| `POST /api/notebooks/:id/sources/youtube` | Добавить YouTube (через `youtube-transcript`) |
| `POST /api/notebooks/:id/sources/youtube-asr` | Добавить YouTube через `yt-dlp` + локальный whisper.cpp |
| `POST /api/notebooks/:id/sources/upload` | multipart upload PDF/DOCX/TXT/MD |
| `POST /api/notebooks/:id/sources/refresh` | Polling статусов |
| `DELETE /api/sources/:id` | Удалить источник (clean up triples) |
| `GET /api/notebooks/:id/sources/:sourceId?include=chunks` | Single source + опциональные чанки (SSE fallback / reader) |
| `GET /api/notebooks/:id/retrieve?q=...&sourceIds=...` | Top-k chunks без LLM (preview); фильтр по `sourceIds` |
| `POST /api/notebooks/:id/chat` | SSE стрим ответа с citations; `sourceIds` + `history` в теле |
| `GET /api/notebooks/:id/summary` | Стрим саммари ноутбука (SSE) |
| `GET /api/notebooks/:id/sources/:sourceId/summary` | Саммари одного источника |
| `GET /api/notebooks/:id/mindmap` | SVG mind-map по source-triples |
| `GET /api/providers/:id/models` | Список моделей провайдера |
| `GET /api/notebooks/:id/search?q=...` | Семантический поиск по чанкам |
| `GET /api/notebooks/:id/discover?q=...` | DuckDuckGo preview batch |
| `POST /api/notebooks/:id/discover/ingest` | Подтвердить и ингестить preview URL'ы |
| `GET /api/notebooks/:id/artifacts` | Список артефактов |
| `POST /api/notebooks/:id/artifacts` | Создать |
| `GET /api/notebooks/:id/studio/templates` | Список шаблонов Studio (FAQ / TL;DR / timeline / contradictions / **flashcards** / **data_table**) |
| `POST /api/notebooks/:id/suggestions` | SSE: 3 follow-up вопроса по последней паре Q/A (503 если `SUGGESTIONS_ENABLED=false`) |
| `POST /api/notebooks/:id/artifacts/studio` | Сгенерировать Studio-отчёт (SSE: citations → token* → done), persist `kind='report'` |
| `POST /api/notebooks/:id/share` | Включить read-only шаринг, вернуть `shareToken` + `shareUrl` |
| `GET /api/notebooks/:id/share` | Текущее состояние шаринга |
| `DELETE /api/notebooks/:id/share` | Закрыть доступ (token → NULL) |
| `GET /api/shared/:token` | Публичный read-only snapshot ноутбука (no auth, 404 на unknown/revoked) |
| `GET /api/notebooks/:id/export.zip` | Streaming .zip со всеми источниками, артефактами, README и историей чата |
| `GET /api/artifacts/:id` | Прочитать |
| `PATCH /api/artifacts/:id` | Обновить title/contentMd |
| `GET /api/artifacts/:id/download` | Скачать как `.md` |
| `DELETE /api/artifacts/:id` | Удалить |

## Деплой

Планируется на `.110` через Coolify рядом с TaskFlow. На MVP — локально.

## Известные ограничения

- **PDF-парсинг:** `pdf-parse` имеет известные баги (импортирует дефолтные тестовые файлы);
  если упадёт — переключиться на `pdfjs-dist`
- **YouTube (обычный):** использует HTML-скрейпинг через `youtube-transcript`; для
  большинства роликов нужны ru→en lang-fallback, иначе отдаётся пустой
  transcript. Если всё равно пусто — кнопка «YouTube → ASR».
- **YouTube → ASR:** требует установленных `yt-dlp` (brew) и `ffmpeg` (brew),
  плюс запущенного `whisper.cpp --server` на `WHISPER_BASE_URL` (по умолчанию
  `http://127.0.0.1:8000`). Время: ~1× реал-тайма на распознавание
  (10-минутное видео ≈ 10 минут). Cookies (`YT_COOKIES_PATH`) помогают против
  login-wall, но без них часть роликов будет недоступна.
- **Embedding latency:** Ollama `bge-m3-embed` ~1–2 сек на чанк; для страницы
  на 30 чанков добавление занимает ~10–20 сек (батчами по 8 параллельно).
  Если embedding-сервер упал, retrieval автоматически переключается на
  FTS5-ветку — чат продолжает работать (хотя качество ответов падает).
- **Score:** sqlite-vec отдаёт distance в произвольном диапазоне (не нормализован к [0..1]).
  Используется только для сортировки — клиенту не показывается.
- **Авторизация:** нет (один пользователь); добавить при необходимости

## История этапов

- [x] Этап 0: bootstrap monorepo (`6df48ea`)
- [x] Этап 1: notebooks/sources CRUD, Ragflow integration, markdown URL pipeline (`53747ac`)
- [x] Этап 2: SSE chat, 3 LLM providers, retrieval endpoint (`a2a6e11`)
- [x] Этап 3: file uploads + YouTube transcript ingestion (`e398547`)
- [x] Этап 4: artifacts CRUD — markdown notes with download (`0fb6e34`)
- [x] Этап 5 (UI): React UI с трёхколоночным layout, SSE-клиент, Tailwind (`2d3d508`)
- [x] Этап 6 (NotebookLM-фичи): summary panel, discover preview, mobile tabs (`2a2ec9c`)
- [x] Этап 7: локальный vector store на sqlite-vec (выпилили Ragflow) (`d890b22`)
- [x] Этап 8 (дизайн-система): CSS-токены + Tailwind, resizable/collapsible панели, mobile tabs, citation dialog, иконки, багфиксы
- [x] Mind-map route registered (`f5c76f1`), single-source endpoint для SSE recovery (`f924271`), post-ingest knowledge-graph extraction (`06c6081`) — покрыто API smoke-тестами на временной SQLite + мок Ollama
- [x] **Milestone 1: Source Workspace v1** (`023c016`, `ab3f335`, `767dd47`, `afdc648`):
  - source-scoped chat (`sourceIds` filter через весь retrieval + RRF + rerank, ключ кэша)
  - chat continuity (`history` payload, char-budgeted, FIFO)
  - source reader: chunks-list в `SourceDetailSheet` + jump-to-chunk из цитаты
  - UI source-scope selector: checkbox у каждого ready source, «Все источники» / «N из M источников» в чате, persistency через `localStorage`, авто-удаление удалённых source
- [x] API test infrastructure: `apps/api/src/__tests__/` (миграции, single-source, mind map, graph extraction/cleanup). `pnpm test` зелёный: 12 shared + 23 api + 40 web
- [x] **Этап 9: устойчивость retrieval + YouTube → ASR** (`32690b1`..`4d5d17d`):
  - FTS5-OR с русскими стоп-словами (`buildFtsQuery`); dense-ветка
    обёрнута в try/catch — при падении embed() retrieval остаётся
    работоспособным через FTS5
  - friendly YouTube errors (русские сообщения по классам
    `YoutubeTranscript*Error`), lang fallback ru→en
  - YouTube → ASR: новый endpoint `POST /api/notebooks/:id/sources/youtube-asr`
    через `yt-dlp` + локальный `whisper.cpp --server`. Внешние зависимости
    (`yt-dlp`, `ffmpeg`, `WHISPER_BASE_URL`) задокументированы в
    `apps/api/.env.example`
  - UX-фиксы: `isSourceInScope` (пустой persisted scope = все ready
    отмечены), мобильный брейкпойнт 768→640 для split-screen десктопа,
    retry-плашка «Ответы без цитат устарели — повторить последний вопрос»
    когда LLM ранее сказал «no sources available», а источники с тех
    пор догрузились
  - `pnpm test` зелёный: 12 shared + 23 api + 40 web (см. HANDOFF для
    точного списка)
- [x] **Milestone A: verified answering + pluggable rerank + citation popover** (`55997a2`..`28764df`):
  - `packages/shared` — ужесточённый `CITATION_INSTRUCTIONS`,
    `UNSUPPORTED_PREFIX`, `sanitizeCitations(text, count)`,
    `isUnsupported()`. 6 unit-тестов.
  - `apps/api/src/routes/chat.ts` — post-stream sanitiser. В стрим
    идёт as-is, в БД кладётся sanitised (без визуальных скачков
    в UI). UNSUPPORTED-ответы сохраняются verbatim, чтобы UI
    показал «verified no-answer». 4 e2e теста.
  - `apps/api/src/lib/rerank/` — `RerankProvider` interface +
    `LlmRerankProvider` (default), `HttpRerankProvider` (POST
    /rerank на TEI / FlagEmbedding / Infinity — bge-reranker-v2-m3),
    `NoopRerankProvider` (pass-through). Factory по env
    `RERANK_PROVIDER`. 18 unit-тестов.
  - `apps/web/src/components/CitationChip.tsx` — popover на чипе
    `[N]` с source title + location + 240-символьный snippet +
    кнопка «Открыть». Touch-устройства: popover подавлен, клик
    идёт в `CitationDialog`. 5 unit-тестов (jsdom +
    @testing-library/jest-dom).
  - `apps/web/src/styles.css` — `.chip-muted` для orphan-маркеров
    (sanitiser пропустил `[?]`).
  - `pnpm test` зелёный: 18 shared + 45 api + 45 web.
