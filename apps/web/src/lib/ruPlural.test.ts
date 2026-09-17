import { describe, expect, it } from 'vitest';
import { ruPlural } from './ruPlural';

describe('ruPlural', () => {
  it.each([
    [1, ''], // 1 источник
    [2, 'а'], // 2 источника
    [3, 'а'],
    [4, 'а'],
    [5, 'ов'], // 5 источников
    [10, 'ов'],
    [11, 'ов'], // special: 11-14 always "ов"
    [12, 'ов'],
    [14, 'ов'],
    [15, 'ов'],
    [21, ''], // 21 источник (last=1)
    [22, 'а'], // 22 источника (last=2, lastTwo=22 outside 11-14)
    [25, 'ов'],
    [101, ''],
    [111, 'ов'],
    [122, 'а'],
  ])('ruPlural(%i) === %s', (n, expected) => {
    expect(ruPlural(n)).toBe(expected);
  });

  it('handles 0 as "ов"', () => {
    expect(ruPlural(0)).toBe('ов');
  });
});