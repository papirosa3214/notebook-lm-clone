# NotebookLM Clone

Веб-приложение в духе Google NotebookLM: источники + чат с LLM + markdown-артефакты.

## Стек

- **Frontend:** Vite 5 + React 19 + TypeScript
- **Backend:** Fastify 5 + TypeScript
- **Vector store:** Ragflow v0.25.5 на `.110:8080`
- **LLM:** Anthropic / OpenAI / Ollama
- **Workspace:** pnpm monorepo (`apps/*` + `packages/*`)

## Структура

```
apps/
├── web/      # React UI (Vite, :5173, proxy /api → :4001)
└── api/      # Fastify API (:4001)
packages/
└── shared/   # Zod-схемы + provider-интерфейс
```

## Запуск (локально)

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
# заполнить RAGFLOW_API_KEY (взять из UI Ragflow http://192.168.1.110:8080)
pnpm dev
```

Открыть `http://localhost:5173`. API на `http://localhost:4001`.

## Эндпоинты

- `GET /api/health` — статус API + Ragflow
- `GET /api/ragflow/datasets` — список датасетов Ragflow (debug, MVP)

## Деплой

Планируется на `.110` через Coolify (после MVP).

## Этапы

- [x] Этап 0: bootstrap monorepo
- [ ] Этап 1: notebook + sources (через Ragflow dataset + documents)
- [ ] Этап 2: retrieval + chat (SSE с цитатами)
- [ ] Этап 3: файлы (PDF/DOCX/TXT/MD) и YouTube
- [ ] Этап 4: артефакты (markdown-заметки)
- [ ] Этап 5: полировка
