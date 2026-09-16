/**
 * Fetch the transcript of a YouTube video. youtube-transcript returns
 * segments with text + offset; we join them into timestamped paragraphs.
 */

export async function fetchYouTubeTranscript(urlOrId: string): Promise<{
  text: string;
  title: string;
}> {
  const { YoutubeTranscript } = (await import('youtube-transcript')) as unknown as {
    YoutubeTranscript: {
      fetchTranscript(videoId: string): Promise<Array<{ text: string; offset: number; duration: number }>>;
    };
  };
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw new Error(`could not extract YouTube video id from: ${urlOrId}`);
  }
  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  if (!segments?.length) {
    throw new Error('no transcript segments returned (video may not have captions)');
  }
  // Group segments into ~30s buckets so each chunk has a useful timestamp range.
  const groups = new Map<number, string[]>();
  for (const seg of segments) {
    const bucket = Math.floor(seg.offset / 30_000) * 30;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(seg.text);
  }
  const lines: string[] = [];
  for (const [sec, texts] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`[${formatTs(sec)}] ${texts.join(' ').replace(/\s+/g, ' ').trim()}`);
  }
  const text = lines.join('\n\n');
  const title = `YouTube ${videoId}`;
  return { text, title };
}

function extractVideoId(input: string): string | null {
  const patterns = [
    /(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
