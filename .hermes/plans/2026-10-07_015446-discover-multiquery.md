# Plan — Sources Panel v2: единый пульт «сырья» в левой колонке

Branch: новый `feat/sources-cockpit` от `fix/ingest-sse-and-lifecycle`
(тот, что сейчас). **Только левая колонка** (`SourcesPanel`). Центр
(чат) и правая колонка (артефакты) не трогаем, кроме одного тонкого
места — см. «Границы». Это НЕ про Deep Research per se и НЕ про
отдельный «multi-topic» эндпойнт (см. «Что отменяется»).

## Концепция (по запросу Максима)

В оригинальном Google NotebookLM левая колонка — это **пульт сырья**:
там всё, что добывает материал в ноутбук. URL, web-search по одной и
по нескольким темам, YouTube (с расшифровкой), свои документы. Центр —
место, где пользователь сидит с этим контекстом: чат, вопросы,
перепроверка. Правая колонка — выжимки: заметки, карточки, отчёты,
подкаст, mindmap, share.

Сейчас в этом проекте левая колонка умеет ТОЛЬКО список + одна форма
добавления (`AddSourceBar`), а Deep Research болтается отдельной
кнопкой в шапке ноутбука (`NotebookPage.tsx:362–370`). Это нарушает
принцип «левая = сырьё, правая = выжимки»: Deep Research формально
даёт сырьё (источники), но открывается из шапки.

Предыдущая версия этого документа предлагала отдельный эндпойнт
`/multi-search-preview` и `DiscoverMultiDialog`. Этот кусок
**отменяется** в пользу более общего решения — всё, что нужно, уже
есть на сервере, не хватает только UI.

Конкретно:
- `MultiSearchPreviewRequestSchema` / `MultiSearchPreviewResponseSchema` —
  **не нужны**. UI будет в одном пульте делать N параллельных вызовов
  к существующему `search-preview` (по одному на каждую тему), склейка
  и дедуп — в браузере.
- `DiscoverMultiDialog.tsx` — **не создаём**.
- `multiSearchPreview()` в `apps/web/src/lib/api.ts` — **не добавляем**.
- API: `apps/api/src/routes/discover.ts` — **не трогаем**.
- API: `apps/api/src/extractors/websearch.ts` — **не трогаем**.

`searchPreview` (single) уже принимает `maxResults: 1..15`, в нём
дедуп и fallback-цепочка. Если окажется, что N параллельных HTTP из
браузера недостаточно — отдельный эндпойнт на сервере можно добавить
**позже**, когда будет понятно по реальному использованию. Сейчас
это N ≤ 6 параллельных запросов с одного клиента, серверная нагрузка
минимальна.

## Дизайн пульта

### Где живёт в UI

`SourcesPanel.tsx` сейчас имеет три блока сверху вниз:

1. Заголовок с refresh / select-all.
2. `AddSourceBar` — единое поле ввода + кнопка файла.
3. Список источников.

Делаем: блок 1 остаётся как есть. **Блок 2 разворачивается в
«пульт сырья»** — панель вкладок + контент выбранной вкладки. Блок 3
остаётся как есть, но теперь он показывает результаты работы пульта
(новые добавленные источники появляются тут же).

В мобильном (табы `< 640px`) `SourcesPanel` показывается только когда
активна mobile-вкладка `sources`. Пульт внутри него ведёт себя точно
так же — мобильный UX не меняется.

### Структура пульта

```
┌─ Пульт сырья ─────────────────────────────────────┐
│ [🔗 URL] [🔎 Поиск] [📺 YouTube] [🚀 Deep Research] │
├──────────────────────────────────────────────────┤
│  <контент активной вкладки>                        │
└──────────────────────────────────────────────────┘
```

Вкладки:

1. **URL** — бывший `AddUrlDialog`, но **встроенный** (без модального
   окна): поле URL + название + кнопка «Добавить» с прогресс-степпером.
   Ingest стримит через существующий `api.ingestUrlSourceStream`.

