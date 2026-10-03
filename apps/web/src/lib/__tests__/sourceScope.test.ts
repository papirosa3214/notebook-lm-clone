import { describe, expect, it } from 'vitest';
import { isSourceInScope, scopeToSourceIds } from '../useSourceScope';

const readyIds = ['source-a', 'source-b'];

describe('source scope display semantics', () => {
  it('renders every ready source as selected when persisted scope is empty', () => {
    expect(scopeToSourceIds([], readyIds)).toBeUndefined();
    expect(isSourceInScope('source-a', [], readyIds)).toBe(true);
    expect(isSourceInScope('source-b', [], readyIds)).toBe(true);
  });

  it('renders only explicitly selected sources when the scope is narrowed', () => {
    expect(scopeToSourceIds(['source-a'], readyIds)).toEqual(['source-a']);
    expect(isSourceInScope('source-a', ['source-a'], readyIds)).toBe(true);
    expect(isSourceInScope('source-b', ['source-a'], readyIds)).toBe(false);
  });

  it('renders all sources as selected when every ready source is explicitly selected', () => {
    expect(scopeToSourceIds(readyIds, readyIds)).toBeUndefined();
    expect(isSourceInScope('source-a', readyIds, readyIds)).toBe(true);
    expect(isSourceInScope('source-b', readyIds, readyIds)).toBe(true);
  });
});
