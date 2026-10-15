import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '@arhip/db';
import { UsersRepo, BalancesRepo, PurchasesRepo, RefundRequestsRepo } from '@arhip/db';
import { PurchaseQueue } from '@arhip/core';
import { buyForUser, type BuyContext } from '../src/services/purchase.ts';

const now = () => '2026-09-12T00:00:00.000Z';
const pricing = { rubPerJpy: 0.55, markup: 0.10, planFeeJpy: 150 };

function ctxWith(buyImpl: any, confirmViaOrders?: any): { ctx: BuyContext; users: UsersRepo; refunds: RefundRequestsRepo } {
  const db = openDb(':memory:'); migrate(db);
  const users = new UsersRepo(db, now);
  const balances = new BalancesRepo(db, now);
  const purchases = new PurchasesRepo(db, now);
  const refunds = new RefundRequestsRepo(db, now);
  const queue = new PurchaseQueue();
  const client: any = { buy: buyImpl };
  if (confirmViaOrders) client.confirmViaOrders = confirmViaOrders;
  return { ctx: { db, client, balances, purchases, refunds, queue, pricing, inflight: new Map() }, users, refunds };
}

// A minimal OrderRow, enough for buyForUser to treat the item as purchased.
const foundOrder = { orderNo: 'ORD-1', status: 'Paid', detailUrl: '/x', date: 'Today', title: 't', shoppingUrl: 'u', mercariItemId: 'm1' };

