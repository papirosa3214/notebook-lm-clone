# Handoff — notebook-lm-clone

**Ветка:** `fix/ingest-sse-and-lifecycle`. Локальные сервисы сейчас не запущены.
Параллельные ветки (`design-system-overhaul`, `ops/embedding-lifecycle`)
влиты в эту.

## Где остановились

- Source Workspace v1 (5 шагов, `023c016` / `ab3f335` / `767dd47` / `afdc648`) —
  source-scoped chat + UI selector + reader + chat continuity. Закоммичено
  и протестировано.
- Три ранее обозначенные «активные доработки» (mind-map route, post-ingest
  graph, SSE fallback endpoint) закрыты: API smoke-тесты на временной
  SQLite + мок Ollama подтверждают.
- **Этап 9: устойчивость retrieval + YouTube → ASR** (коммиты
  `32690b1`..`4d5d17d`). Готово, закоммичено, `pnpm test` зелёный.
- README синхронизирован с фактической архитектурой (sqlite-vec +
  FTS5/BM25 + RRF, embed-fallback, YouTube → ASR, retry-плашка).

## Что сделано в этой ветке

### Ранние правки (вдоль коммитов `a0..afdc648`)

- **`packages/shared/src/index.ts`** — убраны `ragflowDocId/ragflowDatasetId`.
  Это был корень "stream closed without done event": Zod-схема реджектила
  `{type:'done',source}` без обязательных ragflow-полей, клиент падал в catch.
- **`apps/api/src/lib/ingestStream.ts`** — `progress(stage, ratio?, message?, sourceId?)`,
  sourceId в каждом событии прогресса.
- **`apps/api/src/vectordb/client.ts:embed()`** — `AbortSignal.timeout(60_000)`,
  per-batch отчёт прогресса в `addSourceText`.
- **`apps/api/src/routes/sources.ts`** — `autoPrepareEmbedding` / `autoReleaseEmbedding`
  (refcount), sourceId в `emit.progress`, `removeTriplesForSource` в DELETE,
  fire-and-forget graph job, single-source endpoint `GET /api/notebooks/:id/sources/:sourceId`.
- **`apps/api/src/vectordb/graph.ts`** — `buildTriplesForSourceId`,
  `removeTriplesForSource` (cleanup).
- **`apps/api/src/index.ts`** — зарегистрированы `mindmapRoutes`.
- **`apps/api/src/providers/ollama.ts`** — chat-запрос с `keep_alive: '30m'`.
- **`apps/web/src/lib/api.ts:openIngestStream`** — fallback на
  `GET /api/notebooks/:id/sources/:sourceId` при закрытии стрима без `done`,
  только если ответ похож на `Source` (поле `kind`).
- **`apps/web/src/components/{SummaryPanel,ChatPanel}.tsx`** — плейсхолдер
  «● ● ● Загружаю модель…» пока `streaming && !content`.
- **`apps/api/src/app.ts`** — `buildApp()` без `listen()`; `index.ts` зовёт и
  вешает реальный `/api/health`. Используется в тестах через `app.inject()`.

### Source Workspace v1 (коммит-сериал `023c016`..`afdc648`)

- `023c016` (api+web): `sourceIds` через retrieval + RRF + rerank + cache key,
  real `sourceKind`/`location`, single-source endpoint c `?include=chunks`.
- `ab3f335` (web): `useSourceScope` + context, checkbox у ready sources,
  «Все источники» / «N из M источников» в чате, persistency через `localStorage`,
  авто-удаление удалённых source.
- `767dd47` (web): `SourceDetailSheet` рендерит chunks в ordinal-порядке,
  jump-to-chunk из цитаты (`highlightOrdinal` + scroll-into-view + accent-soft).
- `afdc648` (web): `buildChatHistory(messages)` — последние 12 valid turns,
  char-budgeted FIFO (6000); `ChatPanel` прокидывает `sourceIds` + `history`
  в `streamChat`.

### Этап 9 — устойчивость + YouTube → ASR (`32690b1`..`4d5d17d`)

- `32690b1` (api): `buildFtsQuery(question)` — FTS5-OR с русскими
  стоп-словами. dense-ветка (sqlite-vec) обёрнута в try/catch: при
  падении embed() retrieval остаётся работоспособным через FTS5.
  Чат не «пустеет», если Ollama моргнула.
- `73025a0` (api): friendly YouTube errors. Импортированы классы
  `YoutubeTranscript*Error`; `friendlyYouTubeError(err, videoId)`
  маппит каждое в человеческое русское сообщение. Перед сдачей
  пробуем ru, потом en — InnerTube fallback для не-английских
  локалей часто возвращал пустоту.
- `d630248` (api): YouTube → ASR foundation. `apps/api/src/extractors/ytAudio.ts`
  (yt-dlp shell-out с cookies, ios/web_safari player-client).
  `apps/api/src/extractors/asr.ts` (whisper.cpp `/inference` + ffmpeg
  → 16k mono wav). Конфиг: `WHISPER_BASE_URL`, `WHISPER_LANGUAGE`,
  `YT_COOKIES_PATH`. Из `package.json` дропнуты мёртвые `ytdl-core`
  и `@distube/ytdl-core` (использовался только в docstring).
