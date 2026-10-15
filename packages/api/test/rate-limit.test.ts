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
    allowNoAuth: true,
    ...overrides,
  } as any;
}

// The limiter keys on client IP, so requests must carry a remoteAddress to share a bucket.
const IP = '203.0.113.7';

describe('rate limiting', () => {
  it('returns 429 once the configured max is exceeded', async () => {
    const app = buildServer(deps({ rateLimit: { max: 3, timeWindow: '1 minute' } }));
    const hit = () => app.inject({ method: 'GET', url: '/health', remoteAddress: IP });
    for (let i = 0; i < 3; i++) expect((await hit()).statusCode).toBe(200);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
  });

  it('throttles before auth (unauthenticated floods are capped)', async () => {
    const app = buildServer(deps({ apiToken: 'secret', rateLimit: { max: 2, timeWindow: '1 minute' } }));
    const hit = () => app.inject({ method: 'GET', url: '/session', remoteAddress: IP }); // no token → 401
    expect((await hit()).statusCode).toBe(401);
    expect((await hit()).statusCode).toBe(401);
    expect((await hit()).statusCode).toBe(429);
  });

  it('can be disabled with rateLimit:false', async () => {
    const app = buildServer(deps({ rateLimit: false }));
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: IP })).statusCode).toBe(200);
    }
  });
});
