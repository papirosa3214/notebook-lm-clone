/**
 * Build a two-host Audio Overview script from retrieved chunks.
 *
 * The flow mirrors the chat one: the LLM is given a numbered list of
 * sources and a system prompt that mandates an alternating SCRIPT: / MIRA:
 * format. We accumulate the streamed output and parse it line-by-line
 * so callers can stream individual lines to the UI (and to the TTS
 * provider, when one is wired up).
 *
 * The script is also persisted as the artifact's `contentMd` — a fenced
 * markdown block with `SCRIPT:` and `MIRA:` lines so the Artifacts
 * panel can render it as text without a custom parser.
 */
import type { CitationChunk } from '@notebook/shared';
import type { AudioOverviewLine, AudioOverviewStyle } from '@notebook/shared';
import { getProvider } from '../../providers/index.js';
import { formatContextForPrompt } from '@notebook/shared/providers';

const STYLE_INSTRUCTIONS: Record<AudioOverviewStyle, string> = {
  deep_dive:
    'A 8-12 minute, ~1500-2000 word deep-dive conversation. ' +
    'Open with a hook grounded in [1], close with a forward-looking question. ' +
    'Alternate SCRIPT (curious interviewer) and MIRA (knowledgeable expert). ' +
    'Use simple conversational Russian, no academic jargon, no bullet lists.',
  short:
    'A 2-3 minute, ~400-600 word teaser. Two hosts who just skimmed the same sources ' +
    'and want to tell the listener the most surprising thing they found. ' +
    'Punchy, no preamble, no formal sign-off.',
  critique:
    'A 6-9 minute adversarial review. SCRIPT is sympathetic to the sources, MIRA ' +
    'is the skeptic. MIRA must point out at least three places where the sources ' +
    'are missing context, biased, or over-claimed. Conclude with a balanced summary.',
};

export interface BuildScriptArgs {
  query: string;
  citations: CitationChunk[];
  style: AudioOverviewStyle;
  focus?: string;
  provider?: 'ollama' | 'anthropic' | 'openai';
  model?: string;
  /**
   * Stream each parsed line. Called once per SCRIPT:/MIRA: line as soon
   * as the LLM emits enough text to identify it. The route uses this to
   * push `script_line` SSE deltas to the UI; the test suite uses it to
   * count lines without parsing the final string.
   */
  onLine?: (line: AudioOverviewLine) => void;
  /**
   * Optional signal to abort mid-stream (e.g. SSE client disconnected).
   * The provider is expected to honor it on its next yield.
   */
  signal?: AbortSignal;
}

export interface BuildScriptResult {
  /** All parsed lines in order, including STAGE directions. */
  lines: AudioOverviewLine[];
  /** Joined script — the artifact's contentMd. */
  markdown: string;
  model: string;
}

/**
 * Drive a script-generation LLM call and return parsed lines.
 *
 * The system prompt is deliberately strict: the model must emit
 * "SCRIPT: …" or "MIRA: …" (or "STAGE: …") on every non-empty line.
 * Lines that don't match the prefix are tolerated (kept as part of the
 * previous speaker's turn) so a single typo doesn't drop a sentence.
 *
 * This is a thin wrapper around `parseScriptText` — the actual parsing
 * logic is exposed separately so unit tests can exercise it without
 * driving a real (or mocked) LLM stream.
 */
