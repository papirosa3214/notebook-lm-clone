import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { artifacts, notebooks } from '../db/schema.js';
import { retrieveWithRerank } from '../vectordb/client.js';
import { getProvider } from '../providers/index.js';
import type { ChatStreamEvent } from '@notebook/shared/providers';

const Body = z.object({
  /** Optional user focus — what to map. Default: the whole notebook. */
  focus: z.string().max(200).optional(),
});

interface MindMapNode {
  id: string;
  label: string;
}
interface MindMapEdge {
  from: string;
  to: string;
}

interface MindMapResponse {
  title: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

/**
 * Generate a mind-map of the notebook's key concepts.
 *
 * 1. Retrieve top chunks (with rerank) for the focus question.
 * 2. Single LLM call asking for a JSON {title, nodes[], edges[]} —
 *    nodes are concepts/themes, edges are relationships between them.
 * 3. Validate the JSON shape and persist as an artifact with a
 *    hand-rendered SVG body (the frontend doesn't render JSON mind
 *    maps natively, so we bake the SVG in here).
 */
export const mindmapRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/mindmap',
    async (req, reply) => {
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const focus = parsed.data.focus ?? 'основные концепции и связи между ними';

      // Pull chunks; if there are too few the mind map will be tiny —
      // that's an honest signal to the user, not a failure.
      let chunks: Awaited<ReturnType<typeof retrieveWithRerank>> = [];
      try {
        chunks = await retrieveWithRerank(req.params.id, focus, 12, {
          provider: nb.defaultProvider,
          model: nb.defaultModel,
        });
      } catch {
        // fall through with empty chunks — LLM will be told
      }

      const context = chunks
        .map((c, i) => `[${i + 1}] ${c.document_keyword}\n${c.content.slice(0, 500).replace(/\s+/g, ' ').trim()}`)
        .join('\n\n---\n\n');

      const systemPrompt = [
        'Ты составляешь майнд-карту концепций.',
        'Тебе дан список фрагментов из ноутбука. Выдели 6-12 ключевых концепций и связи между ними.',
        'Ответь строго JSON в формате: {"title":"...","nodes":[{"id":"n1","label":"..."},...],"edges":[{"from":"n1","to":"n2"},...]}',
        'id — короткие (n1, n2, …). label — 1-3 слова по-русски.',
        'Только валидные id в edges (id из nodes). Без markdown-обёрток.',
      ].join('\n');

      const userPrompt = `Фокус: ${focus}\n\nФрагменты:\n${context || '(нет фрагментов — сгенерируй из общего знания о теме)'}`;

      const providerId = nb.defaultProvider as 'ollama' | 'anthropic' | 'openai';
      const provider = getProvider(providerId);
      const model = nb.defaultModel;

      let acc = '';
      try {
        for await (const ev of provider.chat({
          providerId,
          model,
          context: [],
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          maxTokens: 800,
        })) {
          const e = ev as ChatStreamEvent;
          if (e.text) acc += e.text;
          if (e.done) break;
        }
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'mindmap generation failed',
        });
      }

      const mm = parseMindMap(acc);
      if (!mm) {
        return reply.code(500).send({
          error: 'LLM returned invalid JSON',
          raw: acc.slice(0, 500),
        });
      }

      // Render an inline SVG and save as artifact. SVG body fits in
      // contentMd — the frontend renders it inside the artifact card.
      const svg = renderMindMapSvg(mm);
      const artifactId = nanoid(12);
      const title = mm.title || 'Майнд-карта';
      db.insert(artifacts)
        .values({
          id: artifactId,
          notebookId: req.params.id,
          title,
          contentMd: svg,
        })
        .run();
      const created = db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .get();
      reply.code(201).send({ artifact: created, mindmap: mm });
    },
  );
};

