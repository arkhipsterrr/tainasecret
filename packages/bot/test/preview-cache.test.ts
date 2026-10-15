import { describe, it, expect } from 'vitest';
import { PreviewCache } from '../src/preview-cache.ts';

describe('PreviewCache', () => {
  it('stores and takes a preview once, scoped to the user', () => {
    let t = 0; const cache = new PreviewCache(60_000, () => t);
    const id = cache.put(1, { url: 'u', title: 'T', priceJpy: 1000 });
    expect(cache.take(2, id)).toBeNull();          // wrong user
    expect(cache.take(1, id)!.title).toBe('T');    // right user
    expect(cache.take(1, id)).toBeNull();          // single-use
  });

  it('expires after the TTL', () => {
    let t = 0; const cache = new PreviewCache(1000, () => t);
    const id = cache.put(1, { url: 'u', title: 'T', priceJpy: 1 });
    t = 2000;
    expect(cache.take(1, id)).toBeNull();
  });

  it('sweep() evicts expired entries and reports the count', () => {
    let t = 0; const cache = new PreviewCache(1000, () => t);
    cache.put(1, { url: 'a', title: 'A', priceJpy: 1 });
    cache.put(1, { url: 'b', title: 'B', priceJpy: 1 });
    t = 500;
    const fresh = cache.put(2, { url: 'c', title: 'C', priceJpy: 1 }); // newer entry
    t = 1200; // first two expired, third still fresh (1200-500 < 1000)
    expect(cache.sweep()).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.take(2, fresh)!.title).toBe('C');
  });
});