- `53546ce` (api): `POST /api/notebooks/:id/sources/youtube-asr` —
  новый endpoint с тем же lifecycle, что у `/sources/youtube`
  (insert pending → runIngest → SSE прогресс → status ready/failed
  → fire-and-forget summary + graph).
- `4a313cd` (web): `AddYoutubeAsrDialog` + `api.ingestYoutubeAsrSourceStream`.
  Новая кнопка «YouTube → ASR» в `SourcesPanel` рядом с обычной
  YouTube, использует общий `ProgressStepper`.
- `4bfae0d` (web): `isSourceInScope(sourceId, selectedIds, readyIds)`.
  Раньше пустой persisted scope показывал пустые чекбоксы у всех
  ready-источников; теперь — все отмечены, кнопка «Все» видна
  только при суженном scope.
- `f54cd77` (web): mobile breakpoint 768→640. Split-screen окно
  десктопа шириной 744 CSS px больше не показывает мобильные табы
  поверх десктоп-лейаута.
- `eb7fd6b` (web): retry-плашка «Ответы без цитат устарели» —
  когда LLM ранее сказал «no sources available», а источники
  догрузились. Кнопка «Повторить последний вопрос» переотправляет
  запрос через `send(userMsg.content)`.
- `4d5d17d` (chore): `apps/api/.env.example` — `WHISPER_BASE_URL`,
  `WHISPER_LANGUAGE`, `YT_COOKIES_PATH` + короткий список
  внешних зависимостей (brew install yt-dlp ffmpeg, whisper.cpp
  --server).
- `3692bdd` (docs): README — стек, ASR-флоу, env, ретри-плашка,
  история.

## Тесты

`pnpm test` зелёный:
- 12 shared (deltas)
- 23 api (миграции, single-source + anti-leak между notebook, mind map
  с мок-LLM, graph extraction/cleanup, source-scope retrieval, FTS5
  `buildFtsQuery`)
- 40 web (stream parsing, http-клиент, ruPlural, chatHistory,
  sourceScope `isSourceInScope`+`scopeToSourceIds`,
  `containsUncitedNoSourceAnswer`, http.test)

`pnpm -r build` зелёный. `tsc --noEmit` чист во всех трёх пакетах.

## Решения (утверждено)

- **chat = GPU** (`num_gpu=999`) в `prepare-models.sh`. Ollama сама кладёт
  слои, при нехватке VRAM спилит на CPU чисто. CPU-форс был ошибочным.
- **embed = GPU** если ≥800 MB free, иначе CPU. `bge-m3-embed` живёт в RAM
  (Ollama reports `size_vram=0`) → не конкурирует за VRAM с чатом.
- дефолт чат = `qwen3.6-27b-iq4-16k:latest`, дефолт embed = `bge-m3-embed`.
- `coder30b-abl` НЕ используем как дефолт (код-фокус, та же VRAM-стоимость).
- **retrieval устойчивость**: dense-ветка обёрнута в try/catch; при падении
  embed() chat остаётся на FTS5-результатах. Это не «degraded mode с баннером»,
  а нормальный рабочий режим: пользователь видит ответ, даже если Ollama
  рестартует.

## Constraints

- 192.168.1.110: **нет исходящего HTTPS** к `registry.ollama.ai` / `huggingface.co`
  (TLS handshake timeout). Нельзя стянуть `qwen3:14b` или любой GGUF с HF.
- `ANTHROPIC_API_KEY` отсутствует в `apps/api/.env`; `providers/anthropic.ts:17`
  кидает "not set" если вызвать.
- Сирота `RAGFLOW_API_KEY=...` в `apps/api/.env` — игнорируется, не удалять руками.
- DB: все 10 notebook'ов мигрированы на `default_provider='ollama',
  default_model='qwen3.6-27b-iq4-16k:latest'`.
- **YouTube → ASR** требует: `yt-dlp` (brew), `ffmpeg` (brew),
  `whisper.cpp --server` на `WHISPER_BASE_URL` (default `127.0.0.1:8000`).
  Без них endpoint `POST /sources/youtube-asr` упадёт с понятной ошибкой,
  остальное API не пострадает.

## Next

См. `docs/roadmap.md` — это новый активный milestone-план.

1. **Перезапустить API** на свежем коде: `pkill -f "tsx.*src/index"` →
   `pnpm --filter @notebook/api dev` (или через bundle).
2. **Manual smoke** по Этапу 9:
   - добавить YouTube-видео без публичных сабов через кнопку «YouTube → ASR»;
   - дождаться `ready`, проверить тайм-кодированные чанки;
   - задать вопрос по этому source — проверить, что цитаты попадают
     в распознанный текст;
   - `pkill ollama`, задать вопрос — чат должен ответить через FTS5-ветку.
3. **Merge `fix/ingest-sse-and-lifecycle` в `main`** (fast-forward).
4. После merge — `docs/roadmap.md`:
   - **Audio Overview (P0)**: TTS-пайплайн, двухголосый диалог по источникам.
   - **Verified answering (P0)**: `UNSUPPORTED` маркер + sanitiser [N].
   - **Inline citation hover (P0)**: popover на чипе.
   - **bge-reranker v2 (P0)**: локально через Ollama или TEI.
   - **Studio v1**: reports / flashcards / data-table.
   - **Sharing**: read-only public link.
   - **PWA + mobile polish**: manifest, service worker, ≥44 px touch targets.
