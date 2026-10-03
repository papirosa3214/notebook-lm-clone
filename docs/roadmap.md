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

### B1. Скрипт-генерация
- `POST /api/notebooks/:id/audio-overview` принимает
  `{ style?: 'deep_dive' | 'short', focus?: string, sourceIds?: string[] }`.
- Берёт top-N чанков через `retrieve()`.
- LLM-промпт: «You are a podcast host Alex interviewing Mira about
  <topic>. Alternate speakers. Use [N] markers from the provided sources.
  Length: 1500–2000 words. Style: engaging, conversational. Reply in
  Russian if the user's focus is in Russian.»
- Сохраняет скрипт как `Artifact { kind: 'audio_overview_script' }`.

### B2. TTS-синтез
- На Mac Apple Silicon:
  - **kokoro-fastapi** (рекомендую): MIT, ~80MB, 4 голоса ru+en, HTTP на
    `127.0.0.1:8001` (не конфликтует с whisper.cpp `:8000`).
  - **OpenAI TTS** (`tts-1`/`tts-1-hd` через `OPENAI_API_KEY`): проще
    в интеграции, но платно.
  - **macOS `say`**: dev-fallback, голоса robotic.
- Склейка через `ffmpeg`: два голоса (host/guest) → `amix` + `-af
  pan=…`. Mp3 в `apps/api/data/audio/{notebookId}/{artifactId}.mp3`.
- Статус в `audio_overviews` таблице.

### B3. SSE прогресс
- События: `outline` → `script` (доля) → `tts_host` → `tts_guest` →
  `mix` → `done`. Используем тот же `IngestProgressDelta`.

### B4. UI
- Кнопка «Audio Overview» в верхней панели ноутбука.
- Диалог с настройками (style, focus, source scope).
- Прогресс через общий stepper.
- Карточка-результат: HTML5 `<audio controls>` + транскрипт (скрипт
  LLM, по которому генерировалось).

### B5. Тесты
- `audioOverview` route возвращает 201, артефакт сохраняется.
- Скрипт содержит обоих спикеров и `[N]`-маркеры.
- TTS-вызов замокан на уровне `vitest` (реальное озвучивание — e2e).

**DoD:** добавил 3 URL → нажал Audio Overview → через 2 минуты слушаю
5-минутный подкаст с двумя голосами на русском, цитаты в транскрипте
кликабельны.

**Решение по TTS** (требует подтверждения):
1. `kokoro-fastapi` — рекомендую.
2. OpenAI TTS.
3. ElevenLabs.

---

## Milestone C — Studio v1 (P1, L)

### C1. Reports / Briefs
- `POST /api/notebooks/:id/artifacts/studio` с body `{ template, focus? }`.
- Шаблоны: FAQ, executive summary, timeline, contradictions.
- Бэкенд: `retrieve()` + шаблонный промпт → `Artifact { kind: 'report' }`.

### C2. Flashcards / Quiz
- LLM генерирует N пар «вопрос-ответ» (или multiple-choice).
- Артефакт с `kind: 'flashcards'`.
- Интерактивный режим в UI: flip card, пометки «знаю / не знаю», прогресс.
- Persist прогресса в `artifact_progress` таблице.

### C3. Data Table
- LLM извлекает из источников сущности + атрибуты, форсит markdown-таблицу.
- `Artifact { kind: 'table' }`, рендерится с фильтрами/сортировкой.

---

## Milestone D — Sharing + Export (P1, M)

### D1. Sharing (read-only)
- `POST /api/notebooks/:id/share` → `shareToken` (random nanoid).
- `GET /api/shared/:token` — без auth, JSON: notebook meta + sources titles +
  артефакты.
- `apps/web/src/pages/SharedNotebookPage.tsx` — viewer-mode (без chat,
  без добавления источников).
- `DELETE /api/notebooks/:id/share` — revoke.

### D2. Export notebook (.zip)
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
