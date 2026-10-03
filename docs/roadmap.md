# Roadmap — notebook-lm-clone

Этот документ — живая карта будущих milestones после Этапа 9 (устойчивость
retrieval + YouTube → ASR, коммиты `32690b1`..`4d5d17d`).

См. также:
- `notebooklm-source-workspace-v1-plan.md` — выполненный Source Workspace v1.
- `docs/HANDOFF.md` — что реально сделано в текущей ветке.
- `docs/notebooklm-gap-and-rerankers.md` — gap-анализ против upstream
  NotebookLM + варианты reranker'ов.

---

## Приоритеты

P0 — фичи, без которых продукт не выглядит как NotebookLM:
- Audio Overview
- Verified / source-grounded answering
- Inline citation hover preview
- Reranker v2 (bge-reranker через Ollama)

P1 — заметно расширяют UX:
- Studio v1 (reports / flashcards / data-table)
- Mind Map (react-flow по knowledge graph)
- Sharing (read-only public link)

P2 — polish и расширения:
- PWA / mobile parity
- Multi-format source previews
- Inline AI note assist
- Export notebook (.zip)
- Confidence score на цитате

---

## Milestone A — Verified chat + Reranker (P0, M)

**Цель:** ответы чата должны быть действительно grounded в источниках, и
retrieval должен уметь ранжировать выше по смыслу, а не по embedding distance.

### A1. Verified answering (P0, M) — **сделано** (коммиты `55997a2`, `fef5618`, `c1e2183`)
- `packages/shared/src/providers.ts` — `CITATION_INSTRUCTIONS` ужесточён,
  добавлен `UNSUPPORTED_PREFIX` + `sanitizeCitations(text, count)`,
  `isUnsupported()`.
- `apps/api/src/routes/chat.ts` — после стрима финальный текст через
  sanitiser, в БД кладётся sanitised (без визуальных скачков в UI).
- UNSUPPORTED-ответы сохраняются verbatim, чтобы UI показал
  «verified no-answer».
- Тесты: 6 unit в shared, 4 e2e в `chat-sanitize.smoke.test.ts`.

### A2. Pluggable rerank (P0, M) — **сделано** (коммиты `517549e`, `28764df`)
- `apps/api/src/lib/rerank/` — `RerankProvider` интерфейс +
  три реализации: `LlmRerankProvider` (default, через чат-LLM),
  `HttpRerankProvider` (POST /rerank на TEI / FlagEmbedding /
  Infinity — bge-reranker-v2-m3 живёт там), `NoopRerankProvider`
  (pass-through).
- Factory `getRerankProvider()` по env `RERANK_PROVIDER`:
  `llm` (default) | `http` | `noop`. `RERANK_HTTP_URL`,
  `RERANK_HTTP_MODEL`, `RERANK_TIMEOUT_MS` для http-ветки.
- Все best-effort: при ошибке провайдер возвращает input order.
- `retrieveWithRerank()` использует factory.
- Constraint из плана (нет egress к HF на `.110`) решён: модель
  должна быть предзагружена на отдельном TEI-сервисе, никакого
  pull в момент чата.
- Тесты: 14 в `rerank.providers.test.ts` (TEI shape, fallback'и,
  parseScoreArray), 4 в `factory.test.ts` (env-выбор, cache).

### A3. Inline citation hover preview (P0, S) — **сделано** (`1e80e28`)
- `apps/web/src/components/CitationChip.tsx` — popover с source title,
  location, snippet до 240 символов, кнопка «Открыть».
- `matchMedia('(hover: hover)')` — на touch-устройствах popover
  подавлен, клик идёт в `CitationDialog` (старое поведение).
- `chip-muted` для orphan-маркеров (когда sanitiser пропустил `[?]`).
- 5 unit-тестов в `CitationChip.test.tsx`.

**DoD всего Milestone A выполнен:** verified answer → либо корректный
grounded с цитатами, либо явный UNSUPPORTED; rerank pluggable;
hover popover показывает snippet + кнопку перехода в source reader.

---

## Milestone B — Audio Overview (P0, XL)

**Цель:** кнопка в `NotebookPage` генерирует 3–10 минутный двухголосый
подкаст по выбранным источникам, mp3 + транскрипт как артефакт.

