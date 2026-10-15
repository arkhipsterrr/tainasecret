import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { UsersRepo } from '../src/repositories/users.ts';
import { BalancesRepo } from '../src/repositories/balances.ts';
import { PurchasesRepo } from '../src/repositories/purchases.ts';
import { RefundRequestsRepo } from '../src/repositories/refund-requests.ts';

const now = () => '2026-09-12T00:00:00.000Z';

describe('BalancesRepo', () => {
  let users: UsersRepo; let bal: BalancesRepo;
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); bal = new BalancesRepo(db, now);
    users.upsertOnStart(1, 'u');
  });

  it('refuses hold for a pending user', () => {
    users.setStatus(1, 'pending');
    bal.topup(1, 100_00, 'seed');
    expect(bal.hold(1, 50_00, 'url')).toEqual({ ok: false, reason: 'not_active' });
    expect(users.get(1)!.balanceRub).toBe(100_00);
  });

  it('refuses hold when insufficient', () => {
    users.setStatus(1, 'active');
    bal.topup(1, 40_00, 'seed');
    expect(bal.hold(1, 50_00, 'url')).toEqual({ ok: false, reason: 'insufficient' });
    expect(users.get(1)!.balanceRub).toBe(40_00);
  });

  it('holds then refunds back to the original balance', () => {
    users.setStatus(1, 'active');
    bal.topup(1, 100_00, 'seed');
    expect(bal.hold(1, 60_00, 'url')).toEqual({ ok: true });
    expect(users.get(1)!.balanceRub).toBe(40_00);
    bal.refund(1, 60_00, 'url');
    expect(users.get(1)!.balanceRub).toBe(100_00);
  });
});

describe('BalancesRepo.reconcileHolds (crash recovery)', () => {
  let db: ReturnType<typeof openDb>;
  let users: UsersRepo; let bal: BalancesRepo; let purch: PurchasesRepo;
  beforeEach(() => {
    db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); bal = new BalancesRepo(db, now);
    purch = new PurchasesRepo(db, now);
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    bal.topup(1, 1000_00, 'seed');
  });

  it('refunds an orphaned hold (crash after hold, before any terminal)', () => {
    bal.hold(1, 60_00, 'url');
    expect(users.get(1)!.balanceRub).toBe(940_00);
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(1);
    expect(res.refundedKopecks).toBe(60_00);
    expect(users.get(1)!.balanceRub).toBe(1000_00);
  });

  it('leaves a completed purchase alone (hold + bought row + marker)', () => {
    bal.hold(1, 60_00, 'url');
    purch.record({ telegramId: 1, mercariUrl: 'url', priceJpy: 1000, costRub: 60_00, status: 'bought' });
    bal.finalizePurchase(1, 60_00, 'url');
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(0);
    expect(users.get(1)!.balanceRub).toBe(940_00); // money correctly spent
  });

  it('leaves an already-refunded failed attempt alone (hold + refund)', () => {
    bal.hold(1, 60_00, 'url');
    bal.refund(1, 60_00, 'url');
    purch.record({ telegramId: 1, mercariUrl: 'url', priceJpy: 1000, costRub: 60_00, status: 'failed' });
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(0);
    expect(users.get(1)!.balanceRub).toBe(1000_00);
  });

  it('does NOT sweep a hold retained by a pending refund request (admin gate)', () => {
    const refunds = new RefundRequestsRepo(db, now);
    bal.hold(1, 60_00, 'url');
    purch.record({ telegramId: 1, mercariUrl: 'url', priceJpy: 1000, costRub: 60_00, status: 'failed' });
    refunds.create({ telegramId: 1, mercariUrl: 'url', kopecks: 60_00, reason: 'error' });
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(0);
    expect(users.get(1)!.balanceRub).toBe(940_00); // stays debited until an admin decides
  });

  it('does NOT sweep a hold whose refund request was rejected (money kept)', () => {
    const refunds = new RefundRequestsRepo(db, now);
    bal.hold(1, 60_00, 'url');
    const id = refunds.create({ telegramId: 1, mercariUrl: 'url', kopecks: 60_00, reason: 'error' });
    refunds.resolve(id, 'rejected');
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(0);
    expect(users.get(1)!.balanceRub).toBe(940_00);
  });

  it('is idempotent — running twice does not double-refund', () => {
    bal.hold(1, 60_00, 'url');
    bal.reconcileHolds();
    const second = bal.reconcileHolds();
    expect(second.refundedCount).toBe(0);
    expect(users.get(1)!.balanceRub).toBe(1000_00);
  });

  it('handles repeated attempts on the same url: one failed, then a crashed hold', () => {
    // attempt 1: failed (hold + refund + failed row)
    bal.hold(1, 60_00, 'url');
    bal.refund(1, 60_00, 'url');
    purch.record({ telegramId: 1, mercariUrl: 'url', priceJpy: 1000, costRub: 60_00, status: 'failed' });
    // attempt 2: crashed right after hold (orphan)
    bal.hold(1, 60_00, 'url');
    expect(users.get(1)!.balanceRub).toBe(940_00);
    const res = bal.reconcileHolds();
    expect(res.refundedCount).toBe(1);
    expect(users.get(1)!.balanceRub).toBe(1000_00);
  });
});
