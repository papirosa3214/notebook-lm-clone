# Milestone 1 — Source Workspace v1

**Цель:** превратить текущий «чат по всему ноутбуку» в управляемое исследовательское пространство, где пользователь выбирает источники для вопроса, видит, откуда взят каждый тезис, и может перейти из цитаты к точному фрагменту.

Это ближайший минимальный milestone. Он намеренно **не включает Audio/Video Overview, Deep Research, sharing и мобильное приложение**. После него продукт будет заметно ближе к основному UX NotebookLM: не просто отвечать по материалам, а помогать управлять набором источников и проверять ответы.

## Почему именно этот milestone

Сейчас проект уже умеет импортировать URL, файлы и YouTube, индексировать их локально, выполнять hybrid retrieval (sqlite-vec + FTS5/BM25 + RRF), стримить чат и сохранять Markdown-артефакты. Главный UX-разрыв остаётся в контроле над источниками:

- вопрос всегда ищется по всему ноутбуку;

- цитата открывает snippet, но не сам источник в контексте;

- пользователь не может быстро понять, какие именно материалы повлияли на ответ.

Google делает source selection частью базового потока: можно выбрать конкретный набор sources для чата, а управление источниками и их организация происходят в отдельной панели. [1]

## Контрольная пользовательская история

> Я собрал 8–15 ссылок в ноутбук. Перед вопросом отмечаю только «официальные документы» и «аналитику за 2026 год», спрашиваю сравнение. В ответе вижу цитаты. Нажимаю `[2]`, открывается нужный source, а точный chunk подсвечен. Затем сохраняю ответ как Markdown-заметку.

## Предусловие: принять уже завершённые изменения

Перед началом новых функций агент обязан **не переписывать** три последних изменения, а проверить и принять их:

| Commit | Изменение | Критерий приёмки |
| --- | --- | --- |
| `f5c76f1` | регистрация `mindmapRoutes` | `POST /api/notebooks/:id/mindmap` больше не даёт 404 и возвращает созданный artifact при замоканной LLM |
| `06c6081` | knowledge-graph extraction после ingestion и cleanup | после ingestion source появляются triples; удаление source удаляет связанные triples; ошибка graph job не ломает import |
| `f924271` | `GET /api/notebooks/:id/sources/:sourceId` для SSE fallback | route проверяет принадлежность notebook, выдаёт 404 для чужого/несуществующего source и позволяет клиенту восстановиться после оборванного SSE |

### Gate 0 — проверка базы

1. Выполнить `pnpm lint`, `pnpm build` и `git diff --check`.

1. Добавить или расширить API-тесты так, чтобы `pnpm test` больше не завершался ошибкой из-за отсутствующих API test files.

1. Проверить на временной SQLite и моке Ollama:
  - single-source endpoint;
  - SSE fallback;
  - mind-map endpoint;
  - post-ingest graph extraction не блокирует `ready` source.

1. Только после этого обновить README/HANDOFF: три пункта перестают быть «активной работой» и получают статус «реализовано и проверено».

## Scope milestone

### 1. Контракт источника и retrieval filtering

#### Backend

Расширить shared contracts и API:

```
ChatRequestSchema = {
  message: string,
  history?: ChatMessage[],
  provider?: ProviderId,
  model?: string,
  topK?: number,
  sourceIds?: string[] // optional: absent or [] = all active sources
}
```

Требования:

- Все `sourceIds` должны существовать и принадлежать текущему `notebookId`.

- Невалидный или чужой source даёт прозрачный `400`, без утечки данных из другого notebook.

- При заданных `sourceIds` KNN и FTS5 запросы фильтруются по `chunks.source_id`.

- RRF, retrieval cache и rerank работают только с этим scoped candidate set.

- Cache key учитывает нормализованный упорядоченный список `sourceIds`, иначе можно вернуть старую выдачу из другого source scope.

- В `CitationChunk` передавать реальный `sourceKind`, `sourceId`, заголовок и location вида `Фрагмент N`; location берётся из `chunks.ordinal`.

- Existing `GET /api/notebooks/:id/sources/:sourceId` должен опционально возвращать chunks безопасным ограниченным способом, например `?include=chunks&limit=…`. Не отдавать неограниченно весь notebook одним запросом.

#### Минимальные API-тесты

- retrieval без `sourceIds` ищет по всем chunks notebook;

- retrieval с `sourceIds` никогда не выдаёт citation из невыбранного source;

- source ID из другого notebook отклоняется;

- cache не смешивает два разных source scopes;

- citation содержит правильный `sourceKind` и `location`.

### 2. Source selector в web-интерфейсе

В `SourcesPanel` добавить режим выбора контекста для чата:

- checkbox у каждого ready source;

- действия **«Все источники»**, **«Снять выбор»**, **«Только готовые»**;

- pending/failed sources нельзя включить в чат, но их статус остаётся видимым;

- отображение в ChatPanel: `Все источники` либо `3 из 9 источников`;

- выбранный scope сохраняется отдельно для каждого notebook в `localStorage`;

- если выбранный source удалён, он автоматически исключается из scope;

- при пустом выборе вопрос либо отправляется по всем источникам, либо UI явно предлагает выбрать минимум один. Выбрать один вариант и одинаково реализовать на клиенте и сервере.

**Рекомендация:** пустой список трактовать как «все готовые источники» — это сохраняет сегодняшнее поведение и не создаёт неожиданного пустого ответа.

### 3. Source reader и переходы из цитат

Добавить читаемую панель/side sheet источника.

Функции:

- заголовок, kind, URL, статус, дата импорта и summary;

