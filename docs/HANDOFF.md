# Handoff — notebook-lm-clone

**Ветка:** `fix/ingest-sse-and-lifecycle`. Локальные сервисы сейчас не запущены.
Параллельные ветки (`design-system-overhaul`, `ops/embedding-lifecycle`)
влиты в эту.

## Где остановились

- Plan перебил «Source Workspace v1» (5 шагов, `023c016` / `ab3f335` / `767dd47`
  / `afdc648`) — source-scoped chat + UI selector + reader + chat continuity.
  Закоммичено и протестировано (66/66).
- Три ранее обозначенные «активные доработки» (mind-map route, post-ingest graph,
  SSE fallback endpoint) закрыты: API smoke-тесты на временной SQLite + мок Ollama
  подтверждают.
- README + HANDOFF синхронизированы с фактической архитектурой (sqlite-vec + FTS/BM25 + RRF).

## Что сделано в этой ветке

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

### Source Workspace v1 (этот же коммит-сериал)

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

## Тесты

`pnpm test` зелёный:
- 12 shared
- 20 api (миграции, single-source + anti-leak между notebook, mind map с мок-LLM,
  graph extraction/cleanup, source-scope retrieval)
- 34 web (stream parsing, http-клиент, ruPlural, chatHistory, http.test)

`pnpm -r build` зелёный. `tsc --noEmit` чист во всех трёх пакетах.

## Решения (утверждено)

- **chat = GPU** (`num_gpu=999`) в `prepare-models.sh`. Ollama сама кладёт
  слои, при нехватке VRAM спилит на CPU чисто. CPU-форс был ошибочным.
- **embed = GPU** если ≥800 MB free, иначе CPU. `bge-m3-embed` живёт в RAM
  (Ollama reports `size_vram=0`) → не конкурирует за VRAM с чатом.
- дефолт чат = `qwen3.6-27b-iq4-16k:latest`, дефолт embed = `bge-m3-embed`.
- `coder30b-abl` НЕ используем как дефолт (код-фокус, та же VRAM-стоимость).

## Constraints

- 192.168.1.110: **нет исходящего HTTPS** к `registry.ollama.ai` / `huggingface.co`
  (TLS handshake timeout). Нельзя стянуть `qwen3:14b` или любой GGUF с HF.
- `ANTHROPIC_API_KEY` отсутствует в `apps/api/.env`; `providers/anthropic.ts:17`
  кидает "not set" если вызвать.
- Сирота `RAGFLOW_API_KEY=...` в `apps/api/.env` — игнорируется, не удалять руками.
- DB: все 10 notebook'ов мигрированы на `default_provider='ollama',
  default_model='qwen3.6-27b-iq4-16k:latest'`.

## Next

1. **Перезапустить API** на свежем коде: `pkill -f "tsx.*src/index"` →
   `pnpm --filter @notebook/api dev` (или через bundle).
2. **Manual smoke** по плану Source Workspace v1: добавить 2 URL → кликнуть
   checkbox на одном → задать вопрос → проверить, что цитата из цитаты
   открывает `SourceDetailSheet` с подсвеченным чанком → сохранить raw →
   скачать `.md`.
3. **Merge `fix/ingest-sse-and-lifecycle` в `main`** (fast-forward).
4. После merge — следующий milestone (план в `notebooklm-source-workspace-v1-plan.md`):
   либо Audio/Video Overview, либо Deep Research, либо что-то ещё по приоритету
   Макса.