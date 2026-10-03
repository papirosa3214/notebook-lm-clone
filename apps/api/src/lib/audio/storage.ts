import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Resolve the directory for audio files. The layout is
 * `apps/api/data/audio/{notebookId}/{artifactId}.mp3` so a `rm -rf` on
 * the notebook's subdir is enough to clean up after a delete.
 *
 * The directory is created lazily on first write; tests that never
 * render audio never touch the filesystem.
 */
export function audioDir(notebookId: string): string {
  // config.DB_PATH defaults to ./data/notebook.db; the audio dir sits
  // next to it. We resolve against CWD (the apps/api directory in dev).
  return resolve(process.cwd(), 'data', 'audio', notebookId);
}

export function audioPath(notebookId: string, artifactId: string): string {
  return join(audioDir(notebookId), `${artifactId}.mp3`);
}

/** Ensure `apps/api/data/audio/{notebookId}` exists. */
export async function ensureAudioDir(notebookId: string): Promise<void> {
  await mkdir(audioDir(notebookId), { recursive: true });
}

/**
 * Persist bytes to the artifact's audio path. Returns the absolute path
 * (also encoded as just the basename for the API response).
 */
export async function writeAudio(
  notebookId: string,
  artifactId: string,
  bytes: Buffer | Uint8Array,
): Promise<{ path: string; filename: string; size: number }> {
  await ensureAudioDir(notebookId);
  const path = audioPath(notebookId, artifactId);
  await writeFile(path, bytes);
  const st = await stat(path);
  return { path, filename: `${artifactId}.mp3`, size: st.size };
}

/** Best-effort cleanup; never throws. */
export async function deleteAudio(notebookId: string, artifactId: string): Promise<void> {
  await rm(audioPath(notebookId, artifactId), { force: true }).catch(() => undefined);
}
