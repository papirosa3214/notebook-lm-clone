import { describe, expect, it } from 'vitest';
import {
  ChatDeltaSchema,
  IngestProgressDeltaSchema,
  SummaryDeltaSchema,
} from '../index.js';

describe('ChatDeltaSchema', () => {
  it('parses a citations delta', () => {
    expect(
      ChatDeltaSchema.safeParse({
        type: 'citations',
        chunks: [
          {
            id: 'c1',
            sourceId: 's1',
            sourceTitle: 't',
            sourceKind: 'url',
            text: 'x',
            score: 0.42,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('parses a token delta', () => {
    expect(ChatDeltaSchema.safeParse({ type: 'token', text: 'hi' }).success).toBe(true);
  });

  it('parses a done delta with messageId', () => {
    expect(ChatDeltaSchema.safeParse({ type: 'done', messageId: 'm1' }).success).toBe(true);
  });

  it('parses an error delta', () => {
    expect(ChatDeltaSchema.safeParse({ type: 'error', message: 'boom' }).success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(ChatDeltaSchema.safeParse({ type: 'wat' }).success).toBe(false);
  });
});

describe('SummaryDeltaSchema', () => {
  it('parses citations / token / done(summaryId) / error', () => {
    expect(
      SummaryDeltaSchema.safeParse({ type: 'citations', chunks: [] }).success,
    ).toBe(true);
    expect(SummaryDeltaSchema.safeParse({ type: 'token', text: 'x' }).success).toBe(true);
    expect(SummaryDeltaSchema.safeParse({ type: 'done', summaryId: 's1' }).success).toBe(true);
    expect(SummaryDeltaSchema.safeParse({ type: 'error', message: 'x' }).success).toBe(true);
  });
});

describe('IngestProgressDeltaSchema', () => {
  it('parses a progress delta with each stage', () => {
    for (const stage of ['fetching', 'extracting', 'chunking', 'embedding', 'storing']) {
      const r = IngestProgressDeltaSchema.safeParse({
        type: 'progress',
        stage,
        ratio: 0.5,
        message: 'm',
        sourceId: 's1',
      });
      expect(r.success, `stage ${stage}`).toBe(true);
    }
  });

  it('parses a progress delta with no optional fields', () => {
    expect(
      IngestProgressDeltaSchema.safeParse({ type: 'progress', stage: 'fetching' }).success,
    ).toBe(true);
  });

  it('parses done without a source (batch endpoint contract)', () => {
    // /search-add-batch sends {added: [...]} but historically the schema
    // required SourceSchema, silently dropping the delta in makeIngestEmitter.
    // The contract must allow done without source at all.
    expect(IngestProgressDeltaSchema.safeParse({ type: 'done' }).success).toBe(true);
  });

  it('parses done with a batch payload source', () => {
    expect(
      IngestProgressDeltaSchema.safeParse({
        type: 'done',
        source: { added: [{ id: 's1', title: 't', url: 'u', status: 'ready' }] },
      }).success,
    ).toBe(true);
  });

  it('parses done with a full Source row source', () => {
    expect(
      IngestProgressDeltaSchema.safeParse({
        type: 'done',
        source: {
          id: 's1',
          notebookId: 'n1',
          kind: 'url',
          title: 't',
          url: 'u',
          status: 'ready',
          createdAt: '2026-01-01T00:00:00Z',
        },
      }).success,
    ).toBe(true);
  });

  it('parses an error delta', () => {
    expect(
      IngestProgressDeltaSchema.safeParse({ type: 'error', message: 'fetch failed' }).success,
    ).toBe(true);
  });
});
