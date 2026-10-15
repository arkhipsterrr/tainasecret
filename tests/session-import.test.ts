import { describe, it, expect } from 'vitest';
import { writeStorageState } from '@arhip/core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  return join(dir, 'nested', 'storageState.json');
}

const lgExpires = 1800000000; // fixed unix seconds

const goodCookies = [
  { name: 'ftkdoise4es3[lgstatus]', value: 'on', domain: '.j-subculture.com', path: '/', expires: lgExpires, httpOnly: false, secure: false, sameSite: 'lax' },
  { name: 'EtVer8RuyKL5', value: 'secret', domain: '.j-subculture.com', path: '/', expires: lgExpires, httpOnly: true, secure: true, sameSite: 'no_restriction' },
];

describe('writeStorageState', () => {
  it('writes a valid Playwright storageState and reports validity', async () => {
    const path = tmpPath();
    const res = await writeStorageState(goodCookies, path);
    expect(res.importedCookies).toBe(2);
    expect(res.authValidUntil).toBe(new Date(lgExpires * 1000).toISOString());

    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(state.origins).toEqual([]);
    expect(state.cookies).toHaveLength(2);
    const et = state.cookies.find((c: any) => c.name === 'EtVer8RuyKL5');
    expect(et.httpOnly).toBe(true);
    expect(et.sameSite).toBe('None'); // chrome "no_restriction" → Playwright "None"
  });

  it('normalizes sameSite and defaults path/expires', async () => {
    const path = tmpPath();
    await writeStorageState([{ name: 'a', value: 'b', domain: '.j-subculture.com' }], path);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(state.cookies[0].path).toBe('/');
    expect(state.cookies[0].expires).toBe(-1);
    expect(['Strict', 'Lax', 'None']).toContain(state.cookies[0].sameSite);
  });

  it('authValidUntil is null without a lgstatus cookie', async () => {
    const path = tmpPath();
    const res = await writeStorageState([{ name: 'x', value: 'y', domain: '.j-subculture.com', expires: lgExpires }], path);
    expect(res.authValidUntil).toBeNull();
  });

  it('rejects a non-array / empty / malformed payload', async () => {
    const path = tmpPath();
    await expect(writeStorageState('nope', path)).rejects.toThrow('invalid_cookies');
    await expect(writeStorageState([], path)).rejects.toThrow('invalid_cookies');
    await expect(writeStorageState([{ name: 'a' }], path)).rejects.toThrow('invalid_cookies');
  });
});
