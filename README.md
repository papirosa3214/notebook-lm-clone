# NotebookLM Clone

Веб-приложение в духе Google NotebookLM: источники + чат с LLM + markdown-артефакты.
Локальный vector store на базе SQLite + sqlite-vec, embeddings через Ollama.

## Стек

- **Frontend:** Vite 5 + React 19 + TypeScript, Tailwind CSS 3, TanStack Query, React Router
- **Backend:** Fastify 5 + TypeScript, Drizzle ORM + SQLite (better-sqlite3)
- **Vector store / Retrieval:** локальный, через `sqlite-vec` (виртуальная таблица + KNN по `embedding float[1024]`)
- **Embeddings:** `bge-m3-embed@Ollama` на `.110:11434` (1024-dim, один запрос на чанк; вставляем батчами по 8 параллельно)
- **LLM providers:** Ollama (qwen3.6-27b-iq4-16k по умолчанию), Anthropic, OpenAI
- **Парсинг:** html2text (URL → markdown), pdf-parse (PDF), mammoth (DOCX), youtube-transcript (субтитры)
- **Workspace:** pnpm monorepo (`apps/*` + `packages/*`)

## Структура

```
apps/
├── web/      # React UI (Vite, :5173, proxy /api → :4001)
│   └── src/
│       ├── pages/{HomePage, NotebookPage}.tsx
│       ├── components/{SourcesPanel, ChatPanel, ArtifactsPanel}.tsx
│       └── lib/{api, stream, types}.ts
└── api/      # Fastify API (:4001)
    ├── src/
    │   ├── routes/{notebooks, sources, chat, artifacts}.ts
    │   ├── providers/{ollama, anthropic, openai}.ts
    │   ├── extractors/{index, youtube}.ts
    │   └── db/{schema, index, vector}.ts
packages/
└── shared/   # Zod-схемы + LLMProvider интерфейс
```

## Запуск

### 1. Установить

```bash
pnpm install
```

### 2. Сконфигурировать API

```bash
cp apps/api/.env.example apps/api/.env
# Для чата: хотя бы один из ANTHROPIC_API_KEY / OPENAI_API_KEY, либо Ollama (по умолчанию)
# Embeddings идут через Ollama (EMBEDDING_BASE_URL) — должен быть запущен bge-m3-embed.
```

### 3. Запустить dev

```bash
pnpm dev
```

Открыть `http://localhost:5173`. API на `http://localhost:4001`.

Альтернативно по-отдельности:

```bash
pnpm --filter @notebook/api dev      # API на :4001
pnpm --filter @notebook/web dev      # Web на :5173
```

## Как это работает

### Pipeline источника (синхронный, в момент POST)

```
URL         → fetch → html2text   → .md → recursive splitter (~2 KB chunks) → Ollama bge-m3 embed (8 параллельно) → vec_chunks + chunks
PDF/DOCX    → extractXxx          → .md → то же
TXT/MD      → как есть             → .md → то же
YouTube URL → youtube-transcript  → [m:ss] text → то же
```

К моменту завершения POST источник уже `ready` (или `failed` с error) — никакого
отдельного статуса `parsing` и фонового polling в UI не нужно.

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
| `POST /api/notebooks/:id/sources/youtube` | Добавить YouTube |
| `POST /api/notebooks/:id/sources/upload` | multipart upload PDF/DOCX/TXT/MD |
| `POST /api/notebooks/:id/sources/refresh` | Polling статусов |
| `DELETE /api/sources/:id` | Удалить источник |
| `GET /api/notebooks/:id/retrieve?q=...` | Top-k chunks без LLM (preview) |
| `POST /api/notebooks/:id/chat` | SSE стрим ответа с citations |
| `GET /api/providers/:id/models` | Список моделей провайдера |
| `GET /api/notebooks/:id/artifacts` | Список артефактов |
| `POST /api/notebooks/:id/artifacts` | Создать |
| `GET /api/artifacts/:id` | Прочитать |
| `PATCH /api/artifacts/:id` | Обновить title/contentMd |
| `GET /api/artifacts/:id/download` | Скачать как `.md` |
| `DELETE /api/artifacts/:id` | Удалить |

## Деплой

Планируется на `.110` через Coolify рядом с TaskFlow. На MVP — локально.

## Известные ограничения

- **PDF-парсинг:** `pdf-parse` имеет известные баги (импортирует дефолтные тестовые файлы);
  если упадёт — переключиться на `pdfjs-dist`
- **YouTube:** использует HTML-скрейпинг; при блокировке — fallback на `yt-dlp`
- **Embedding latency:** Ollama `bge-m3-embed` ~1–2 сек на чанк; для страницы на 30 чанков
  добавление занимает ~10–20 сек (батчами по 8 параллельно).
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
