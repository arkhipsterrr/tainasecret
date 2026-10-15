import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { UsersRepo } from '../src/repositories/users.ts';
import { BalancesRepo } from '../src/repositories/balances.ts';
import { RefundRequestsRepo } from '../src/repositories/refund-requests.ts';
import { applyRefundDecision } from '../src/services/refunds.ts';

const now = () => '2026-09-12T00:00:00.000Z';

describe('applyRefundDecision', () => {
  let users: UsersRepo, balances: BalancesRepo, refunds: RefundRequestsRepo;
  const URL = 'https://jp.mercari.com/item/m1';

  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now);
    balances = new BalancesRepo(db, now);
    refunds = new RefundRequestsRepo(db, now);
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    balances.topup(1, 100000, 'seed');
    balances.hold(1, 69575, URL); // debit as a purchase would
  });

  it('approve claims the request and returns the held money exactly once', () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 69575, reason: 'threw' });
    const r = applyRefundDecision(refunds, balances, id, true);
    expect(r.outcome).toBe('approved');
    expect(users.get(1)!.balanceRub).toBe(100000); // fully restored
    expect(refunds.get(id)!.status).toBe('approved');

    // Second click / second admin: no-op, no double refund.
    const again = applyRefundDecision(refunds, balances, id, true);
    expect(again.outcome).toBe('already');
    expect(users.get(1)!.balanceRub).toBe(100000);
  });

  it('reject resolves the request and keeps the money debited', () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 69575, reason: 'threw' });
    const r = applyRefundDecision(refunds, balances, id, false);
    expect(r.outcome).toBe('rejected');
    expect(users.get(1)!.balanceRub).toBe(100000 - 69575); // unchanged
    expect(refunds.get(id)!.status).toBe('rejected');
  });

  it('returns not_found for an unknown request id', () => {
    expect(applyRefundDecision(refunds, balances, 9999, true).outcome).toBe('not_found');
  });
});

describe('RefundRequestsRepo.totalPending', () => {
  it('sums kopecks of pending requests only', () => {
    const db = openDb(':memory:'); migrate(db);
    const refunds = new RefundRequestsRepo(db, now);
    const a = refunds.create({ telegramId: 1, mercariUrl: 'a', kopecks: 5000, reason: 'threw' });
    refunds.create({ telegramId: 1, mercariUrl: 'b', kopecks: 3000, reason: 'error' });
    refunds.resolve(a, 'approved'); // no longer pending
    expect(refunds.totalPending()).toBe(3000);
  });
});
