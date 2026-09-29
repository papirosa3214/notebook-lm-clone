# Handoff — notebook-lm-clone

**Ветка:** `fix/ingest-sse-and-lifecycle`. Параллельно живут
`design-system-overhaul` (UI/токены) и `ops/embedding-lifecycle`
(prepare/release скрипты, всё сюда уже включено).

## Где остановились

- **API не перезапущен** после перестроя `packages/shared`. PID 25059 на
  старом коде. "stream closed without done event" воспроизводится до
  рестарта — `pkill -f "tsx.*src/index"` или эквивалент + запуск заново.
- 3 файла в дереве (не закоммичены):
  - `apps/api/src/db/schema.ts` — дефолты `ollama` / `qwen3.6-27b-iq4-16k:latest`
  - `apps/api/src/routes/notebooks.ts:28-29` — fallback `?? 'ollama'` / `?? 'qwen3.6-27b-iq4-16k:latest'`
  - `apps/api/scripts/prepare-models.sh` — `warm_model "$CHAT_MODEL" 999 "chat"` (без threshold)
- Vite proxy `selfHandleResponse` откачен (`78fff2b`) — оставлено дефолтным.

## Что сделано в этой ветке

- `apps/api/src/lib/ingestStream.ts` — `progress(stage, ratio?, message?, sourceId?)`,
  sourceId в каждом событии прогресса.
- `apps/api/src/vectordb/client.ts:embed()` — `AbortSignal.timeout(60_000)`,
  per-batch отчёт прогресса в `addSourceText`.
- `apps/api/src/routes/sources.ts` — `autoPrepareEmbedding` / `autoReleaseEmbedding`
  (refcount), sourceId в `emit.progress` для URL и YouTube.
- `packages/shared/src/index.ts` — **убраны `ragflowDocId/ragflowDatasetId`.
  Это корень "stream closed without done event":** Zod-схема реджектила
  `{type:'done',source}` потому что `source` без обязательных ragflow-полей
  не проходил валидацию, клиент падал в catch и показывал сообщение.
- `packages/shared/src/index.ts` — `progress` теперь принимает `sourceId`.
- `apps/api/src/providers/ollama.ts` — chat-запрос с `keep_alive: '30m'`.
- `apps/web/src/lib/api.ts:openIngestStream` — fallback на
  `GET /api/notebooks/:id/sources/:sourceId` при закрытии стрима без `done`,
  только если ответ похож на `Source` (поле `kind`).
- `apps/web/src/components/{SummaryPanel,ChatPanel}.tsx` — плейсхолдер
  «● ● ● Загружаю модель…» пока `streaming && !content`.
- `apps/api/src/index.ts` — зарегистрирован `mindmapRoutes` (`f5c76f1`).
- `apps/api/src/vectordb/graph.ts` — `buildTriplesForSourceId` для чтения чанков из БД;
  `routes/sources.ts` — fire-and-forget извлечение triples после URL/YouTube/file upload
  и `removeTriplesForSource` в DELETE (`06c6081`).
- `apps/api/src/routes/sources.ts` — `GET /api/notebooks/:id/sources/:sourceId`
  для SSE-fallback с проверкой принадлежности notebook (`f924271`).
- `apps/api/src/app.ts` — `buildApp()` без `listen()`; `index.ts` его зовёт и вешает
  реальный `/api/health`. Используется в тестах через `app.inject()`.
- `apps/api/src/__tests__/` — smoke-rig: tmp SQLite через `DB_PATH`, мок `globalThis.fetch`
  для 127.0.0.1:11434, vitest. 11 API-тестов: миграции, single-source endpoint
  (включая anti-leak между notebook), mind map (с мок-LLM), graph extraction/cleanup.
  `pnpm test` зелёный: 12 shared + 11 api + 28 web.

## Решения (утверждено)

- **chat = GPU** (`num_gpu=999`) в `prepare-models.sh`. Ollama сама кладёт
  слои, при нехватке VRAM спилит на CPU чисто. CPU-форс был ошибочным.
- **embed = GPU** если ≥800 MB free, иначе CPU. `bge-m3-embed` живёт в RAM
  (Ollama reports `size_vram=0`) → не конкурирует за VRAM с чатом.
- дефолт чат = `qwen3.6-27b-iq4-16k:latest`, дефолт embed = `bge-m3-embed`.
  Квантизацию 27B не даунгрейдим — качество summary критично.
- `coder30b-abl` НЕ используем как дефолт (код-фокус, та же VRAM-стоимость).

## Constraints

- 192.168.1.110: **нет исходящего HTTPS** к `registry.ollama.ai` / `huggingface.co`
  (TLS handshake timeout). Нельзя стянуть `qwen3:14b` или любой GGUF с HF.
- `ANTHROPIC_API_KEY` отсутствует в `apps/api/.env`; `providers/anthropic.ts:17`
  кидает "not set" если вызвать. Не критично — ни один notebook не на anthropic.
- Сирота `RAGFLOW_API_KEY=...` в `apps/api/.env` — игнорируется, не удалять руками.
- DB: все 10 notebook'ов мигрированы на `default_provider='ollama',
  default_model='qwen3.6-27b-iq4-iq4-16k:latest'` (миграция лежит в
  lore, raw SQL `UPDATE` без формального migration-файла).
- Vite dev `:5273` (PID 28792), API `:4001` (PID 25059, **нужен рестарт**).

## Параллельные ветки

- `design-system-overhaul` — design-токены (`surface-tint`, `success`,
  `dot-pulse`/`fade-up` → CSS), 3-кол ресайз + `ResizableDivider`,
  `NotebookLogo`, мобильные табы, 8 чисток (B1–B6, Q1–Q8).
- `ops/embedding-lifecycle` — `prepare/release-models.sh`,
  `embedding/lifecycle.ts` (probe VRAM + warmup через
  `/api/embeddings` с `num_gpu:999|0` и `keep_alive:30m`).

## Next

1. Перезапустить API (`pkill` PID 25059 → `cd apps/api && npm run dev`).
2. Закоммитить 3 файла одним коммитом: `chore: pin defaults, force
   chat to GPU (Ollama decides spill)`.
3. Прогон smoke test: загрузка URL → стрим с `done` → UI «Источник готов».
4. Merge `fix/ingest-sse-and-lifecycle` в `main` (fast-forward).
5. Макс решает дальше: визуальная проверка UI на :5273
   **или** setup React testing infra (testing-library + jsdom,
   сейчас в проекте нет).
