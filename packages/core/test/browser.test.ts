import { describe, it, expect, vi } from 'vitest';
import { shouldBlockResource, needsRebuild, formatTiming, parkedHit, timed } from '../src/session/browser.ts';

describe('shouldBlockResource', () => {
  it('blocks heavy visual-only resources we never read', () => {
    expect(shouldBlockResource('image')).toBe(true);
    expect(shouldBlockResource('media')).toBe(true);
    expect(shouldBlockResource('font')).toBe(true);
  });

  it('keeps everything the automation depends on', () => {
    // stylesheet is intentionally NOT blocked in the safe variant: cheap over
    // the tunnel and avoids any layout-dependent selector surprises.
    for (const t of ['document', 'script', 'xhr', 'fetch', 'stylesheet', 'other', 'websocket']) {
      expect(shouldBlockResource(t)).toBe(false);
    }
  });
});

describe('needsRebuild', () => {
  const fresh = { connected: true, hasContext: true, builtMtimeMs: 1000 };

  it('reuses a live context built from the current storage state', () => {
    expect(needsRebuild(fresh, 1000)).toBe(false);
  });

  it('rebuilds when the browser process is gone', () => {
    expect(needsRebuild({ ...fresh, connected: false }, 1000)).toBe(true);
  });

  it('rebuilds when there is no context yet', () => {
    expect(needsRebuild({ connected: false, hasContext: false, builtMtimeMs: null }, 1000)).toBe(true);
  });

  it('rebuilds when the storage state changed on disk (session re-imported)', () => {
    expect(needsRebuild(fresh, 2000)).toBe(true);
  });
});

describe('formatTiming', () => {
  it('renders a greppable, rounded one-liner', () => {
    expect(formatTiming('browser.launch', 1234.7)).toBe('timing browser.launch=1235ms');
  });
});

describe('timed', () => {
  it('logs a timing line and returns the value', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const v = await timed('preview', async () => 42);
      expect(v).toBe(42);
      expect(spy.mock.calls.some((c) => /^timing preview=\d+ms$/.test(String(c[0])))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs the timing even when the operation throws, and rethrows', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(timed('buy', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(spy.mock.calls.some((c) => /^timing buy=\d+ms$/.test(String(c[0])))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parkedHit', () => {
  const parked = { key: 'https://jp.mercari.com/item/m1', expiresAt: 1000 };

  it('hits a matching, unexpired parked page', () => {
    expect(parkedHit(parked, 'https://jp.mercari.com/item/m1', 999)).toBe(true);
  });

  it('misses when there is no parked page', () => {
    expect(parkedHit(null, 'https://jp.mercari.com/item/m1', 0)).toBe(false);
  });

  it('misses on a different url', () => {
    expect(parkedHit(parked, 'https://jp.mercari.com/item/m2', 999)).toBe(false);
  });

  it('misses when the parked page has expired', () => {
    expect(parkedHit(parked, 'https://jp.mercari.com/item/m1', 1000)).toBe(false);
    expect(parkedHit(parked, 'https://jp.mercari.com/item/m1', 1001)).toBe(false);
  });
});