2. **Поиск** — бывший `DiscoverDialog`, но **встроенный**:
   - стейт-машина `topics → searching → preview → ingest`;
   - в `topics` можно добавить несколько полей-тем (кнопка «+ ещё
     тему»), `searching` параллельно вызывает `search-preview` по
     каждой, `preview` склеивает результаты с пометкой какой темой
     принесён каждый URL и дедупом по URL;
   - pre-select первых N URL (cap 10 — кап zod в `search-add-batch`).

3. **YouTube** — бывший `AddYoutubeDialog`, но **встроенный**: поле
   URL/ID + чекбокс ASR (Whisper) + кнопка.

4. **Deep Research** — бывший `DeepResearchDialog`, но **встроенный**:
   поле «Вопрос» + два слайдера (`maxQueries`, `maxSources`) + кнопка
   «Исследовать» + живой прогресс по фазам + список найденных
   страниц + превью отчёта. Используем **тот же**
   `api.deepResearchStream`. Никаких изменений на бэкенде.

Файл — отдельная модалка `AddFileDialog` (см. ниже).

Все вкладки делят одну панель прогресса (прогресс-степпер одинаковый
для всех ingest-флоу — уже есть в `SourcesPanel.tsx`,
`ProgressStepper` + `progressFromDelta`).

### Файл — почему модалка, а не вкладка

Системный file picker нормально работает только из отдельной модалки
или из обособленной кнопки. Простое `<input type="file">` в DOM
пульта не даёт чистого UX без отдельной обёртки — у него нет
видимой кнопки «Открыть Finder», как у `<Dialog>`. Поэтому:

- в пульте 4 вкладки (URL, Поиск, YouTube, Deep Research);
- кнопка «Файл» остаётся **отдельной кнопкой** в нижней части пульта
  или сбоку, открывает существующий `AddFileDialog` как модалку;
- `AddFileDialog` не переписываем, переезжает на верхний уровень
  `SourcesPanel`.

### Границы — что НЕ меняется

- `ChatPanel` (центр) — без изменений. Источники, добавленные через
  пульт, попадают в его retrieval ровно так же, как сейчас.
- `ArtifactsPanel` (правая колонка) — без изменений. Deep Research
  по-прежнему создаёт артефакт (отчёт), и он показывается там же.
- **Кнопка «Deep Research» в шапке ноутбука**
  (`NotebookPage.tsx:362–370`) **убирается**. Решение принято: для
  пользователя она лишняя — единственный визуальный вход теперь
  вкладка «Deep Research» в `SourcesCockpit`. Заодно в
  `NotebookPage.test.tsx:152` обновляем тест, который проверяет
  наличие кнопки в шапке, на её отсутствие.
- `NotebooksListPage`, sharing, export, settings — без изменений.
- `CommandPalette.tsx` — без изменений (его команда «Deep Research»
  тоже открывает тот же диалог).
- `classifySourceInput` / `normalizeUrlInput` — остаются экспортируемыми
  функциями в `SourcesPanel.tsx`. В новой версии они не используются
  в `SourcesPanel`, но юнит-тесты на них живут — удалять нерационально,
  и они могут пригодиться для повторного hotkey-входа в пульт.

## Изменения по слоям

### 1. Web: `apps/web/src/components/SourcesPanel.tsx` (основная правка)

Удалить из верхнего уровня `SourcesPanel`:

- Состояние `showAddUrl`, `showAddYt`, `showAddSearch`.
- Состояние `pendingValue` (был мостом от `AddSourceBar` к модалкам).
- Рендер `<AddSourceBar>`.
- Три блока `{showAddX && <AddXDialog …/>}` — для URL, YouTube, Search.

Заменить `AddSourceBar` на новый компонент `SourcesCockpit` (см. п. 2).
Оставить `showAddFile` и рендер `<AddFileDialog>`.

