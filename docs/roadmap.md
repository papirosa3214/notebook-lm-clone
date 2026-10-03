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

### C2. Flashcards / Quiz (следующая итерация)
- LLM генерирует N пар «вопрос-ответ» (или multiple-choice).
- Артефакт с `kind: 'flashcards'`.
- Интерактивный режим в UI: flip card, пометки «знаю / не знаю», прогресс.
- Persist прогресса в `artifact_progress` таблице.

### C3. Data Table (следующая итерация)
- LLM извлекает из источников сущности + атрибуты, форсит markdown-таблицу.
- `Artifact { kind: 'table' }`, рендерится с фильтрами/сортировкой.

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

### D2. Export notebook (.zip) — **следующая итерация**
- `GET /api/notebooks/:id/export.zip` — `archiver` или `zip-stream`.
- Внутри: артефакты (.md), source markdown, `metadata.json` (источники,
  даты, опционально chat history), cover.
- UI: кнопка «Скачать ноутбук» в настройках.

---

## Milestone E — Mobile PWA (P2, L)

- `manifest.webmanifest` + service worker (Workbox).
- Install-prompt для iOS Safari.
- Touch-target ≥ 44 px везде, viewport meta, safe-area-inset.
- Свайп между панелями (Hammer.js или нативный pointer events).
- Чистка CSS на основе уже начатого `min-[640px]` брейкпойнта
  (A1.6 Этапа 9) — сейчас мобильный layout местами недополирован.

---

## Milestone F — Polish (P2, M)

- **Inline AI note assist** — text selection в `ArtifactsPanel` editor →
  контекстное меню «Переписать / Расширить / Сжать». `POST /api/artifacts/:id/ai-edit`.
- **Multi-format previews** — `GET /api/sources/:id/preview`:
  PDF первая страница (`pdfjs-dist` + `canvas`), DOCX (`mammoth.toHtml()`),
  image thumbnail.
- **Confidence score на цитате** — `CitationChunk.score` уже есть
  (distance от sqlite-vec). Цвет чипа: < 0.5 зелёный, 0.5–1.0 жёлтый,
  > 1.0 красный.
- **Mind map** — `react-flow` (новая зависимость), кастомный node-стиль
  под дизайн-систему. Использует существующий `GET /api/notebooks/:id/mindmap`.
- **Suggested follow-up questions** (gap #4) — после `done` маленький
  LLM-вызов «suggest 3 short Russian follow-up questions»; стримить
  `suggestions` SSE; чипы под ассистент-баблом.

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
