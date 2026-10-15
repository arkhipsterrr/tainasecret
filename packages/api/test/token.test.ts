import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiToken, fileTokenStore } from '../src/token.ts';

function fakeStore(initial: string | null = null) {
  let val = initial;
  return {
    read: () => val,
    write: (t: string) => { val = t; },
    get value() { return val; },
  };
}

describe('resolveApiToken', () => {
  it('uses the env token when set, without touching the store or generator', () => {
    const store = fakeStore(null);
    let genCalled = false;
    const res = resolveApiToken('env-secret', store, () => { genCalled = true; return 'x'; });
    expect(res).toEqual({ token: 'env-secret', source: 'env' });
    expect(store.value).toBe(null);
    expect(genCalled).toBe(false);
  });

  it('reuses a persisted token from the store when no env token', () => {
    const store = fakeStore('persisted-token');
    let genCalled = false;
    const res = resolveApiToken(null, store, () => { genCalled = true; return 'x'; });
    expect(res).toEqual({ token: 'persisted-token', source: 'file' });
    expect(genCalled).toBe(false);
  });

  it('generates AND persists a token when neither env nor store has one', () => {
    const store = fakeStore(null);
    const res = resolveApiToken(null, store, () => 'generated-xyz');
    expect(res).toEqual({ token: 'generated-xyz', source: 'generated' });
    expect(store.value).toBe('generated-xyz');
  });

  it('treats an empty-string env token as unset (falls through to generate)', () => {
    const store = fakeStore(null);
    const res = resolveApiToken('', store, () => 'gen');
    expect(res.source).toBe('generated');
  });
});

describe('fileTokenStore', () => {
  it('persists a written token to disk and reads it back, creating the dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arhip-tok-'));
    try {
      const path = join(dir, 'nested', 'api-token');
      const store = fileTokenStore(path);
      expect(store.read()).toBe(null); // absent → null, not a throw
      store.write('secret-abc');
      expect(store.read()).toBe('secret-abc');
      expect(readFileSync(path, 'utf8').trim()).toBe('secret-abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