Сохранить в `<SourcesPanel>`:

- Заголовок (refresh, select-all).
- Empty state — обновить текст: «Вставьте ссылку или выберите режим
  вверху».
- Список источников (`SourceItem` рендер).
- `<SourceDetailSheet>` и подтверждение удаления.
- `useSourceScope` и связанные с ним `selected`/`onToggle` — не трогаем.
- Хелперы `classifySourceInput`, `normalizeUrlInput` — оставить как
  есть, чтобы не сломать тесты.

### 2. Web: новый `apps/web/src/components/SourcesCockpit.tsx`

Один файл, ~250-300 строк. Содержит:

```tsx
type CockpitTab = 'url' | 'search' | 'youtube' | 'deep';

export function SourcesCockpit({
  notebookId,
  onSourceAdded,
}: {
  notebookId: string;
  onSourceAdded?: () => void;
}) {
  const [tab, setTab] = useState<CockpitTab>('url');
  return (
    <div className="border-b" style={{ borderColor: 'rgb(var(--nb-border))' }}>
      <nav role="tablist" className="flex gap-1 px-2 pt-2">
        {/* 4 tab buttons, иконки из icons/NotebookLogo.tsx */}
      </nav>
      <div className="px-4 pb-4">
        {tab === 'url' && <CockpitUrl notebookId={notebookId} onAdded={onSourceAdded} />}
        {tab === 'search' && <CockpitSearch notebookId={notebookId} onAdded={onSourceAdded} />}
        {tab === 'youtube' && <CockpitYoutube notebookId={notebookId} onAdded={onSourceAdded} />}
        {tab === 'deep' && <CockpitDeepResearch notebookId={notebookId} onAdded={onSourceAdded} />}
      </div>
    </div>
  );
}
```

Каждый под-компонент — почти точная копия существующего
`AddUrlDialog` / `DiscoverDialog` / `AddYoutubeDialog` /
`DeepResearchDialog`, но без обёртки `<Dialog>` и без локального
`progress` — общий прогресс-степпер живёт в `SourcesCockpit` и
показывается, когда любой из под-компонентов стримит.

**Самый деликатный кусок — `CockpitSearch`** (multi-topic в одной
вкладке). План его реализации:

- Локальный стейт:
  - `topics: string[]` (стартует с одной пустой строки),
  - `resultsByTopic: Record<string, SearchPreviewResult[]>`,
  - `selected: Set<string>`,
  - `mode: 'idle' | 'searching' | 'preview' | 'ingest'`,
  - `perQueryLimit: number` (default 5, cap 10).
- Кнопка «+ ещё тему» добавляет пустую строку в `topics`.
  Кнопка «×» у каждой темы убирает её (если тем > 1).
  Кнопка `+ тему` неактивна когда `topics.length >= 6` (cap 6 тем —
  по аналогии с `maxQueries: 1..6` в `DeepResearchRequest`).
- Кнопка «Найти» — параллельный вызов
  `Promise.all(topics.map(t => api.searchPreview(notebookId, t, perQueryLimit)))`.
  На каждый ответ — добавление в `resultsByTopic[t]`.
  Если хоть один из `topics` пустой — кнопка неактивна.
- Когда все Promise разрешились — переход в `preview`. UI показывает
  плоский список с чекбоксами; рядом с каждым URL — маленький чип с
  темой, из которой он пришёл (берём из `resultsByTopic[topic]`,
  у которого URL первый).
- Дедуп по URL **в браузере**: в Map по URL кладём только первый
  встретившийся, остальные отбрасываем. `selected: Set<string>`
  инициализируется первыми N URL (cap 10 — кап zod).
- Кнопка «Добавить выбранное» — вызов
  `api.ingestSearchAddBatchStream(notebookId, {urls: [...]}, delta => …)`
  — ровно как в существующем `DiscoverDialog`.
- Кнопка «Назад к темам» — очищает `resultsByTopic` и возвращает в
  `idle`.
