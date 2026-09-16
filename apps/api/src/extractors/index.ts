/**
 * Extract text from various file formats. All return markdown-ish text
 * (plain paragraphs separated by blank lines) — Ragflow's naive splitter
 * works best on flat text, so we keep it simple here.
 */

const PDF_PARSE_TIMEOUT_MS = 30_000;

export async function extractPdf(buffer: Buffer): Promise<string> {
  // pdf-parse has no built-in timeout; race against a reject timer
  const pdfParse = (await import('pdf-parse')) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const work = pdfParse.default(buffer);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('pdf-parse timeout')), PDF_PARSE_TIMEOUT_MS),
  );
  const { text } = await Promise.race([work, timer]);
  return normalizeText(text);
}

export async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const { value } = await mammoth.extractRawText({ buffer });
  return normalizeText(value);
}

export async function extractPlainText(buffer: Buffer): Promise<string> {
  return normalizeText(buffer.toString('utf-8'));
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')         // trailing spaces
    .replace(/\n{3,}/g, '\n\n')          // collapse blank lines
    .replace(/[ \t]{2,}/g, ' ')          // collapse runs of spaces
    .trim();
}
