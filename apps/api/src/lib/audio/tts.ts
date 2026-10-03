/**
 * TTS (text-to-speech) provider interface.
 *
 * The Audio Overview flow is split in two: a script-generator (LLM) and
 * a TTS-renderer (audio). This file is the latter. We keep the contract
 * small so we can swap implementations — `NoopTtsProvider` (script-only,
 * status="ready" without an actual mp3), `OpenAiTtsProvider` (cloud),
 * `MacSayTtsProvider` (dev fallback on macOS), and eventually a local
 * kokoro-fastapi / XTTS / piper server.
 *
 * Output: an mp3 file on disk, owned by the route. The route is
 * responsible for cleanup on failure.
 */
export interface TtsRequest {
  /** Lines to render in order. STAGE lines are skipped (they are
   *  stage directions, not spoken text). */
  lines: Array<{ speaker: 'SCRIPT' | 'MIRA' | 'STAGE'; text: string }>;
  /** Output path; the provider writes the mp3 here. */
  outputPath: string;
  /** Optional per-line voice map: speaker → voice id. */
  voices?: Partial<Record<'SCRIPT' | 'MIRA', string>>;
  /** Locale hint, BCP-47 ("ru", "en-US", …). */
  language?: string;
}

export interface TtsResult {
  /** Seconds of audio produced. */
  durationSec: number;
  /** Bytes written to outputPath. */
  bytes: number;
}

export interface TtsProvider {
  readonly id: string;
  /**
   * Render `req.lines` into `req.outputPath`. Implementations may use
   * the fastest available strategy (parallel calls per speaker, then
   * `ffmpeg amix` for the dialogue — see OpenAiTtsProvider for the
   * reference shape).
   *
   * Throws on transport / render / ffmpeg failure. The route catches
   * and marks the artifact as `status='failed'`.
   */
  synthesize(req: TtsRequest): Promise<TtsResult>;
}