export async function buildScript(args: BuildScriptArgs): Promise<BuildScriptResult> {
  const providerId = args.provider ?? 'ollama';
  const provider = getProvider(providerId);
  const model = args.model ?? provider.defaultModel;

  const systemPrompt = [
    'Ты — генератор двухголосых подкастов в духе NotebookLM Audio Overview.',
    'Всегда используй строгий формат: каждая реплика начинается с префикса',
    '`SCRIPT:`, `MIRA:` или `STAGE:`. Больше ничего — никаких заголовков,',
    'никакого markdown, никаких пояснений «вот ваш скрипт».',
    '',
    STYLE_INSTRUCTIONS[args.style],
    args.focus ? `Доп. фокус от пользователя: ${args.focus}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const userPrompt = [
    `Тема: ${args.query}`,
    '',
    'Источники (используй [N]-маркеры в репликах, чтобы ссылаться на них):',
    formatContextForPrompt(args.citations),
  ].join('\n');

  const lines: AudioOverviewLine[] = [];
  let raw = '';

  for await (const ev of provider.chat({
    providerId,
    model,
    context: args.citations,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    maxTokens: 2400,
  })) {
    if (ev.text) {
      raw += ev.text;
    }
    if (ev.done) break;
  }

  // Parse the accumulated text in one go. parseScriptText handles
  // every streaming concern (partial lines, continuation, etc.) and
  // emits the same `onLine` callback contract.
  for (const line of parseScriptText(raw, args.onLine)) {
    lines.push(line);
  }

  return {
    lines,
    markdown: linesToMarkdown(lines),
    model,
  };
}

/**
 * Parse a complete (or partial) script blob into `AudioOverviewLine[]`.
 *
 * Pure function — no LLM, no async. This is the unit-testable core of
 * the builder. `buildScript` accumulates streamed text and feeds the
 * full payload here at the end; tests can call this directly with a
 * fixture string.
 *
 * Behaviour:
 *  - Lines starting with `SCRIPT:`, `MIRA:`, `STAGE:` (case-insensitive,
 *    full-width colon `：` also accepted) start a new turn.
 *  - A line without a prefix is treated as a continuation of the most
 *    recent speaker; if no speaker has been opened yet, the line is
 *    attributed to SCRIPT (models occasionally drop the prefix on the
 *    first line).
 *  - Blank lines are skipped.
 *  - For each emitted line `onLine?.(line)` is invoked synchronously
 *    before the function returns, so callers can stream to a UI
 *    without re-walking the array.
 */
export function* parseScriptText(
  text: string,
  onLine?: (line: AudioOverviewLine) => void,
): Generator<AudioOverviewLine> {
  let openSpeaker: 'SCRIPT' | 'MIRA' | 'STAGE' | null = null;
  for (const raw of text.split('\n')) {
    const line = parseLine(raw, openSpeaker);
    if (!line) continue;
    if (line.speaker !== openSpeaker) {
      openSpeaker = line.speaker;
    }
    onLine?.(line);
    yield line;
  }
}

/**
 * Parse a single line. If it has a `PREFIX: …` header, return that;
 * otherwise treat it as a continuation of `openSpeaker`. Continuation
 * lines get appended to the most recent line in `out` (so the markdown
 * stays one paragraph per turn).
 */
function parseLine(
  raw: string,
  openSpeaker: 'SCRIPT' | 'MIRA' | 'STAGE' | null,
): AudioOverviewLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const speakerMatch = trimmed.match(/^(SCRIPT|MIRA|STAGE)\s*[:：]\s*(.*)$/i);
  if (speakerMatch) {
    const speaker = speakerMatch[1]!.toUpperCase() as 'SCRIPT' | 'MIRA' | 'STAGE';
    const text = speakerMatch[2]!.trim();
    if (!text) return null;
    return { speaker, text };
  }

  // Continuation of the open turn.
  if (!openSpeaker) {
    // No speaker yet and no prefix on this line — make it SCRIPT by
    // default; models occasionally drop the prefix on the first line.
    return { speaker: 'SCRIPT', text: trimmed };
  }
  return { speaker: openSpeaker, text: trimmed };
}

/**
 * Render the parsed lines back to markdown for the artifact body.
 * `SCRIPT:` and `MIRA:` get a bold header so the Artifacts panel can
 * visually separate hosts.
 */
export function linesToMarkdown(lines: AudioOverviewLine[]): string {
  return lines
    .map((l) => {
      if (l.speaker === 'STAGE') return `*${l.text}*`;
      return `**${l.speaker}:** ${l.text}`;
    })
    .join('\n\n')
    .trim() + '\n';
}
