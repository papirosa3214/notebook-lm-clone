# NotebookLM feature parity & retrieval reranker options

Date: 2026-09-17. Repo: `notebook-lm-clone` (commit at HEAD). Scope: research-only deliverable.

---

## 1. What the codebase ships today

Vite + React 19 + TS frontend (`apps/web`, :5173), Fastify 5 + TypeScript backend (`apps/api`, :4001) with a local SQLite + `sqlite-vec` vector store. Embeddings via Ollama `bge-m3-embed` (1024-dim, batched 8 in parallel). LLM providers: Ollama (`qwen3.6-27b-iq4-16k` default), Anthropic, OpenAI. Retrieval is pure KNN over `vec_chunks` — no cross-encoder rerank step, no hybrid BM25, no metadata filter beyond `notebook_id`.

Sources (`apps/api/src/routes/sources.ts`, `apps/web/src/components/SourcesPanel.tsx`):
- URL → `fetch` → `html2text` → markdown
- YouTube → `youtube-transcript` (HTML scrape; known-fragile, fallback to `yt-dlp` not wired)
- File upload: PDF (`pdf-parse`), DOCX (`mammoth`), TXT, MD — multipart, 10MB limit implicit

Ingest (`apps/api/src/vectordb/client.ts:51`): recursive splitter, ~2048 char chunks + 200 char overlap, ~30 chunks per Wikipedia page. Progress is streamed back over SSE during embed so the proxy doesn't kill the connection.

Retrieval + chat (`apps/api/src/routes/chat.ts`):
- `embed(question)` → `sqlite-vec` KNN top-K (default 6, client sends `topK: 5`)
- JOIN with `chunks` metadata → `CitationChunk[]`
- System prompt: `CITATION_INSTRUCTIONS` + numbered sources (`packages/shared/src/providers.ts`)
- SSE: `citations` → `token`×N → `done` | `error`
- LLM must emit `[N]` markers; UI renders them as citation chips with a dialog on click

Other surfaces:
- **Summary panel** (`apps/api/src/routes/summary.ts`, `apps/web/src/components/SummaryPanel.tsx`): streamed AI summary per notebook, cached in `localStorage`, citation chips wired to the same dialog
- **Artifacts** (`apps/api/src/routes/artifacts.ts`, `apps/web/src/components/ArtifactsPanel.tsx`): markdown CRUD, `.md` download, "save chat answer as artifact" prefilled flow
- **Web discover** (`apps/api/src/routes/discover.ts`): DuckDuckGo → preview batch → ingest batch on confirm
- **UI shell** (`apps/web/src/pages/NotebookPage.tsx`): 3-column resizable layout, dark mode (`hooks/useTheme.ts`), mobile tabs, citation dialog

What's notably absent: any second-stage rerank, hybrid retrieval, query rewriting, source-grounded verification, conversational memory beyond a flat `history[]`, auth (single-user assumption in README), or per-source access controls.

---

## 2. NotebookLM feature gap (now branded "Gemini Notebook")

