import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.ts';

function deps(overrides = {}) {
  return {
    session: { isAlive: async () => ({ loggedIn: true, username: null }), login: async () => {}, logout: async () => {} },
    client: {
      preview: async () => ({ title: 'X', priceJPY: 1, plans: [], balanceHint: null }),
      buy: async () => ({ status: 'insufficient_balance', finalUrl: 'u' }),
    },
    purchases: { isBought: () => false, record: () => {} },
    apiToken: 'secret',
    ...overrides,
  } as any;
}

describe('auth + frontend', () => {
  it('GET /health is open without a token', async () => {
    const app = buildServer(deps());
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('GET / serves the frontend html without a token', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('<html');
  });

  it('protected route without token → 401', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('protected route with a wrong token → 401', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/session', headers: { authorization: 'Bearer wrongo' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('protected route with valid token → 200', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/session', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().loggedIn).toBe(true);
  });

  it('no apiToken without allowNoAuth → buildServer throws (fail-closed)', () => {
    expect(() => buildServer(deps({ apiToken: null }))).toThrow(/API_TOKEN/);
  });

  it('no apiToken with explicit allowNoAuth → auth disabled (open)', async () => {
    const app = buildServer(deps({ apiToken: null, allowNoAuth: true }));
    expect((await app.inject({ method: 'GET', url: '/session' })).statusCode).toBe(200);
  });
});
