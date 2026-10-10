/**
 * MacSayTtsProvider unit tests.
 *
 * The provider depends on `child_process.spawn` for `say` and
 * `ffmpeg`, plus the filesystem for tmpdir + final mp3. Tests
 * inject a fake `spawn` so we can assert on the exact arguments
 * without shelling out, and we simulate the ffmpeg concat side-
 * effect (writing the output file) by writing it from the
 * fakeSpawn implementation.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MacSayTtsProvider, type SpawnFn } from '../macSayTts.js';

interface FakeProc {
  stderr: { on: (e: 'data', cb: (b: Buffer) => void) => void };
  on: (e: string, cb: (arg: unknown) => void) => void;
  kill: () => void;
}

/** Minimal EventEmitter-shaped child. We attach the `'data'` listener
 *  without emitting anything (no real stderr traffic in tests) and
 *  attach the `'close'` listener that fires synchronously. */
function fakeProc(exitCode: number): FakeProc {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const proc = {
    stderr: {
      on(_e: 'data', _cb: (b: Buffer) => void) {
        // no-op
      },
    },
    on(e: string, cb: (arg: unknown) => void) {
      (handlers[e] ??= []).push(cb);
      if (e === 'close') {
        // Fire synchronously so the provider's Promise resolves
        // on the same microtask. Real spawns would be async, but
        // the contract is the same.
        cb(exitCode);
      }
    },
    kill: () => undefined,
  };
  return proc as unknown as FakeProc;
}

/** A spawn factory that:
 *  - records every invocation into `calls`
 *  - on every call writes a small placeholder to outputPath so the
 *    provider's final `stat(outputPath)` succeeds. The provider
 *    doesn't decode the bytes, so the contents don't matter. */
function recordingSpawn(
  outputPath: string,
  calls: Array<{ cmd: string; args: string[] }>,
): SpawnFn {
  return (cmd, args) => {
    calls.push({ cmd, args });
    // Fire-and-forget write; the next microtask sees the file. The
    // provider's `await stat()` is awaited after the for-loop
    // completes, and a few microticks of the event loop are enough
    // for this fire-and-forget write to land.
    writeFile(outputPath, Buffer.from('ID3_FAKE_MP3_FOR_TESTS')).catch(() => undefined);
    return fakeProc(0) as never;
  };
}

describe('MacSayTtsProvider', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'macsay-test-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('throws on empty lines', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const provider = new MacSayTtsProvider({ spawn: recordingSpawn('/dev/null', calls) });
    await expect(
      provider.synthesize({ lines: [], outputPath: join(tmpRoot, 'out.mp3') }),
    ).rejects.toThrow(/empty lines/);
  });

  it('spawns `say` for SCRIPT/MIRA and ffmpeg anullsrc for STAGE', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const outPath = join(tmpRoot, 'out.mp3');
    const provider = new MacSayTtsProvider({ spawn: recordingSpawn(outPath, calls) });

    await provider.synthesize({
      lines: [
        { speaker: 'SCRIPT', text: 'Привет' },
        { speaker: 'STAGE', text: 'Пауза' },
        { speaker: 'MIRA', text: 'И тебе' },
        { speaker: 'SCRIPT', text: 'Поехали' },
      ],
      outputPath: outPath,
    });

    const sayCalls = calls.filter((c) => c.cmd === '/usr/bin/say');
    const ffmpegCalls = calls.filter((c) => c.cmd === 'ffmpeg');

    // 3 SCRIPT/MIRA lines → 3 `say` calls (STAGE is silence).
    expect(sayCalls).toHaveLength(3);
    // ffmpeg calls: 3 aiff→mp3 (one per non-STAGE line) + 1 silence
    // + 1 final concat = 5.
    expect(ffmpegCalls).toHaveLength(5);

    // Voice for SCRIPT and MIRA defaults to Milena.
    for (const call of sayCalls) {
      expect(call.args[0]).toBe('-v');
      expect(call.args[1]).toBe('Milena');
      expect(call.args[2]).toBe('-o');
      expect(call.args[3]).toMatch(/\.aiff$/);
    }

    // The STAGE anullsrc invocation.
    const stageCall = ffmpegCalls.find(
      (c) => c.args.includes('-f') && c.args.includes('lavfi'),
    );
    expect(stageCall).toBeDefined();
    const i = stageCall!.args.indexOf('-i');
    expect(stageCall!.args[i + 1]).toMatch(/anullsrc/);
    const tIdx = stageCall!.args.indexOf('-t');
    expect(stageCall!.args[tIdx + 1]).toBe('0.8');

    // Final concat invocation.
    const concatCall = ffmpegCalls.find(
      (c) => c.args.includes('-c') && c.args.includes('copy'),
    );
    expect(concatCall).toBeDefined();
    expect(concatCall!.args).toContain('-f');
    expect(concatCall!.args).toContain('concat');

    // Final mp3 was written.
    const st = await stat(outPath);
    expect(st.size).toBeGreaterThan(0);
  });

  it('honours the per-speaker voice override from req.voices', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const provider = new MacSayTtsProvider({
      spawn: recordingSpawn(join(tmpRoot, 'out.mp3'), calls),
    });
    await provider.synthesize({
      lines: [
        { speaker: 'SCRIPT', text: 'a' },
        { speaker: 'MIRA', text: 'b' },
      ],
      voices: { SCRIPT: 'Albert', MIRA: 'Yuri' },
      outputPath: join(tmpRoot, 'out.mp3'),
    });
    const sayCalls = calls.filter((c) => c.cmd === '/usr/bin/say');
    expect(sayCalls[0]!.args[1]).toBe('Albert');
    expect(sayCalls[1]!.args[1]).toBe('Yuri');
  });

  it('propagates `say` non-zero exit as a thrown error', async () => {
    const failingSpawn: SpawnFn = () => fakeProc(1) as never;
    const provider = new MacSayTtsProvider({ spawn: failingSpawn });
    await expect(
      provider.synthesize({
        lines: [{ speaker: 'SCRIPT', text: 'oops' }],
        outputPath: join(tmpRoot, 'out.mp3'),
      }),
    ).rejects.toThrow(/say exited 1/);
  });

  it('propagates ffmpeg non-zero exit as a thrown error', async () => {
    let i = 0;
    const mixedSpawn: SpawnFn = (() => {
      i++;
      // First call (say) succeeds, second (ffmpeg aiff→mp3) fails.
      return fakeProc(i === 2 ? 2 : 0) as never;
    });
    const provider = new MacSayTtsProvider({ spawn: mixedSpawn });
    await expect(
      provider.synthesize({
        lines: [{ speaker: 'SCRIPT', text: 'q' }],
        outputPath: join(tmpRoot, 'out.mp3'),
      }),
    ).rejects.toThrow(/ffmpeg exited 2/);
  });
});
