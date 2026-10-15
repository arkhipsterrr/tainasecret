import { describe, it, expect } from 'vitest';
import { costKopecks, formatRub } from '../src/pricing.ts';

const cfg = { rubPerJpy: 0.55, markup: 0.10, planFeeJpy: 150 };

describe('pricing', () => {
  it('computes integer kopecks with fee and markup', () => {
    // (1000 + 150) * 0.55 * 1.10 = 695.75 RUB = 69575 kopecks
    expect(costKopecks(1000, cfg)).toBe(69575);
  });
  it('rounds to nearest kopeck', () => {
    // (100 + 150) * 0.55 * 1.10 = 151.25 -> 15125
    expect(costKopecks(100, cfg)).toBe(15125);
  });
  it('formats kopecks as RUB', () => {
    expect(formatRub(69575)).toBe('695,75 ₽');
  });
});
