# NotebookLM / Gemini Notebook UX-gap research notes

Date: 2026-09-29

## Official product findings

1. Google’s current landing page presents source-grounded chat plus a Studio of Audio Overviews, Mind Maps, Reports, Flashcards, Quizzes, Video Overviews, Data Tables, Infographics and Slide Decks.
   - https://notebook.google/

2. The 2025 Studio update describes four primary Studio tiles (Audio Overview, Video Overview, Mind Maps and Reports), persistent lists of created outputs, multiple outputs of the same type per notebook, custom audiences/goals/focus for video, and parallel use (for example listen while browsing a mind map).
   - https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/

3. Official source documentation describes broader imports than the local clone: audio, pasted text, Google Docs/Slides/Sheets, images, DOCX/TXT/MD/PDF/CSV/PPTX, Play Books, web URLs, ePub, public YouTube, Gemini chats. It also documents source selection for scoped chat, Fast Research, Deep Research, bulk source import, labels/categories and Drive sync.
   - https://support.google.com/gemininotebook/answer/16215270?hl=en&co=GENIE.Platform%3DDesktop

4. Flashcards/quizzes are background Studio jobs with user configuration (difficulty and prompt) and real interactive study affordances: explanations, progress, retry/missed-only flows, shuffle and CSV export.
   - https://support.google.com/gemininotebook/answer/16958963?hl=en

## Local codebase snapshot used for comparison

- Strong base already exists: URL/file/YouTube ingest, Discover preview/import, SQLite + sqlite-vec + FTS5/BM25/RRF, reranked SSE chat, citations, source summaries, chat history, Markdown artifacts.
- Current direct UX gaps observed in code:
  - Chat UI stores and displays history but does not pass `history` into `streamChat`, so multi-turn context is not sent to the API.
  - Sources are not individually selected/scoped for a chat request.
  - Citations open a modal snippet, but there is no source reader, deep-linked chunk highlight or source location context.
  - Artifacts are Markdown-only and the panel is editor/list oriented, not a persistent multi-output Studio.
  - Import coverage excludes pasted text, CSV/PPTX/ePub/images/audio, Drive sync and source refresh/change management.
  - Current active agent work: SSE recovery; end-to-end mind map; automatic knowledge graph extraction.

## UX-first priority thesis

1. Finish the three active reliability/output tasks.
2. Make the source workspace deliberate: source selection, labels/collections, source reader, source-scoped chat and citation navigation.
3. Make research a guided collection flow: query plan, parallel discovery, provenance/quality cards, dedupe and user-controlled bulk import.
4. Turn artifacts into Studio: reports/briefs, comparison tables, flashcards/quizzes and persistent generated-output cards before heavier media.
5. Add chat continuity, suggested next questions, answer verification and output controls.
6. Add Audio Overview later as the headline experiential feature; video/slides/infographics only if the use case warrants media-generation cost and latency.