### B1. Backend foundation — **сделано** (`517549e`..`8f0106f` на текущей ветке, плюс скрипт-first коммиты)
- `packages/shared`: расширен `Artifact` (kind, meta), добавлены
  `AudioOverviewRequest/Delta/Line/Meta` schemas.
- `apps/api/src/lib/audio/`:
  - `tts.ts` — `TtsProvider` interface
  - `noopTts.ts` — script-only mode (default)
  - `factory.ts` — `getTtsProvider()` по `TTS_PROVIDER` env
  - `storage.ts` — `apps/api/data/audio/{notebookId}/{artifactId}.mp3`
  - `scriptBuilder.ts` — `buildScript()` + `parseScriptText()`
    (pure function для unit-тестов)
- `apps/api/src/routes/audioOverview.ts`:
  - `POST /api/notebooks/:id/audio-overview` — SSE: meta →
    script_line*N → progress(synthesizing) → done | error
  - `GET /api/audio/:notebookId/:filename` — стримит mp3 (404 если
    noop не отрисовал)
- Миграция `artifacts.kind` + `artifacts.meta` через
  `addColumnIfMissing` (forward-only, безопасно на каждом бутстрапе).
- Тесты: 8 на `parseScriptText` (prefix, fallback, STAGE,
  full-width colon, blank lines, empty input), 3 на route
  smoke (script-only happy path, unknown sourceIds, bad filename).
- UI: `AudioOverviewDialog` + кнопка в шапке ноутбука.

### B2. TTS-синтез — **требует решения по провайдеру**
- Интерфейс `TtsProvider` уже на месте. Когда выберем движок,
  добавим `OpenAiTtsProvider` / `MacSayTtsProvider` /
  `KokoroTtsProvider` в `apps/api/src/lib/audio/`. Factory
  (`TTS_PROVIDER` env) уже умеет резолвить эти имена (сейчас
  warn+fallback на noop).
- Склейка: ffmpeg `amix` для двух голосов; mp3 в
  `apps/api/data/audio/{notebookId}/{artifactId}.mp3`.
- Выбор сделан: script-only first, реальный TTS — после.

### B3. UI (частично)
- Кнопка и диалог с прогрессом уже есть (B1).
- Карточка-результат: пока показывается транскрипт в диалоге.
  Когда TTS подключим, добавим в ArtifactsPanel `<audio controls>`
  + блок с метаданными (style, lineCount, duration).

**DoD скрипт-first:** добавил 3 URL → нажал Audio Overview → видишь
транскрипт построчно, через ~30 сек артефакт сохранён с
`kind='audio_overview'`, audioFilename=null. **Сейчас работает.**

**Полный DoD (с TTS):** добавил 3 URL → нажал Audio Overview →
через ~2 мин слушаю 5-минутный подкаст с двумя голосами на русском,
цитаты в транскрипте кликабельны.

**TTS-кандидаты (открыто, требует подтверждения):**
1. `kokoro-fastapi` — MIT, локально, ~80MB, 4 голоса ru+en.
2. OpenAI TTS (`tts-1`/`tts-1-hd` через `OPENAI_API_KEY`).
3. ElevenLabs — лучшее качество, но платно.

---

## Milestone C — Studio v1 (P1, L)

### C1. Reports / Briefs — **сделано** (`eb1fbf7`..`059757e` на текущей ветке)
- `packages/shared`: `StudioTemplate` (faq | executive_summary |
  timeline | contradictions), `StudioRequest`, `StudioReportMeta`,
  `StudioDelta`. Расширен `Artifact.kind` (`'note' | 'audio_overview'
  | 'report'`).
- `apps/api/src/lib/studio/templates.ts` — реестр шаблонов с
  per-template system-prompt + user-prompt factory. Все
  промпты на русском, [N]-маркеры обязательны, общий preamble
  затягивает дисциплину (без вводных фраз, без секций вне
  шаблона, без выдумок).
- `apps/api/src/routes/studio.ts`:
  - `GET /api/notebooks/:id/studio/templates` — список для UI
  - `POST /api/notebooks/:id/artifacts/studio` — SSE: citations →
    token* → done | error; persist как Artifact `kind='report'`,
    `meta={template, citationCount, createdAt}`
- UI: `StudioReportDialog` + кнопка «Studio» в шапке ноутбука.
- Тесты: 8 на `templates.test.ts` (4 документа, topK диапазон,
  userPrompt с focus/без), 5 на `studio.smoke.test.ts` (list,
  happy path, unknown sourceIds, unknown template id, empty
  notebook).

