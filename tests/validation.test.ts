import { describe, it, expect } from 'vitest';
import { normalizeMercariUrl } from '@arhip/core';

describe('normalizeMercariUrl', () => {
  it('accepts a canonical item url', () => {
    expect(normalizeMercariUrl('https://jp.mercari.com/item/m88297815004'))
      .toBe('https://jp.mercari.com/item/m88297815004');
  });

  it('strips query and trailing slash', () => {
    expect(normalizeMercariUrl('https://jp.mercari.com/item/m123/?ref=x'))
      .toBe('https://jp.mercari.com/item/m123');
  });

  it('accepts a locale-prefixed url and canonicalizes it', () => {
    expect(normalizeMercariUrl('https://jp.mercari.com/en/item/m59873895364'))
      .toBe('https://jp.mercari.com/item/m59873895364');
    expect(normalizeMercariUrl('https://jp.mercari.com/ja/item/m123/?ref=x'))
      .toBe('https://jp.mercari.com/item/m123');
  });

  it('rejects non-mercari hosts', () => {
    expect(() => normalizeMercariUrl('https://example.com/item/m1')).toThrow('invalid_mercari_url');
  });

  it('rejects non-item paths', () => {
    expect(() => normalizeMercariUrl('https://jp.mercari.com/search?x=1')).toThrow('invalid_mercari_url');
  });

  it('rejects garbage', () => {
    expect(() => normalizeMercariUrl('not a url')).toThrow('invalid_mercari_url');
  });
});
