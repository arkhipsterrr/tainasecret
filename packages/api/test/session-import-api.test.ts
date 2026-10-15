import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.ts';

function deps(importSession?: any) {
  return {
    session: { isAlive: async () => ({ loggedIn: true, username: null }), login: async () => {}, logout: async () => {} },
    client: { preview: async () => ({}), buy: async () => ({ status: 'error', finalUrl: '' }) },
    purchases: { isBought: () => false, record: () => {} },
    allowNoAuth: true,
    importSession,
  } as any;
}

describe('POST /session/import', () => {
  it('imports cookies and returns the summary', async () => {
    const app = buildServer(deps(async (cookies: unknown[]) => ({ importedCookies: cookies.length, authValidUntil: '2026-10-12T00:00:00.000Z' })));
    const res = await app.inject({
      method: 'POST', url: '/session/import',
      payload: { cookies: [{ name: 'a', value: 'b', domain: '.j-subculture.com' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ importedCookies: 1, authValidUntil: '2026-10-12T00:00:00.000Z' });
  });

  it('rejects an empty/missing cookie list', async () => {
    const app = buildServer(deps(async () => ({ importedCookies: 0, authValidUntil: null })));
    const res = await app.inject({ method: 'POST', url: '/session/import', payload: { cookies: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 501 when import is not wired', async () => {
    const app = buildServer(deps(undefined));
    const res = await app.inject({ method: 'POST', url: '/session/import', payload: { cookies: [{ name: 'a', value: 'b', domain: 'd' }] } });
    expect(res.statusCode).toBe(501);
  });
});