describe('buyForUser', () => {
  it('debits on success and records the purchase', async () => {
    const { ctx, users } = ctxWith(async () => ({ status: 'bought', finalUrl: 'done' }));
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const res = await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000);
    expect(res.status).toBe('bought');
    expect(ctx.purchases.isBought('https://jp.mercari.com/item/m1')).toBe(true);
    expect(users.get(1)!.balanceRub).toBe(1000_00 - 69575);
  });

  it('opens a refund request (no auto-refund) when the buy fails', async () => {
    const { ctx, users, refunds } = ctxWith(async () => ({ status: 'price_exceeded' }));
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const res = await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000);
    expect(res.status).toBe('refund_pending');
    // Money stays debited — an admin must approve before it is returned.
    expect(users.get(1)!.balanceRub).toBe(1000_00 - 69575);
    // A pending refund request captures the amount + reason for the admin.
    const pending = refunds.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].kopecks).toBe(69575);
    expect(pending[0].reason).toBe('price_exceeded');
    expect(ctx.purchases.isBought('https://jp.mercari.com/item/m1')).toBe(false);
  });

  // H2: a SHOP-side insufficient (empty deposit → /deposits/choose) means the buy
  // definitively did NOT go through, so auto-refund the user immediately — no admin
  // gate (that exists only for AMBIGUOUS outcomes where the item MAY have been paid).
  it('auto-refunds and reports shop-unavailable when the shop deposit is insufficient', async () => {
    const { ctx, users, refunds } = ctxWith(async () => ({ status: 'insufficient_balance', finalUrl: 'https://x/en/deposits/choose/' }));
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const url = 'https://jp.mercari.com/item/m1';
    const res = await buyForUser(ctx, 1, url, 1000);
    expect(res.status).toBe('insufficient_shop');
    // user's money is returned immediately — NOT held pending an admin decision
    expect(users.get(1)!.balanceRub).toBe(1000_00);
    expect(refunds.listPending()).toHaveLength(0);
    expect(ctx.purchases.isBought(url)).toBe(false);
  });

  it('refuses when balance is insufficient (no buy attempted)', async () => {
    let called = false;
    const { ctx, users } = ctxWith(async () => { called = true; return { status: 'bought' }; });
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 100, 'seed');
    const res = await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000);
    expect(res.status).toBe('insufficient');
    expect(called).toBe(false);
  });

  // Fix 1: concurrency TOCTOU — two concurrent calls for the SAME url
  it('concurrent calls: client.buy runs exactly once, second caller is refunded', async () => {
    const db = openDb(':memory:'); migrate(db);
    const users = new UsersRepo(db, now);
    const balances = new BalancesRepo(db, now);
    const purchases = new PurchasesRepo(db, now);
    const refunds = new RefundRequestsRepo(db, now);
    // Single shared queue — serializes both jobs.
    const queue = new PurchaseQueue();

    let buyCallCount = 0;
    // The mock simply returns 'bought'.  buyForUser itself records the purchase
    // row (via ctx.purchases.record) AFTER client.buy resolves, so the second
    // queued job will see isBought=true thanks to the re-check added in Fix 1.
    const buyImpl = async (_url: string, _opts: any) => {
      buyCallCount++;
      return { status: 'bought' as const, finalUrl: 'done', runId: null };
    };

    const ctx: BuyContext = { db, client: { buy: buyImpl }, balances, purchases, refunds, queue, pricing, inflight: new Map() };

    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    // Fund enough for two purchases.
    balances.topup(1, 200_000, 'seed');

    const url = 'https://jp.mercari.com/item/dup';
    const [res1, res2] = await Promise.all([
      buyForUser(ctx, 1, url, 1000),
      buyForUser(ctx, 1, url, 1000),
    ]);

    // Exactly one real buy call must have happened.
    expect(buyCallCount).toBe(1);

    // One call returns bought, the other returns already_bought.
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['already_bought', 'bought']);

    // The user's balance should reflect only one purchase deduction.
    // The second caller's hold must have been refunded.
    expect(users.get(1)!.balanceRub).toBe(200_000 - 69575);
  });

  // Fix 2 (audit п.2): the AMBIGUOUS branch must also not double-buy. The first
  // buy returns 'error' and confirms via /en/orders (slow, OUTSIDE the queue);
  // a concurrent buy for the SAME url must wait for it — not fire client.buy a
  // second time (a real duplicate vendor purchase) and then crash recordBought
  // on the unique index, leaking the hold.
  it('concurrent calls with an ambiguous first outcome: client.buy runs exactly once', async () => {
    const db = openDb(':memory:'); migrate(db);
    const users = new UsersRepo(db, now);
    const balances = new BalancesRepo(db, now);
    const purchases = new PurchasesRepo(db, now);
    const refunds = new RefundRequestsRepo(db, now);
    const queue = new PurchaseQueue();

    let buyCallCount = 0;
    const buyImpl = async () => { buyCallCount++; return { status: 'error' as const, finalUrl: '', runId: null }; };

    // confirmViaOrders blocks on a gate we release only after both buys are in
    // flight, reproducing the ~15s orders-poll window where the second job used
    // to slip through.
    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((r) => { releaseConfirm = r; });
    const confirmViaOrders = async () => { await confirmGate; return foundOrder; };

    const ctx: BuyContext = {
      db, client: { buy: buyImpl, confirmViaOrders }, balances, purchases, refunds,
      queue, pricing, inflight: new Map(),
    };

    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    balances.topup(1, 200_000, 'seed');

    const url = 'https://jp.mercari.com/item/amb';
    setTimeout(() => releaseConfirm(), 10);
    const [res1, res2] = await Promise.all([
      buyForUser(ctx, 1, url, 1000),
      buyForUser(ctx, 1, url, 1000),
    ]);

    expect(buyCallCount).toBe(1);
    expect([res1.status, res2.status].sort()).toEqual(['already_bought', 'bought']);
    expect(ctx.purchases.isBought(url)).toBe(true);
    // Only one hold, finalized; no leaked/duplicate debit.
    expect(users.get(1)!.balanceRub).toBe(200_000 - 69575);
  });

  it('persists run_id returned by client.buy', async () => {
    const { ctx, users } = ctxWith(async () => ({ status: 'bought', finalUrl: 'done', runId: '1700-7' }));
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    await buyForUser(ctx, 1, 'https://jp.mercari.com/item/rid', 1000);
    const row = ctx.purchases.listByUser(1, 1)[0];
    expect(row.runId).toBe('1700-7');
  });

  it('rolls back the purchase record if finalize fails (atomic bought branch)', async () => {
    const { ctx, users } = ctxWith(async () => ({ status: 'bought', finalUrl: 'done' }));
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    // Force finalize to throw so the record+finalize transaction aborts.
    ctx.balances.finalizePurchase = () => { throw new Error('boom'); };
    const url = 'https://jp.mercari.com/item/atomic';
    await buyForUser(ctx, 1, url, 1000);
    // The purchase row inserted inside the tx must have been rolled back —
    // record + finalize are atomic, so neither survives when finalize throws.
    expect(ctx.purchases.isBought(url)).toBe(false);
  });

  // An 'error' buy is ambiguous: the item MAY be paid. The slow orders check is
  // the authoritative tie-breaker.
  it('treats an ambiguous error as bought when the order shows up in /en/orders', async () => {
    const { ctx, users, refunds } = ctxWith(
      async () => ({ status: 'error', runId: 'r1' }),
      async () => foundOrder,
    );
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const url = 'https://jp.mercari.com/item/m1';
    const res = await buyForUser(ctx, 1, url, 1000);
    expect(res.status).toBe('bought');
    expect(ctx.purchases.isBought(url)).toBe(true);
    expect(users.get(1)!.balanceRub).toBe(1000_00 - 69575); // finalized, not refunded
    expect(refunds.listPending()).toHaveLength(0); // no refund request opened
  });

  it('opens a refund request when an ambiguous error is NOT confirmed by /en/orders', async () => {
    const { ctx, users, refunds } = ctxWith(
      async () => ({ status: 'error', runId: 'r1' }),
      async () => null, // order never appeared
    );
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const url = 'https://jp.mercari.com/item/m1';
    const res = await buyForUser(ctx, 1, url, 1000);
    expect(res.status).toBe('refund_pending');
    expect(ctx.purchases.isBought(url)).toBe(false);
    const pending = refunds.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('error');
  });

  it('treats a thrown buy as bought when the order shows up in /en/orders', async () => {
    const { ctx, users, refunds } = ctxWith(
      async () => { throw new Error('network error'); },
      async () => foundOrder,
    );
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const url = 'https://jp.mercari.com/item/m1';
    const res = await buyForUser(ctx, 1, url, 1000);
    expect(res.status).toBe('bought');
    expect(ctx.purchases.isBought(url)).toBe(true);
    expect(refunds.listPending()).toHaveLength(0);
  });

  it('calls onValidating (once, before the orders poll) for an ambiguous error', async () => {
    const events: string[] = [];
    const { ctx, users } = ctxWith(
      async () => ({ status: 'error', runId: 'r1' }),
      async () => { events.push('poll'); return foundOrder; },
    );
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000, () => { events.push('validating'); });
    expect(events).toEqual(['validating', 'poll']);
  });

  it('calls onValidating for a thrown buy', async () => {
    let n = 0;
    const { ctx, users } = ctxWith(async () => { throw new Error('x'); }, async () => foundOrder);
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000, () => { n++; });
    expect(n).toBe(1);
  });

  it('does NOT call onValidating on a clean bought', async () => {
    let n = 0;
    const { ctx, users } = ctxWith(async () => ({ status: 'bought', finalUrl: 'done' }), async () => foundOrder);
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    await buyForUser(ctx, 1, 'https://jp.mercari.com/item/m1', 1000, () => { n++; });
    expect(n).toBe(0);
  });

  // A thrown buy is ambiguous (the click may have submitted) → gate, don't refund.
  it('opens a refund request (no auto-refund) when client.buy throws', async () => {
    const { ctx, users, refunds } = ctxWith(async () => { throw new Error('network error'); });
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    ctx.balances.topup(1, 1000_00, 'seed');
    const res = await buyForUser(ctx, 1, 'https://jp.mercari.com/item/err', 1000);
    expect(res.status).toBe('refund_pending');
    // Money stays debited pending admin decision.
    expect(users.get(1)!.balanceRub).toBe(1000_00 - 69575);
    const pending = refunds.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('threw');
    // No bought row.
    expect(ctx.purchases.isBought('https://jp.mercari.com/item/err')).toBe(false);
  });
});