function parseMindMap(raw: string): MindMapResponse | null {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) candidates.push(fence[1] ?? '');
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      if (!obj || typeof obj !== 'object') continue;
      const o = obj as { title?: unknown; nodes?: unknown; edges?: unknown };
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) continue;
      const nodes: MindMapNode[] = [];
      const seen = new Set<string>();
      for (const n of o.nodes) {
        if (!n || typeof n !== 'object') continue;
        const node = n as { id?: unknown; label?: unknown };
        if (typeof node.id !== 'string' || typeof node.label !== 'string') continue;
        const id = node.id.trim();
        const label = node.label.trim().slice(0, 60);
        if (!id || !label || seen.has(id)) continue;
        seen.add(id);
        nodes.push({ id, label });
      }
      const edges: MindMapEdge[] = [];
      const seenEdges = new Set<string>();
      for (const e of o.edges) {
        if (!e || typeof e !== 'object') continue;
        const edge = e as { from?: unknown; to?: unknown };
        if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
        if (!seen.has(edge.from) || !seen.has(edge.to)) continue;
        if (edge.from === edge.to) continue;
        const key = `${edge.from}|${edge.to}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ from: edge.from, to: edge.to });
      }
      if (nodes.length < 2) continue;
      return { title, nodes, edges };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Pure-SVG mind-map renderer. No external deps. Layout: nodes are
 * placed on a circle around the centre; edges are straight lines; the
 * root concept (first node) sits at the centre, others spread around
 * it proportionally to their edge weight.
 */
function renderMindMapSvg(mm: MindMapResponse): string {
  const W = 800;
  const H = 600;
  const cx = W / 2;
  const cy = H / 2;
  const nodes = mm.nodes;
  const N = nodes.length;
  // Place first node at centre, others on a circle. Adjust radius by N.
  const radius = N <= 4 ? 160 : N <= 8 ? 210 : 250;
  const positions = new Map<string, { x: number; y: number; r: number }>();
  positions.set(nodes[0]!.id, { x: cx, y: cy, r: 56 });
  for (let i = 1; i < N; i++) {
    const angle = ((i - 1) / Math.max(1, N - 1)) * Math.PI * 2 - Math.PI / 2;
    positions.set(nodes[i]!.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      r: 38,
    });
  }

  // Edges.
  const edgesSvg = mm.edges
    .map((e) => {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) return '';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="currentColor" stroke-width="1.5" opacity="0.45" />`;
    })
    .join('');

  // Nodes.
  const nodesSvg = nodes
    .map((n) => {
      const p = positions.get(n.id)!;
      const fontSize = n === nodes[0] ? 15 : 13;
      const lines = wrapLabel(n.label, 16);
      const lineHeight = fontSize * 1.2;
      const totalHeight = lines.length * lineHeight;
      const rectY = p.y - p.r;
      const textStart = p.y - totalHeight / 2 + fontSize;
      const text = lines
        .map(
          (line, idx) =>
            `<tspan x="${p.x}" y="${textStart + idx * lineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join('');
      const isRoot = n === nodes[0];
      const fill = isRoot ? 'rgb(var(--nb-accent))' : 'rgb(var(--nb-surface))';
      const stroke = isRoot ? 'rgb(var(--nb-accent))' : 'rgb(var(--nb-border))';
      const textColor = isRoot ? '#ffffff' : 'rgb(var(--nb-ink))';
      return `<g><circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${fill}" stroke="${stroke}" stroke-width="${isRoot ? 0 : 1.5}" /><text x="${p.x}" y="${rectY - 6}" text-anchor="middle" font-size="${fontSize}" font-family="system-ui, sans-serif" fill="${textColor}" font-weight="${isRoot ? 600 : 500}">${text}</text></g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="color:rgb(var(--nb-muted));font-family:system-ui,sans-serif">${edgesSvg}${nodesSvg}</svg>`;
}

function wrapLabel(label: string, maxChars: number): string[] {
  if (label.length <= maxChars) return [label];
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return c;
    }
  });
}