- Если пользователь выбрал > 10 URL, в UI показываем warning
  «выбрано 12 — добавлю первые 10» и режем `selected` до 10.

### 3. Web: `apps/web/src/components/SourcesCockpit.test.tsx`

~200 строк. По одному тесту на каждую вкладку:

- URL tab: ввод → mock `api.ingestUrlSourceStream` → прогресс
  стримит → `onSourceAdded` вызван.
- Search tab: 1 тема → превью с чекбоксами → выбор → ingest через
  mock stream.
- Search tab: 2 темы → результаты обеих видны, у каждого URL — чип
  темы, дедуп по URL работает (если обе вернули одинаковый URL —
  показывается один раз, чип = первая тема).
- Search tab: 7-я попытка добавить тему — кнопка неактивна.
- Search tab: >10 выбранных URL → warning + cap до 10.
- YouTube tab: ввод URL + ASR toggle → mock
  `api.ingestYoutubeAsrSourceStream`.
- Deep tab: ввод вопроса + start → mock `api.deepResearchStream`,
  SSE дельты, прогресс по фазам, onCreated → `onSourceAdded`.
- Проверка общего прогресс-степпера: при активном ingest любой
  под-компонент показывает один и тот же stepper.

### 4. Web: `apps/web/src/components/SourcesPanel.test.tsx` (обновить)

Удалить тесты, которые проверяют:
- `showAddUrl`/`showAddYt`/`showAddSearch` стейт.
- `AddSourceBar` рендер и его `onSubmit` классификацию (она теперь
  не используется в `SourcesPanel`).

Добавить:
- `SourcesPanel` рендерит `<SourcesCockpit>` на месте `AddSourceBar`.
- При вызове `onSourceAdded` из кокпита —
  `qc.invalidateQueries({queryKey: ['sources', notebookId]})`
  срабатывает.

### 5. API: без изменений

Серверная часть не трогается вообще. Все нужные эндпойнты:

- `POST /api/notebooks/:id/sources/url`
- `POST /api/notebooks/:id/sources/youtube`
- `POST /api/notebooks/:id/sources/youtube-asr`
- `POST /api/notebooks/:id/search-preview`
- `POST /api/notebooks/:id/search-add-batch`
- `POST /api/notebooks/:id/sources/file`
- `POST /api/notebooks/:id/deep-research`

— уже существуют, зарегистрированы в `buildApp()`, end-to-end
протестированы. Никаких миграций БД.

### 6. Shared: без изменений

Zod-схемы `SearchPreviewRequest/Response`, `SearchAddBatch*`,
`DeepResearchRequest/Delta/Meta`, `Source` — без правок.

### 7. Web: `apps/web/src/lib/api.ts` — без изменений

Все нужные wrappers уже есть: `searchPreview`, `ingestUrlSourceStream`,
`ingestYoutubeSourceStream`, `ingestYoutubeAsrSourceStream`,
`ingestSearchAddBatchStream`, `uploadFileSource`, `deepResearchStream`.

## Почему НЕ делаем отдельный «multi-search-preview» эндпойнт

1. **Сервер уже готов к N параллельным вызовам.** `search-preview`
   не имеет кеша и не использует сессионного контекста — N параллельных
   HTTP с одного клиента дёшевы и для сервера, и для сети. Если в
   будущем захочется дедуп на сервере — отдельный эндпойнт добавим
   **после** реального использования, а не спекулятивно.

2. **Дедуп «какой темой принесён URL» удобнее делать в браузере.**
   Когда каждый URL имеет пометку `query`, легко показать чип и
   сгруппировать. На сервере пришлось бы городить `Map<url, query[]>`,
   а ответ стал бы тяжелее без видимой пользы.

3. **Backward-compatible.** Один пульт, который вызывает существующие
   эндпойнты — никаких новых контрактов, никаких `// TODO: opengraph`
   в API.

## Почему НЕ объединяем Studio / Audio / Share в тот же пульт