### C2. Flashcards / Quiz — **сделано** (`c962d82`, `a21e833`, текущая ветка — на текущей ветке)
- `packages/shared`: `StudioTemplate` расширен `'flashcards'`,
  добавлены `FlashcardSchema`, `FlashcardSetSchema`, опциональный
  `StudioReportMeta.flashcardCount`.
- `apps/api/src/lib/studio/templates.ts`: новый шаблон
  `flashcards` с user-prompt, требующим JSON-массив
  `{question, answer}` (10-20 пар, [N]-маркеры в ответах).
- `apps/api/src/routes/studio.ts`:
  - `parseFlashcardStream(text)` — tolerates fences, leading
    prose, `//` comments; 60-card hard cap; выдаёт
    `Flashcard[]` с `nanoid` id.
  - После стрима, если `template==='flashcards'`, парсим,
    валидируем через `FlashcardSetSchema`, persist'им
    `contentMd` как JSON + `flashcardCount` в meta.
  - Для других шаблонов поведение неизменно.
- UI: `FlashcardDeck` + интеграция в `ArtifactsPanel`.
  `isFlashcardArtifact()` распознаёт template как по
  `meta.template`, так и по body-парсингу (legacy / shared view).
  Flip-card, next/prev, keyboard (Space/Enter, ←/→), mark
  «знаю / не знаю» + auto-advance, прогресс-бар, reset.
- Тесты: 8 unit для `parseFlashcardStream`, 1 e2e для route
  (artifact kind='report' с flashcardCount, валидный JSON body),
  10 unit для `FlashcardDeck` (default/flip/next/wrap/reset/
  mark/auto-advance/known/unknown/counters/JSON-string/empty).

### C3. Data Table — **сделано** (текущая ветка: `ee00152` + `5b0741d` + web-коммиты)
- `packages/shared`: `StudioTemplate: 'data_table'`, `DataTable` (title?,
  columns, rows), `StudioReportMeta.{columnCount, rowCount}`.
- `apps/api/src/lib/studio/templates.ts`: data_table user-prompt с
  жёстким требованием JSON `{title, columns, rows}` — 3-7 колонок,
  5-30 строк, ячейки до 200 символов.
- `apps/api/src/routes/studio.ts`:
  - `parseDataTableStream(text)` — tolerant fence + leading prose;
    нормализует columns (trim/dedupe/cap@20), rows (только cells с
    известными колонками, cap@500, drop пустых), coerces non-string
    values к string.
  - При total-failure → fallback `[{columns:['Результат'], rows:[{Результат:'Нет данных'}]}]`,
    чтобы UI не падал.
  - persist: `contentMd = JSON.stringify(table)`,
    `meta.columnCount` + `meta.rowCount`.
- UI: `DataTableView` + интеграция в `ArtifactsPanel`.
  - Sortable columns (click header, click again to flip direction)
  - Case-insensitive substring filter
  - "сбросить сортировку" link
  - Empty placeholder для invalid JSON
  - Plural: 1 столбец / 2-4 столбца / 5+ столбцов
- Тесты: 11 unit для `parseDataTableStream` (clean JSON, fence,
  prose, partial rows, extra keys, coercion, dedup, null на
  garbage, row cap 500), 2 e2e (happy path + fallback), 7 unit
  для `DataTableView` (default render, sort + flip, filter,
  empty state, JSON-string body, invalid JSON, reset sort).

**Studio v1 закрыт полностью:** Reports (FAQ / TL;DR / Timeline /
Contradictions) + Flashcards + Data Table. Все шесть шаблонов
работают end-to-end (backend + UI + tests), персистятся как
Artifact kind='report' с разным template в meta и разным
contentMd (markdown для reports, JSON для flashcards/data_table).

---

## Milestone D — Sharing + Export (P1, M)

### D1. Sharing (read-only) — **сделано** (`3b9b9e6`..`a67a15e`)
- `packages/shared`: `SharedNotebook`, `SharedSource`, `SharedArtifact`,
  `NotebookShare` (enabled, shareToken, shareUrl, shareEnabledAt).
- `apps/api/src/db/schema.ts` + миграция: `notebooks.share_token` +
  `notebooks.share_enabled_at` через `addColumnIfMissing`.
- `apps/api/src/config.ts`: `PUBLIC_BASE_URL` (опц., для билда
  абсолютных share-ссылок в production).
