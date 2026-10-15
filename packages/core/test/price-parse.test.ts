import { describe, it, expect } from 'vitest';
import { parseJpyDigits } from '@arhip/core';

describe('parseJpyDigits', () => {
  it('parses a comma-grouped amount with a JPY suffix', () => {
    expect(parseJpyDigits('2,600 JPY')).toBe(2600);
  });
  it('parses a ¥-prefixed amount', () => {
    expect(parseJpyDigits('¥73,500')).toBe(73500);
  });
  it('returns null for empty / non-numeric text', () => {
    expect(parseJpyDigits('')).toBeNull();
    expect(parseJpyDigits('  ')).toBeNull();
    expect(parseJpyDigits('JPY')).toBeNull();
  });
});
