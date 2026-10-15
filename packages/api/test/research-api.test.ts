import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.ts';

function deps(researchOverride: any) {
  return {
    session: { isAlive: async () => ({ loggedIn: true, username: null }), login: async () => {}, logout: async () => {} },
    client: { preview: async () => ({}), buy: async () => ({ status: 'error', finalUrl: '' }) },
    purchases: { isBought: () => false, record: () => {} },
    allowNoAuth: true,
    research: researchOverride,
  } as any;
}

describe('research routes', () => {
  it('GET /research/runs returns the list', async () => {
    const app = buildServer(deps({ recent: async () => [{ runId: '1-1', action: 'buy' }], getRun: async () => null }));
    const res = await app.inject({ method: 'GET', url: '/research/runs?limit=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].runId).toBe('1-1');
  });

  it('GET /research/runs/:runId → 404 when absent', async () => {
    const app = buildServer(deps({ recent: async () => [], getRun: async () => null }));
    const res = await app.inject({ method: 'GET', url: '/research/runs/1-1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('GET /research/runs/:runId → 200 with detail', async () => {
    const detail = { record: { runId: '1-1' }, html: '<h1>x</h1>', network: [] };
    const app = buildServer(deps({ recent: async () => [], getRun: async () => detail }));
    const res = await app.inject({ method: 'GET', url: '/research/runs/1-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain('x');
  });
});
