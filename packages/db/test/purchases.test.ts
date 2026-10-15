import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { PurchasesRepo } from '../src/repositories/purchases.ts';
import { UsersRepo } from '../src/repositories/users.ts';

const now = () => '2026-09-12T00:00:00.000Z';

describe('PurchasesRepo', () => {
  let repo: PurchasesRepo;
  beforeEach(() => { const db = openDb(':memory:'); migrate(db); repo = new PurchasesRepo(db, now); });

  it('marks a bought url and reports it', () => {
    repo.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1000, costRub: 90000, status: 'bought' });
    expect(repo.isBought('u')).toBe(true);
  });

  it('allows repeated failed attempts but not double bought', () => {
    repo.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1000, costRub: 90000, status: 'failed' });
    repo.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1000, costRub: 90000, status: 'failed' });
    expect(repo.isBought('u')).toBe(false);
    repo.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1000, costRub: 90000, status: 'bought' });
    expect(() => repo.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1000, costRub: 90000, status: 'bought' }))
      .toThrow();
  });

  it('lists a user\'s orders newest-first, scoped to that user', () => {
    repo.record({ telegramId: 1, mercariUrl: 'a', priceJpy: 1000, costRub: 90000, status: 'bought', runId: 'r1' });
    repo.record({ telegramId: 1, mercariUrl: 'b', priceJpy: 2000, costRub: 91000, status: 'failed' });
    repo.record({ telegramId: 2, mercariUrl: 'c', priceJpy: 3000, costRub: 92000, status: 'bought' });

    const orders = repo.listByUser(1, 10);
    expect(orders.map((o) => o.mercariUrl)).toEqual(['b', 'a']); // newest (higher id) first
    expect(orders[1]).toMatchObject({ mercariUrl: 'a', priceJpy: 1000, costRub: 90000, status: 'bought', runId: 'r1' });
    expect(repo.listByUser(2, 10).map((o) => o.mercariUrl)).toEqual(['c']);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++)
      repo.record({ telegramId: 1, mercariUrl: `u${i}`, priceJpy: 1, costRub: 1, status: 'failed' });
    expect(repo.listByUser(1, 3)).toHaveLength(3);
  });
});

describe('PurchasesRepo admin views', () => {
  let db: ReturnType<typeof openDb>;
  let purchases: PurchasesRepo;
  let users: UsersRepo;
  beforeEach(() => {
    db = openDb(':memory:'); migrate(db);
    purchases = new PurchasesRepo(db, now);
    users = new UsersRepo(db, now);
  });

  it('listAll returns every user\'s orders newest-first with username', () => {
    users.upsertOnStart(1, 'alice');
    users.upsertOnStart(2, 'bob');
    purchases.record({ telegramId: 1, mercariUrl: 'a', priceJpy: 1000, costRub: 90000, status: 'bought', runId: 'r1' });
    purchases.record({ telegramId: 2, mercariUrl: 'b', priceJpy: 2000, costRub: 91000, status: 'failed' });

    const all = purchases.listAll(10);
    expect(all.map((o) => o.mercariUrl)).toEqual(['b', 'a']); // newest (higher id) first
    expect(all[0]).toMatchObject({ telegramId: 2, username: 'bob', mercariUrl: 'b', status: 'failed' });
    expect(all[1]).toMatchObject({ telegramId: 1, username: 'alice', status: 'bought', runId: 'r1' });
  });

  it('listAll yields a null username for a purchase with no matching user', () => {
    purchases.record({ telegramId: 999, mercariUrl: 'x', priceJpy: 1, costRub: 1, status: 'failed' });
    expect(purchases.listAll(10)[0]).toMatchObject({ telegramId: 999, username: null });
  });

  it('listAll respects the limit', () => {
    for (let i = 0; i < 5; i++)
      purchases.record({ telegramId: 1, mercariUrl: `u${i}`, priceJpy: 1, costRub: 1, status: 'failed' });
    expect(purchases.listAll(3)).toHaveLength(3);
  });

  it('totalSpent sums only bought purchases (in kopecks)', () => {
    purchases.record({ telegramId: 1, mercariUrl: 'a', priceJpy: 1, costRub: 90000, status: 'bought' });
    purchases.record({ telegramId: 1, mercariUrl: 'b', priceJpy: 1, costRub: 50000, status: 'failed' });
    purchases.record({ telegramId: 2, mercariUrl: 'c', priceJpy: 1, costRub: 10000, status: 'bought' });
    expect(purchases.totalSpent()).toBe(100000);
  });

  it('totalSpent is 0 with no bought purchases', () => {
    expect(purchases.totalSpent()).toBe(0);
  });
});
