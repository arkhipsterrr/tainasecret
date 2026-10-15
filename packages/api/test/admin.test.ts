import { describe, it, expect } from 'vitest';
import { openDb, migrate, UsersRepo, BalancesRepo, PurchasesRepo } from '@arhip/db';
import { buildServer } from '../src/server.ts';

const now = () => '2026-09-12T00:00:00.000Z';
const TOKEN = 'secret';
function build() {
  const db = openDb(':memory:'); migrate(db);
  const users = new UsersRepo(db, now); const balances = new BalancesRepo(db, now);
  const purchases = new PurchasesRepo(db, now);
  users.upsertOnStart(7, 'neo');
  const app = buildServer({
    session: { isAlive: async () => ({ loggedIn: true, username: null }), login: async () => {}, logout: async () => {} },
    client: { preview: async () => ({}) as any, buy: async () => ({}) as any },
    users, balances, purchases, apiToken: TOKEN,
  } as any);
  return { app, users, balances };
}
const auth = { authorization: `Bearer ${TOKEN}` };

describe('admin', () => {
  it('activates a user', async () => {
    const { app, users } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/users/7/activate', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(users.get(7)!.status).toBe('active');
  });

  it('tops up a user and returns balanceRub in kopecks', async () => {
    const { app, users } = build();
    // activate first so balance is readable
    await app.inject({ method: 'POST', url: '/admin/users/7/activate', headers: auth });
    const res = await app.inject({
      method: 'POST', url: '/admin/users/7/topup', headers: auth,
      payload: { amountRub: 500, note: 'card' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balanceRub).toBe(500_00);
  });

  it('rejects admin routes without the token', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(401);
  });

  // Fix 2: validation tests

  it('topup with a negative amount → 400 and balance unchanged', async () => {
    const { app, users } = build();
    await app.inject({ method: 'POST', url: '/admin/users/7/activate', headers: auth });
    const before = users.get(7)!.balanceRub;
    const res = await app.inject({
      method: 'POST', url: '/admin/users/7/topup', headers: auth,
      payload: { amountRub: -50, note: 'bad' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request' });
    expect(users.get(7)!.balanceRub).toBe(before);
  });

  it('topup with missing amountRub → 400', async () => {
    const { app, users } = build();
    const before = users.get(7)!.balanceRub;
    const res = await app.inject({
      method: 'POST', url: '/admin/users/7/topup', headers: auth,
      payload: { note: 'oops' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request' });
    expect(users.get(7)!.balanceRub).toBe(before);
  });

  it('topup with NaN amount → 400', async () => {
    const { app, users } = build();
    const before = users.get(7)!.balanceRub;
    const res = await app.inject({
      method: 'POST', url: '/admin/users/7/topup', headers: auth,
      payload: { amountRub: 'not-a-number', note: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request' });
    expect(users.get(7)!.balanceRub).toBe(before);
  });

  it('topup for a non-existent user id → 404', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/users/9999/topup', headers: auth,
      payload: { amountRub: 100 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});