Google rebranded NotebookLM → **Gemini Notebook** in 2026. Source: [Wikipedia — Gemini Notebook](https://en.wikipedia.org/wiki/Gemini_Notebook) (redirects from "NotebookLM", tagline "AI research tool, thinking partner"). The [landing page](https://notebook.google.com/) confirms the new name and tagline. Below, "NotebookLM" means the upstream Google product.

| # | Feature | Priority | Effort | Notes |
|---|---|---|---|---|
| 1 | **Audio Overview** — podcast-style two-host dialogue generated from sources, downloadable as mp3, transcript follows the audio | **P0** | XL | Largest differentiator. Officially launched Oct 2024 — see [Workspace Blog: Introducing Audio Overviews in NotebookLM](https://workspace.google.com/blog/product-announcements/introducing-audio-overviews-in-notebooklm). Requires TTS pipeline (no local equivalent for the two-host effect short of running an open TTS model + scripted dialogue) and a separate generation UI. Not a candidate for this repo's current stack — would mean shipping audio binaries or hitting a paid TTS API. |
| 2 | **Inline citation chips with hover preview** in chat text (not only a click-to-open dialog) | **P0** | S | We already render `[N]` chips and have a `CitationChunk[]` payload on each assistant message (`apps/web/src/components/ChatPanel.tsx:74`). Need a hover/click popover that shows source title + a snippet from `chunk.text` directly inline (without opening the dialog). Reuses existing SSE `citations` event. |
| 3 | **Verified/source-grounded answering** — LLM must refuse or hedge when chunks don't actually contain the answer | **P0** | M | Today the system prompt just asks for `[N]` markers; the model hallucinates citations sometimes. Tighten `CITATION_INSTRUCTIONS` in `packages/shared/src/providers.ts` (require `UNSUPPORTED` marker when no chunk answers) and add a server-side sanity check that strips `[N]` markers whose index isn't in the supplied `citations`. |
| 4 | **Suggested follow-up questions** after each answer (3 chips below the assistant bubble) | **P1** | S | After `done` event, fire a small LLM call (low temp, cheap model — Ollama qwen3.6 or Haiku) with "given this Q&A and sources, suggest 3 short follow-up questions" and stream them as a `suggestions` SSE delta. Pure frontend + one extra route. |
| 5 | **Source-grounded "compare" mode** — explicit "compare A and B across all sources" chat intent that surfaces a side-by-side table | **P1** | M | Mostly prompt-engineering: detect "compare / vs / difference between" intent, force a structured output schema (markdown table) and render it in `ChatPanel`. No new infra. |
| 6 | **Multi-format source previews** — render PDF first page, DOCX body, image thumbnail inline in the source list | **P1** | M | Today `SourcesPanel` only shows title + kind. Add a preview endpoint that returns first 600px rendered as PNG via `pdfjs-dist` / `mammoth.toHtml()` / a simple image proxy. Significant work. |
| 7 | **Mind map view** of all sources/chunks — interactive graph | **P1** | L | Google shipped "Mind Map" in 2025. We'd need to extract entity/keyword triples per chunk (LLM pass over each source or use a local NER model), then render with `react-flow`. Real effort. |
| 8 | **Structured tables (Studio / Data Table)** — auto-generate comparison tables from sources | **P1** | M | Same schema-forcing trick as #5, but exposed as its own "Artifact type: table" so users can re-roll. |
| 9 | **Notebook sharing** — read-only public link, share via email | **P2** | M | Requires either auth + signed URLs or a token-based `GET /api/notebooks/:id/public?token=…` endpoint + minimal "viewer mode" UI. README already flags auth as a known gap. |
| 10 | **Inline AI note assistance** — selected text → "rewrite / expand / summarize" inside artifact editor | **P2** | M | Need a text-selection layer in `ArtifactsPanel` editor, then a thin `POST /api/artifacts/:id/ai-edit` route that takes `{selection, instruction}` and streams the result back. |
| 11 | **Mobile parity** — proper iOS/Android PWA with swipe between sources/chat/artifacts, audio playback | **P2** | L | Today we have "mobile tabs" in `NotebookPage.tsx` but no PWA manifest, no offline cache, no audio. Big UI rework. |
| 12 | **Export** — zip a notebook + all sources as a bundle | **P2** | S | Add `GET /api/notebooks/:id/export.zip` that bundles artifacts + source markdown + a JSON metadata file. Pure server. |
| 13 | **Source-grounded confidence score** rendered per citation chip | **P2** | S | We already pass `score` (`distance` from sqlite-vec) on `CitationChunk`. Just show it; maybe color the chip. README caveat: distance is unnormalized — only useful for ordering, not display. |

**P0 = core NotebookLM differentiator users notice immediately.** Three of them: Audio Overview (we cannot ship locally without major infra), inline citation hover preview (we have all the data already), and verified answers (a prompt + server-side check).

---

## 3. Reranker options for our retrieval pipeline

Current flow: `embed(question)` → `sqlite-vec` KNN top-6 → prompt LLM. Slot-in point: between KNN and prompt. New flow: KNN top-20 → rerank → top-6 → prompt.

| Option | Effort (1–5) | Latency per chat turn | Cost | GPU? | Integration sketch |
|---|---|---|---|---|---|
| **Cohere Rerank v3 / 3.5** | **1** | ~200–400 ms (SaaS) | Paid ($1–2 per 1k searches) | No (their GPUs) | One HTTP call to `api.cohere.com/v2/rerank` from `vectordb/client.ts`. 6 lines of code. Drop-in. |
| **bge-reranker-v2-m3** (local, via Ollama) | **2** | ~300–800 ms per query on `bge-reranker-v2-m3` Ollama build, ~1.5s on CPU | Free, MIT-friendly ([HF model card](https://huggingface.co/BAAI/bge-reranker-v2-m3), Apache-2.0) | Yes (best on GPU), CPU works | Add a second Ollama model on `.110:11434`, expose `embed_rerank(q, [doc])`, swap in `retrieve()`. Same network, same process, same failure mode as bge-m3 today. |
| **Cross-encoder via sentence-transformers** (separate Python service) | **4** | ~50–200 ms on GPU, 1–3 s on CPU | Free | Yes (strongly recommended) | New `apps/rerank/` Python service, FastAPI, `FlagReranker` from `sentence-transformers`, on `:4002`. Adds an inter-service hop + Python toolchain to the monorepo. |
| **LLM-based rerank** (qwen3.6 / Haiku scores chunks) | **3** | 2–6 s for 20 chunks × prompt | Paid (Anthropic/OpenAI) or free (Ollama, but slow) | Optional | Prompt: "Given query, rank these N chunks by relevance. Return JSON array of indices". Brittle (JSON format failures), expensive in tokens, slow. |
| **mixedbread MX-Rerank-Large** (open weights) | **3** | ~100–400 ms on GPU | Free (Apache-2.0), self-host | Yes | Same shape as bge-reranker — pull into the Ollama-style Python service or run via TEI. Less mature ecosystem than BGE. |

**Concrete integration cost in our codebase:**
- **Cohere**: ~1 hour. Add `COHERE_API_KEY` to `.env.example`, new `apps/api/src/vectordb/rerank.ts`, swap `retrieve()`. Only blocker: paid SaaS + egress of chunk text to third party.
- **bge-reranker-v2-m3 via Ollama**: ~3–4 hours including a smoke test. The model has [an Ollama build path](https://huggingface.co/BAAI/bge-reranker-v2-m3) (sentence-transformers; can also be wrapped behind `text-generation` inference for Ollama). Same Ollama server we already use for embeddings, so no infra change.
- **Python sentence-transformers service**: ~1 day. New service in `apps/rerank/`, pnpm-managed `concurrently` for local dev, Dockerfile for deploy, `/healthz` route.
- **LLM rerank**: ~half a day + ongoing token cost. Easy to wire, hard to make reliable — JSON-format retries eat the latency win.
- **mixedbread**: comparable to bge but less traction; pick only if we want a second open-weights hedge.

**Effect on the chat loop.** Today: 1 embed call (~1.5 s with bge-m3 cold, ~0.2 s warm) + 1 LLM call. After rerank: 1 embed + 1 rerank call on 20 chunks (~0.3–1 s) + 1 LLM call. For Ollama rerank on the same GPU, expect +300–800 ms wall time. For Cohere, +200–400 ms wall + SaaS dependency.

**Ingest pipeline changes?** None. Rerank runs at query time over already-embedded chunks; no re-ingest required. (If we wanted to do this with a cross-encoder that scores (query, chunk) pairs, we still don't need to re-embed chunks — only the reranker scoring step is new.)

**Licensing notes.** bge-reranker-v2-m3 is [Apache-2.0](https://huggingface.co/BAAI/bge-reranker-v2-m3), commercial OK. Cohere SaaS has its own terms; data leaves our box. mixedbread MX-Rerank-Large is Apache-2.0 as of 2025. sentence-transformers itself is Apache-2.0.

---

## 4. Recommendation

**First: ship the inline citation hover preview (gap #2, P0, ~S effort).** We already have every required signal in `CitationChunk[]`; it's a pure UI change in `ChatPanel.tsx`. Highest signal-per-hour win, no infra work.

**Second, on the retrieval side: plug in bge-reranker-v2-m3 via Ollama.** It runs on the same `.110:11434` instance we already hit for embeddings (no new service, no new process, no new deploy), it's Apache-2.0, and it slots into `retrieve()` in `apps/api/src/vectordb/client.ts:221` between the KNN query and the `citations` map. Expected wall-time cost per chat turn: +300–800 ms on the same GPU. Cohere is faster to wire (~1 hour) but adds a paid SaaS dependency and sends chunk text off-box; pick Cohere only if we explicitly want zero-infra-changes and are willing to pay. LLM-based rerank is a non-starter on latency and reliability.

**Third (optional): server-side citation verification (gap #3, P0, ~M effort).** Tighten `CITATION_INSTRUCTIONS` in `packages/shared/src/providers.ts` and add a post-stream check that drops `[N]` markers pointing at non-existent chunk indices. Combined with the rerank, this is the highest-leverage combo for "answers actually grounded in my sources" — the single thing NotebookLM is famous for and the single thing users complain about when it's missing.

Everything else (Audio Overview, Mind Map, sharing, mobile, etc.) is real work that should be scoped separately and budgeted.
