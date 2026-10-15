import { describe, it, expect } from 'vitest';
import { readPageSignals } from '../src/jsub/netlog.ts';

// Fake Playwright page: title() plus an evaluate() that runs the passed fn
// against a tiny fake DOM built from the given alert texts.
function fakePage(o: { title: string; alerts?: string[]; throwOn?: 'title' | 'evaluate' }) {
  return {
    async title() {
      if (o.throwOn === 'title') throw new Error('detached');
      return o.title;
    },
    async evaluate<T>(fn: (sel: string) => T, sel: string): Promise<T> {
      if (o.throwOn === 'evaluate') throw new Error('detached');
      const nodes = (o.alerts ?? []).map((t) => ({ textContent: t }));
      const doc = { querySelectorAll: () => nodes };
      (globalThis as any).document = doc;
      try {
        return fn(sel);
      } finally {
        delete (globalThis as any).document;
      }
    },
  };
}

describe('readPageSignals', () => {
  it('returns the page title and joined alert text', async () => {
    const s = await readPageSignals(fakePage({ title: 'Order error', alerts: ['Payment failed', 'Try again'] }));
    expect(s.title).toBe('Order error');
    expect(s.alert).toBe('Payment failed | Try again');
  });

  it('returns a null alert when the page has no alert elements', async () => {
    const s = await readPageSignals(fakePage({ title: 'ok', alerts: [] }));
    expect(s.alert).toBeNull();
  });

  it('degrades to empty values instead of throwing when the page is gone', async () => {
    const s = await readPageSignals(fakePage({ title: 'x', throwOn: 'title' }));
    expect(s.title).toBe('');
    expect(s.alert).toBeNull();
  });
});
