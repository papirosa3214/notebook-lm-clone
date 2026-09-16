# NotebookLM Clone

Веб-приложение в духе Google NotebookLM: источники + чат с LLM + markdown-артефакты.
Использует Ragflow как vector store, Markdown pipeline для любых источников.

## Стек

- **Frontend:** Vite 5 + React 19 + TypeScript, Tailwind CSS 3, TanStack Query, React Router
- **Backend:** Fastify 5 + TypeScript, Drizzle ORM + SQLite (better-sqlite3)
- **Vector store / Retrieval:** Ragflow v0.25.5 на `.110:8080` (infiniflow/ragflow)
- **Embeddings:** `bge-m3-embed@Ollama` на `.110:11434`
- **LLM providers:** Ollama (qwen3.6-27b-iq4-16k по умолчанию, `think: false`), Anthropic, OpenAI
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
    │   ├── ragflow/client.ts
    │   └── db/{schema, index}.ts
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
# Минимум — заполнить RAGFLOW_API_KEY (создать в UI Ragflow http://192.168.1.110:8080)
# Для чата: хотя бы один из ANTHROPIC_API_KEY / OPENAI_API_KEY, либо Ollama (по умолчанию)
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

### Pipeline источника

```
URL         → fetch → html2text     → .md → Ragflow (chunk_token_num=256) → bge-m3 embedding
PDF/DOCX    → extractXxx            → .md → Ragflow → embedding
TXT/MD      → normalize              → .md → Ragflow → embedding
YouTube URL → youtube-transcript     → [m:ss] text → .md → Ragflow → embedding
```

Ключевое: Ragflow-парсер NaiveSplitter работает лучше на плоском тексте, чем на HTML.
Поэтому все источники приводятся к markdown перед загрузкой. Это также решает проблему
`input length exceeds context length` в Ollama bge-m3.

### Retrieval + Chat

1. Вопрос → `POST /api/v1/retrieval` (Ragflow) → top-k чанков с similarity score
2. Chunks маппятся в `CitationChunk[]` с нашими sourceId/title
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
| `GET /api/health` | Статус API + Ragflow |
| `POST /api/notebooks` | Создать ноутбук (+ Ragflow dataset) |
| `GET /api/notebooks` | Список ноутбуков |
| `GET /api/notebooks/:id` | Один ноутбук |
| `DELETE /api/notebooks/:id` | Удалить из SQLite (dataset в Ragflow остаётся — почистить вручную) |
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

Планируется на `.110` через Coolify рядом с Ragflow и TaskFlow. На MVP — локально.

## Известные ограничения

- **PDF-парсинг:** `pdf-parse` имеет известные баги (импортирует дефолтные тестовые файлы);
  если упадёт — переключиться на `pdfjs-dist`
- **YouTube:** использует HTML-скрейпинг; при блокировке — fallback на `yt-dlp`
- **Удаление Ragflow dataset:** не поддерживается через REST API в v0.25 (405 Method Not Allowed);
  датасеты-зомби надо чистить вручную в UI
- **Ragflow splitter:** требует markdown на входе; HTML даёт "No chunk built"
- **Embedding:** `bge-m3-embed@Ollama` иногда падает на длинных чанках;
  `chunk_token_num=256` смягчает проблему
- **Авторизация:** нет (один пользователь); добавить при необходимости

## История этапов

- [x] Этап 0: bootstrap monorepo (`6df48ea`)
- [x] Этап 1: notebooks/sources CRUD, Ragflow integration, markdown URL pipeline (`53747ac`)
- [x] Этап 2: SSE chat, 3 LLM providers, retrieval endpoint (`a2a6e11`)
- [x] Этап 3: file uploads + YouTube transcript ingestion (`e398547`)
- [x] Этап 4: artifacts CRUD — markdown notes with download (`0fb6e34`)
- [x] Этап 5 (UI): React UI с трёхколоночным layout, SSE-клиент, Tailwind (`2d3d508`)
