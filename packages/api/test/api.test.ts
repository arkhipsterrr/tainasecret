import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.ts';

function deps(overrides = {}) {
  return {
    session: {
      isAlive: async () => ({ loggedIn: true, username: 'dummy' }),
      login: async () => {},
      logout: async () => {},
    },
    client: {
      preview: async () => ({ title: 'X', priceJPY: 1000, plans: [{ value: '1', label: 'Plan A' }], balanceHint: null }),
      buy: async () => ({ status: 'insufficient_balance', finalUrl: 'https://x/deposits/choose/' }),
    },
    purchases: {
      isBought: () => false,
      record: () => {},
    },
    allowNoAuth: true,
    ...overrides,
  } as any;
}

describe('api', () => {
  it('GET /health', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /item/buy rejects invalid url', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'POST', url: '/item/buy', payload: { url: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_mercari_url' });
  });

  it('POST /item/buy blocks a duplicate', async () => {
    const app = buildServer(deps({ purchases: { isBought: () => true, record: () => {} } }));
    const res = await app.inject({ method: 'POST', url: '/item/buy', payload: { url: 'https://jp.mercari.com/item/m1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_bought' });
  });

  it('POST /item/buy returns status on success path', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'POST', url: '/item/buy', payload: { url: 'https://jp.mercari.com/item/m1' } });
    expect(res.json().status).toBe('insufficient_balance');
  });
});