- `apps/api/src/routes/share.ts`:
  - `POST   /api/notebooks/:id/share` → 201 + shareToken + shareUrl
  - `GET    /api/notebooks/:id/share` → current state
  - `DELETE /api/notebooks/:id/share` → 204; token → NULL
  - `GET    /api/shared/:token` → public snapshot
- Контракт безопасности:
  - 404 для unknown / revoked / malformed token (НИКОГДА 401/403
    — чтобы нельзя было probe'ить URL space)
  - 404 для `../etc/passwd` и других traversal-форм
  - projection: только безопасные поля (no chat history, no
    chunk text, no provider/model, no API keys)
  - contentPreview truncate до 300 символов + ellipsis
- UI: `ShareDialog` (enable/copy/revoke) + кнопка «Поделиться» в
  шапке + `SharedNotebookPage` (отдельная страница viewer-mode,
  НЕ переиспользует NotebookPage).
- Тесты: 4 owner + 5 public = 9 smoke.

### D2. Export notebook (.zip) — **сделано** (`5490d37`, `59aee85`, `f804699` на текущей ветке)
- `apps/api/src/routes/export.ts`:
  - `GET /api/notebooks/:id/export.zip` — streaming через
    `archiver` (`ZipArchive`, обёртка через `createRequire`
    из-за named-export CJS-модуля)
  - 200 + `application/zip` + `Content-Disposition: attachment;
    filename="<sanitised-title>.zip"`
  - 404 для unknown notebook
- Layout архива:
  - `README.md` — структура + индекс источников/артефактов
  - `metadata.json` — машинно-читаемая сводка (id, title, provider,
    model, createdAt, exportedAt, counts)
  - `sources/<id>.md` — YAML front-matter (id/title/kind/status/url)
    + summary quote + chunked body в ordinal-порядке
  - `artifacts/<id>.md` — `contentMd` as-is (note / report /
    audio_overview script)
  - `chat.md` — сплошная история диалога, role headers
  - safety: per-source byte cap 4 MB с пометкой 'truncated'
- UI: `<a href={api.exportUrl(notebookId)} download>` в шапке
  ноутбука — `download` атрибут даёт браузеру сохранить с
  filename из Content-Disposition.
- Тесты: 7 smoke через `fflate.unzipSync` — реально
  распаковывают архив, проверяют каждое поле каждого
  файла (front-matter, summary, chunked body в ordinal-порядке,
  artifact contentMd 1:1, chat role headers, пустой placeholder,
  metadata counts).

---

## Milestone E — Mobile PWA (P2, L)

### E1. PWA foundation — **сделано** (текущая ветка, 1 коммит)
- `apps/web/public/manifest.webmanifest`:
  - name/short_name, `start_url=/`, `display=standalone`
  - `theme_color` и `background_color` синхронизированы с
    дизайн-токенами
  - 2 иконки: `any` (icon.svg) + `maskable` (icon-maskable.svg
    с 80% safe zone для adaptive icons)
- `apps/web/public/sw.js`:
  - Versioned cache (`nb-sw-v1-shell/-runtime`) → deploy эвиктит
  - App shell pre-cache на install
  - Stale-while-revalidate для same-origin GETs
  - Bypass /api/* (chat/search/retrieval никогда не подаём stale),
    bypass text/event-stream, bypass Vite dev, bypass cross-origin
  - `skipWaiting()` + `clients.claim()` чтобы deploy сразу
    активировал новый worker
- `apps/web/src/pwa.ts`:
  - `registerServiceWorker()`: idempotent, swallow errors
  - Только в production (`import.meta.env.PROD`), чтобы HMR
    в dev не ломал кэш
  - Test seam: `globalThis.__disableServiceWorker` для vitest
- `apps/web/index.html`:
  - `viewport-fit=cover` + `user-scalable=no`
  - `theme-color` light + dark (prefers-color-scheme)
  - `apple-mobile-web-app-capable` / `status-bar-style` / `title`
  - `format-detection=telephone=no` (iOS не превращает числа в ссылки)
  - `<link rel="manifest">`, `<link rel="icon">` (SVG),
    `<link rel="apple-touch-icon">`
- CSS (`apps/web/src/styles.css`):
  - `.pt-safe` / `.pb-safe` / `.p-safe` (env(safe-area-inset-*))
  - `.touch-target` (44×44 — WCAG/HIG minimum)
  - `.no-zoom` (touch-action: manipulation, double-tap zoom off)
  - `.btn-icon` получает touch-target + no-zoom
  - `.btn` получает min-h-[36px] + no-zoom
  - body `overscroll-behavior-y: contain`,
    `background-color: rgb(--nb-canvas)` (no white flash на
    overscroll)
- `apps/web/src/pages/NotebookPage.tsx`:
  - header получает `pt-safe pl-safe pr-safe`
- Тесты:
  - `src/pwa.test.ts` (3) — registerServiceWorker test seams
  - `public/pwa-files.test.ts` (11) — manifest shape, sw shape,
    index.html meta — без необходимости поднимать браузер

### E2. Swaip между панелями + mobile polish
- Hammer.js или нативный pointer events для свайпа между
  панелями на мобильных.
- Чистка CSS на основе уже начатого `min-[640px]` брейкпойнта
  (A1.6 Этапа 9) — местами мобильный layout ещё недополирован.

**DoD:** «Add to Home Screen» на iOS/Android ставит иконку, открывает
standalone, корректно обрабатывает safe-area-inset. Service
worker кэширует app shell для офлайн-первого-старта (API-запросы
всегда идут на сеть, поэтому деградация чата — на UI уровне).

---

## Milestone F — Polish (P2, M)

### F1. Suggested follow-up questions — **сделано** (текущая ветка)
- `packages/shared`: `SuggestionsRequest` (question, answer,
  history?, sourceIds?, provider?, model?, count 1-5),
  `SuggestionsDelta` (SSE: token | suggestions | done | error).
- `apps/api/src/lib/studio/jsonArray.ts` — общий tolerant
  JSON-массив парсер, переиспользуется flashcards/data_table
  (в будущем — оба переедут на этот хелпер).
- `apps/api/src/routes/suggestions.ts`:
  - `POST /api/notebooks/:id/suggestions` (SSE)
  - `SUGGESTIONS_ENABLED=false` → 503 (kill switch)
  - unknown sourceIds → 400 (тот же контракт что у /chat)
  - system prompt: строго JSON-массив, <200 символов на вопрос,
    разнообразие формулировок (что/как/почему/сравни)
  - history trim до 6 последних сообщений
  - финальный `suggestions` event с cleaned + truncated list
- `apps/api/src/config.ts`: `SUGGESTIONS_ENABLED` (default true,
  transform к boolean).
- UI: `SuggestionsChips` рендерит 3 чипа под assistant-message.
  Click → `onPick(suggestion)` → `setInput` в ChatPanel.
  - 503 / error → silent hide (чат не блокируется)
  - abort при unmount через AbortController
- Тесты: 6 e2e (clean array, fences, trim+cap, garbage → error,
  unknown sourceIds, unknown notebook), 6 unit на `parseJsonArray`
  (clean, prose wrapping, fences, comments, garbage, limit),
  6 unit на `SuggestionsChips` (loading, render, click, 503,
  error, abort).

### F2. Inline AI note assist — следующая итерация
- Text selection в `ArtifactsPanel` editor → контекстное меню
  «Переписать / Расширить / Сжать». `POST /api/artifacts/:id/ai-edit`
  со streaming-ответом, вставка в editor.

### F3. Multi-format previews
- `GET /api/sources/:id/preview`:
  PDF первая страница (`pdfjs-dist` + `canvas`),
  DOCX (`mammoth.toHtml()`), image thumbnail.

### F4. Confidence score на цитате
- `CitationChunk.score` уже есть (distance от sqlite-vec).
  Цвет чипа: < 0.5 зелёный, 0.5–1.0 жёлтый, > 1.0 красный.

### F5. Mind map (react-flow)
- `react-flow` (новая зависимость), кастомный node-стиль
  под дизайн-систему. Использует существующий
  `GET /api/notebooks/:id/mindmap`.

---

## Что НЕ делаем (out of scope)

- Auth / multi-user collaboration (owner-only, README так говорит).
- Real-time collaboration (CRDT/yjs).
- CSV/PPTX/ePub/Image import.
- Собственный TTS с нуля (только готовое).
- Сложный GraphRAG (graph у нас уже подключён в retrieval, но не как
  основной путь).
- «Deep Research» с обходом многих сайтов и планированием (см. P1
  в gap-доке) — отдельный большой milestone, не часть Studio v1.