Это другой класс действий: они создают **артефакты** (правая колонка),
а не сырьё (левая). Смешивать «добавить источник» и «сгенерировать
отчёт» в одном пульте — нарушает тот самый принцип разделения
«сырьё / работа с контекстом / выжимки», который и должен быть
фундаментом этого UI. Если позже понадобится «пульт артефактов»
справа — это будет аналогичный пульт, но в `ArtifactsPanel`. Это
отдельный план.

## Definition of Done

1. `pnpm --filter @notebook/api exec tsc --noEmit` чист.
2. `pnpm --filter @notebook/web exec tsc --noEmit` чист.
3. `pnpm test` зелёный во всех трёх workspace (минимум +1 новый
   `SourcesCockpit.test.tsx` с покрытием каждой вкладки).
4. `pnpm --filter @notebook/api build` производит `dist/bundle.mjs`.
5. Manual smoke на `:4001` / `:5173`:
   - открыть ноутбук, увидеть пульт с 4 вкладками (URL, Поиск,
     YouTube, Deep Research);
   - **URL**: вставить `https://example.com` → стримит прогресс →
     источник появился в списке;
   - **Поиск**: ввести 2 темы (например «MCP протокол», «A2A протокол»),
     нажать «Найти» → превью с двумя группами результатов, чип
     темы у каждого URL → выбрать 4 → «Добавить выбранное» →
     4 новых source в списке;
   - **YouTube**: вставить `https://www.youtube.com/watch?v=…` →
     источник появился;
   - **YouTube + ASR**: тот же URL + чекбокс ASR → долгий прогресс →
     ready;
   - **Deep Research**: ввести «Что такое MCP?» → стримит 4 фазы →
     отчёт появился в Artifacts, 3-5 source в списке;
   - **Файл**: открыть через оставшуюся модалку, загрузить .txt →
     source в списке.
6. **Кнопка «Deep Research» в шапке ноутбука отсутствует**
   (проверяем через `screen.queryByTestId('open-deep-research')`
   возвращает `null`); Cmd+K → Deep Research работает как раньше
   (открывает тот же диалог через `setShowDeepResearchDialog`);
   пульт работает независимо.

## Файлы, которые меняются (итого)

API — без изменений.
Shared — без изменений.

Web:
- `apps/web/src/components/SourcesPanel.tsx` (переработка —
  удаление `AddSourceBar`/трёх стейтов/трёх модалок,
  добавление рендера `<SourcesCockpit>`; `AddFileDialog` остаётся)
- `apps/web/src/components/SourcesCockpit.tsx` (новый, ~250-300 строк)
- `apps/web/src/components/SourcesCockpit.test.tsx` (новый, ~200 строк)
- `apps/web/src/components/SourcesPanel.test.tsx` (обновить —
  убрать старые тесты на `AddSourceBar`/модалки URL/YouTube/Search,
  добавить тест рендера пульта)
- `apps/web/src/pages/NotebookPage.tsx` (удалить кнопку «Deep Research»
  из шапки — `NotebookPage.tsx:362–370`; стейт
  `showDeepResearchDialog` остаётся, т.к. его использует Command Palette;
  импорт `DeepResearchDialog` остаётся для рендера модалки)
- `apps/web/src/pages/NotebookPage.test.tsx` (заменить
  `expect(...open-deep-research).toBeInTheDocument()` на
  `expect(...open-deep-research).not.toBeInTheDocument()` на строке 152)

Никаких миграций БД, никаких изменений в `db/schema.ts`, никаких
новых эндпойнтов, никаких изменений в `shared/`, никаких изменений
в `lib/api.ts`. Existing dialogs (`AddUrlDialog`, `AddYoutubeDialog`,
`DiscoverDialog`, `DeepResearchDialog`) удаляются **только** после
того, как их содержимое полностью перенесено в `SourcesCockpit` — в
одной ветке, без half-state.