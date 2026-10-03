/**
 * Common JSON-array parser used by the studio templates (flashcards,
 * data_table) and the suggestions endpoint. Tolerant of:
 *  - a leading prose paragraph (we extract the first '[' to last ']')
 *  - ```json fences
 *  - // line comments and BOM
 *  - trailing junk after the array
 *  - non-string array elements (filtered out, except suggestions which
 *    keep the raw strings)
 *
 * Returns at most `limit` items. Items beyond the limit are dropped.
 * Empty array if no parseable JSON array is found.
 */
export function parseJsonArray(raw: string, limit = Infinity): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const candidates: string[] = [trimmed];

  // Fenced JSON
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) candidates.push(fence[1] ?? '');

  // First '[' to last ']' slice — the typical wrapping case
  // ("Вот ваши карточки: [...] Удачи!").
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    const arr = tryParseArray(candidate);
    if (arr.length > 0) {
      return arr.slice(0, limit === Infinity ? arr.length : limit);
    }
  }
  return [];
}

function tryParseArray(raw: string): unknown[] {
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trimEnd())
    .filter((l) => l.length > 0)
    .join('\n');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
}