- список чанков в исходном порядке с читаемыми границами;

- при клике по citation открывается нужный source и прокручивается к конкретному chunk;

- выбранный chunk получает заметную, но ненавязчивую подсветку;

- текущий citation dialog сохранить только как компактный fallback для маленьких экранов;

- для URL показать кнопку «Открыть оригинал»; не создавать иллюзию, что локальный текст идентичен оригинальной вёрстке страницы.

### 4. Chat continuity без расширения продуктового scope

Это маленькая, но обязательная корректировка UX:

- `ChatPanel` уже загружает persisted history, но сейчас не передаёт её в `streamChat`;

- передавать в API последние N валидных user/assistant turns (например, 12–16 сообщений), исключая system messages и пустые/error-only ответы;

- ограничить размер history по символам/токенам, чтобы retrieval context оставался приоритетным;

- показывать в UI, когда новый вопрос идёт по ограниченному source scope.

## Что сознательно вне scope

Не добавлять в этот milestone:

- labels/categories и полноценную организацию sources;

- Deep Research с обходом многих сайтов;

- новые форматы Studio: reports, tables, flashcards, quizzes, audio, video, slides, infographics;

- Google Drive sync, CSV/PPTX/ePub/audio/image import;

- sharing, auth, multi-user collaboration, PWA/mobile;

- сложный GraphRAG поверх только что подключённого graph extraction.

Все эти пункты важны, но они должны следовать после контролируемого source workspace. Полный Studio у Google включает много outputs — Audio/Video Overviews, mind maps, reports, flashcards, quizzes, tables, infographics и slide decks — и поэтому заслуживает отдельного milestone. [2] [3]

## Порядок выполнения для агента

1. **Review и тесты уже сделанных трёх изменений** — не начинать новый UI до прохождения Gate 0.

1. **Shared schema и backend filtering** — `sourceIds`, retrieval filter, cache key, citation metadata.

1. **Тесты API** — добавить стабильные тестовые seams, не зависящие от реального Ollama или пользовательской БД.

1. **UI source selection** — checkbox scope, local persistence, понятные empty/error states.

1. **Source reader и citation navigation** — один рабочий путь на desktop и приемлемый fallback на mobile.

1. **Chat continuity** — передача ограниченной history и визуальный indicator source scope.

1. **Manual smoke test** — импорт двух-трёх разных URL, question по одному source, question по двум sources, переход из citation, удаление source из scope, reload страницы.

1. **Документация** — README/HANDOFF, только после прохождения smoke test.

## Definition of Done

Milestone считается завершённым, только если выполнены все условия:

- [ ] `pnpm lint`, `pnpm build`, `pnpm test` и `git diff --check` проходят.

- [ ] API tests не используют реальный `192.168.1.110`, реальный Ollama или пользовательскую SQLite database.

- [ ] Три существующие функции — SSE recovery, mind map и graph ingestion — приняты отдельными тестами/smoke checks.

- [ ] Пользователь может ограничить чат одним или несколькими sources.

- [ ] Ответ с ограниченным scope не содержит citations из невыбранного source.

- [ ] Citation открывает source reader и подсвечивает нужный chunk.

- [ ] Scope переживает reload и корректно реагирует на удаление source.

- [ ] История последнего диалога реально участвует в следующем chat request, но не переполняет prompt.

- [ ] README/HANDOFF фиксируют завершённый status без временных формулировок «в работе».

- [ ] Нет новых секретов, реальных данных или generated SQLite files в Git.

## Что будет следующим milestone

После Source Workspace v1 следующий логичный этап — **Studio v1**:

1. report/brief с шаблонами (FAQ, executive summary, timeline, contradictions);

1. таблица сравнения с citations в ячейках;

1. flashcards/quiz с progress;

1. сохранение нескольких outputs на notebook с настройками, статусом и версией.

Это даст наиболее заметное ощущение NotebookLM без дорогой и инфраструктурно сложной Audio/Video generation. Интерактивные flashcards/quizzes у Google имеют настройки сложности, объяснения и прогресс, поэтому их стоит проектировать как отдельный продуктовый режим, а не как Markdown-список. [4]

## Prompt для запуска агента

```
Реализуй Milestone 1 «Source Workspace v1» из outputs/notebooklm-source-workspace-v1-plan.md.

Работай в текущей ветке fix/ingest-sse-and-lifecycle. Сначала прими, протестируй и не дублируй последние три изменения: f5c76f1 (mindmap route), 06c6081 (post-ingest graph extraction), f924271 (single-source endpoint / SSE fallback).

Затем реализуй source-scoped chat: sourceIds в shared schema, backend retrieval filtering и cache key, real sourceKind/location in citations, UI selection scope с persistence, source reader с jump-to-chunk из citation и передачу ограниченной chat history.

Обязательны API tests с временной SQLite и замоканным Ollama. Финальный DoD: pnpm lint, pnpm build, pnpm test, git diff --check; URL smoke-test; обновлённые README/HANDOFF. Не используй реальные credentials, реальную пользовательскую DB или живой Ollama в автотестах.
```

## References

[1]: https://support.google.com/gemininotebook/answer/16215270?hl=en&co=GENIE.Platform%3DDesktop "Add or discover new sources for your notebook"

[2]: https://notebook.google/ "Gemini Notebook product overview"

[3]: https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/ "What’s new in NotebookLM: Video Overviews and an upgraded Studio"

[4]: https://support.google.com/gemininotebook/answer/16958963?hl=en "Generate Flashcards or Quizzes in Gemini Notebook"