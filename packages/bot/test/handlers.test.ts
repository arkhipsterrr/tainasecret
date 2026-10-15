import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, UsersRepo, BalancesRepo, PurchasesRepo, SettingsRepo, RefundRequestsRepo } from '@arhip/db';
import { PreviewCache } from '../src/preview-cache.ts';
import { handleStart, handleLink, handleBuyCallback } from '../src/handlers/index.ts';
import { handleUsers, handleActivate, handleBlock, handleTopup, handleSignupDecision, handleRefundDecision } from '../src/handlers/admin.ts';
import { handleSummary, handleAllOrders, handleRefunds } from '../src/handlers/admin.ts';
import { handleRate, handleMarkup, handleFee, handlePricing } from '../src/handlers/admin.ts';
import { handleInfo, handleUserCallback, handleAdminReply } from '../src/handlers/admin.ts';
import { PendingEdits } from '../src/admin-edits.ts';
import { handleHelp } from '../src/handlers/help.ts';

const now = () => '2026-09-12T00:00:00.000Z';
function fakeCtx(over: any = {}) {
  const calls: any = { reply: [], edit: [], answer: [], api: [] };
  return {
    calls,
    from: over.from ?? { id: 1, username: 'u' },
    message: over.message,
    callbackQuery: over.callbackQuery,
    match: over.match,
    reply: async (t: string, extra?: any) => { calls.reply.push({ t, extra }); },
    editMessageText: async (t: string, extra?: any) => { calls.edit.push({ t, extra }); },
    answerCallbackQuery: async (t?: any) => { calls.answer.push(t); },
    api: { sendMessage: async (chatId: number, t: string, extra?: any) => { calls.api.push({ chatId, t, extra }); } },
  } as any;
}

describe('handlers', () => {
  let users: UsersRepo; let balances: BalancesRepo; let previews: PreviewCache;
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); balances = new BalancesRepo(db, now);
    previews = new PreviewCache(60_000, () => 0);
  });

  it('/start registers a pending user', async () => {
    const ctx = fakeCtx();
    await handleStart(ctx, { users, adminIds: [] });
    expect(users.get(1)!.status).toBe('pending');
    expect(ctx.calls.reply[0].t).toMatch(/активац/i);
  });

  it('/start notifies admins about a new signup with approve/decline buttons', async () => {
    const ctx = fakeCtx({ from: { id: 7, username: 'newbie' } });
    await handleStart(ctx, { users, adminIds: [99, 100] });
    expect(ctx.calls.api).toHaveLength(2); // one DM per admin
    expect(ctx.calls.api[0].chatId).toBe(99);
    expect(ctx.calls.api[0].t).toMatch(/newbie|7/);
    const kb = JSON.stringify(ctx.calls.api[0].extra.reply_markup);
    expect(kb).toMatch(/approve:7/);
    expect(kb).toMatch(/decline:7/);
  });

  it('/start does NOT re-notify admins on a repeat /start', async () => {
    const ctx1 = fakeCtx({ from: { id: 7, username: 'newbie' } });
    await handleStart(ctx1, { users, adminIds: [99] });
    const ctx2 = fakeCtx({ from: { id: 7, username: 'newbie' } });
    await handleStart(ctx2, { users, adminIds: [99] });
    expect(ctx2.calls.api).toHaveLength(0); // already existed → no notification
  });

  it('a mercari link previews and offers a buy button', async () => {
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    const ctx = fakeCtx({ message: { text: 'https://jp.mercari.com/item/m1' } });
    const previewFn = async () => ({ title: 'Item', priceJpy: 1000, plans: [] });
    await handleLink(ctx, { users, previews, previewFn, pricing: { rubPerJpy: 0.55, markup: 0.1, planFeeJpy: 150 } });
    expect(ctx.calls.reply[0].t).toMatch(/Item/);
    expect(ctx.calls.reply[0].extra.reply_markup).toBeDefined(); // inline keyboard present
  });

  it('reports the real reason when preview fails (no silent generic text)', async () => {
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    const ctx = fakeCtx({ message: { text: 'https://jp.mercari.com/item/m1' } });
    const previewFn = async () => { throw new Error('price_unavailable'); };
    await handleLink(ctx, { users, previews, previewFn, pricing: { rubPerJpy: 0.55, markup: 0.1, planFeeJpy: 150 } });
    expect(ctx.calls.reply[0].t).toMatch(/сесси|цену/i); // explains the price_unavailable cause
  });

  it('surfaces an unknown error message verbatim', async () => {
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    const ctx = fakeCtx({ message: { text: 'https://jp.mercari.com/item/m1' } });
    const previewFn = async () => { throw new Error('boom_xyz'); };
    await handleLink(ctx, { users, previews, previewFn, pricing: { rubPerJpy: 0.55, markup: 0.1, planFeeJpy: 150 } });
    expect(ctx.calls.reply[0].t).toMatch(/boom_xyz/);
  });

  it('a non-active user gets a preview WITHOUT a buy button', async () => {
    users.upsertOnStart(1, 'u'); // left at status 'pending'
    const ctx = fakeCtx({ message: { text: 'https://jp.mercari.com/item/m1' } });
    const previewFn = async () => ({ title: 'Item', priceJpy: 1000, plans: [] });
    await handleLink(ctx, { users, previews, previewFn, pricing: { rubPerJpy: 0.55, markup: 0.1, planFeeJpy: 150 } });
    expect(ctx.calls.reply[0].t).toMatch(/Item/);
    expect(ctx.calls.reply[0].extra?.reply_markup).toBeUndefined(); // no buy button for non-active user
  });

  it('buy callback with a stale preview id is rejected gracefully', async () => {
    users.upsertOnStart(1, 'u'); users.setStatus(1, 'active');
    const ctx = fakeCtx({ callbackQuery: { data: 'buy:doesnotexist' } });
    const buy = async () => ({ status: 'bought' as const, costKopecks: 1 });
    await handleBuyCallback(ctx, { previews, buy, adminIds: [] });
    expect(ctx.calls.answer.length).toBe(1); // answered, no crash
  });

  it('buy callback: refund_pending tells the user a request was filed and notifies admins', async () => {
    users.upsertOnStart(1, 'buyer'); users.setStatus(1, 'active');
    const id = previews.put(1, { url: 'https://jp.mercari.com/item/m1', title: 'Item', priceJpy: 1000 });
    const ctx = fakeCtx({ from: { id: 1, username: 'buyer' }, callbackQuery: { data: `buy:${id}` } });
    const buy = async () => ({
      status: 'refund_pending' as const, requestId: 42, costKopecks: 69575,
      reason: 'error', url: 'https://jp.mercari.com/item/m1',
    });
    await handleBuyCallback(ctx, { previews, buy, adminIds: [99, 100] });
    const userMsg = ctx.calls.edit.map((e: any) => e.t).join('\n');
    expect(userMsg).toMatch(/заявк/i);          // "заявка на возврат отправлена"
    expect(userMsg).not.toMatch(/возвращены/i);  // NOT the old "средства возвращены"
    expect(ctx.calls.api).toHaveLength(2);       // one DM per admin
    expect(ctx.calls.api[0].chatId).toBe(99);
    const kb = JSON.stringify(ctx.calls.api[0].extra.reply_markup);
    expect(kb).toMatch(/refund_approve:42/);
    expect(kb).toMatch(/refund_reject:42/);
  });

  it('buy callback: shows a "validating" message when the buy enters the orders-check phase', async () => {
    users.upsertOnStart(1, 'buyer'); users.setStatus(1, 'active');
    const id = previews.put(1, { url: 'https://jp.mercari.com/item/m1', title: 'Item', priceJpy: 1000 });
    const ctx = fakeCtx({ from: { id: 1, username: 'buyer' }, callbackQuery: { data: `buy:${id}` } });
    // The buy fires onValidating (order placed → slow orders check begins).
    const buy = async (_uid: number, _url: string, _jpy: number, onValidating?: () => void | Promise<void>) => {
      await onValidating?.();
      return { status: 'bought' as const, costKopecks: 1 };
    };
    await handleBuyCallback(ctx, { previews, buy, adminIds: [] });
    const msgs = ctx.calls.edit.map((e: any) => e.t).join('\n');
    expect(msgs).toMatch(/провер|валид/i); // user is told validation is in progress
  });
});

describe('admin handlers (gated by adminIds)', () => {
  let users: UsersRepo; let balances: BalancesRepo;
  const ADMINS = [99];
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); balances = new BalancesRepo(db, now);
    users.upsertOnStart(1, 'target'); // a pending target user
  });
  const deps = () => ({ adminIds: ADMINS, users, balances });

  it('silently ignores a non-admin (no reply, no state change)', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, match: '1' });
    await handleActivate(ctx, deps());
    expect(ctx.calls.reply.length).toBe(0);
    expect(users.get(1)!.status).toBe('pending');
  });

  it('/activate sets a user active', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '1' });
    await handleActivate(ctx, deps());
    expect(users.get(1)!.status).toBe('active');
    expect(ctx.calls.reply[0].t).toMatch(/активирован/i);
  });

  it('/activate rejects an empty argument with usage', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '' });
    await handleActivate(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/Использование/i);
  });

  it('/activate reports an unknown user', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '777' });
    await handleActivate(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/не найден/i);
    expect(users.get(777)).toBeNull();
  });

  it('/block sets a user blocked', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '1' });
    await handleBlock(ctx, deps());
    expect(users.get(1)!.status).toBe('blocked');
  });

  it('/topup credits the balance in kopecks', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '1 500' });
    await handleTopup(ctx, deps());
    expect(users.get(1)!.balanceRub).toBe(500_00);
    expect(ctx.calls.reply[0].t).toMatch(/500/);
  });

  it('/topup rejects a non-positive or malformed amount', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '1 -5' });
    await handleTopup(ctx, deps());
    expect(users.get(1)!.balanceRub).toBe(0);
    expect(ctx.calls.reply[0].t).toMatch(/Использование/i);
  });

  it('/topup is ignored for a non-admin', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, match: '1 500' });
    await handleTopup(ctx, deps());
    expect(users.get(1)!.balanceRub).toBe(0);
    expect(ctx.calls.reply.length).toBe(0);
  });

  it('/users lists all users for an admin', async () => {
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleUsers(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/target/);
  });

  it('approve callback activates the user and notifies them', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: 'approve:1' } });
    await handleSignupDecision(ctx, { adminIds: ADMINS, users });
    expect(users.get(1)!.status).toBe('active');
    expect(ctx.calls.api[0].chatId).toBe(1); // user notified
  });

  it('decline callback blocks the user', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: 'decline:1' } });
    await handleSignupDecision(ctx, { adminIds: ADMINS, users });
    expect(users.get(1)!.status).toBe('blocked');
  });

  it('signup decision is ignored for a non-admin', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, callbackQuery: { data: 'approve:1' } });
    await handleSignupDecision(ctx, { adminIds: ADMINS, users });
    expect(users.get(1)!.status).toBe('pending'); // unchanged
  });
});

describe('refund decisions (admin gate on returns)', () => {
  const ADMINS = [99];
  const URL = 'https://jp.mercari.com/item/x';
  let db: any; let users: UsersRepo; let balances: BalancesRepo; let refunds: RefundRequestsRepo;
  beforeEach(() => {
    db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); balances = new BalancesRepo(db, now);
    refunds = new RefundRequestsRepo(db, now);
    users.upsertOnStart(1, 'buyer'); users.setStatus(1, 'active');
    balances.topup(1, 1000_00, 'seed');
    balances.hold(1, 600_00, URL); // debited → 400_00, awaiting a decision
  });
  const deps = () => ({ adminIds: ADMINS, refunds, balances });

  it('approve → refunds the held money, resolves the request, notifies the user', async () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 600_00, reason: 'error' });
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: `refund_approve:${id}` } });
    await handleRefundDecision(ctx, deps());
    expect(refunds.get(id)!.status).toBe('approved');
    expect(users.get(1)!.balanceRub).toBe(1000_00); // money returned
    expect(ctx.calls.api[0].chatId).toBe(1);         // buyer notified
  });

  it('reject → keeps the money debited and marks the request rejected', async () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 600_00, reason: 'error' });
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: `refund_reject:${id}` } });
    await handleRefundDecision(ctx, deps());
    expect(refunds.get(id)!.status).toBe('rejected');
    expect(users.get(1)!.balanceRub).toBe(400_00); // stays debited
  });

  it('a second click on an already-approved request does not double-refund', async () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 600_00, reason: 'error' });
    await handleRefundDecision(fakeCtx({ from: { id: 99 }, callbackQuery: { data: `refund_approve:${id}` } }), deps());
    await handleRefundDecision(fakeCtx({ from: { id: 99 }, callbackQuery: { data: `refund_approve:${id}` } }), deps());
    expect(users.get(1)!.balanceRub).toBe(1000_00); // refunded once only
  });

  it('is ignored for a non-admin (no refund, request untouched)', async () => {
    const id = refunds.create({ telegramId: 1, mercariUrl: URL, kopecks: 600_00, reason: 'error' });
    const ctx = fakeCtx({ from: { id: 1 }, callbackQuery: { data: `refund_approve:${id}` } });
    await handleRefundDecision(ctx, deps());
    expect(refunds.get(id)!.status).toBe('pending');
    expect(users.get(1)!.balanceRub).toBe(400_00);
  });
});

describe('admin catalog handlers (in the bot)', () => {
  const ADMINS = [99];
  let users: UsersRepo; let balances: BalancesRepo; let purchases: PurchasesRepo; let refunds: RefundRequestsRepo;
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); balances = new BalancesRepo(db, now);
    purchases = new PurchasesRepo(db, now); refunds = new RefundRequestsRepo(db, now);
  });

  it('/summary reports balances, spent and pending totals (admin only)', async () => {
    users.upsertOnStart(1, 'a'); balances.topup(1, 100000, 's');
    purchases.record({ telegramId: 1, mercariUrl: 'u', priceJpy: 1, costRub: 30000, status: 'bought' });
    refunds.create({ telegramId: 1, mercariUrl: 'x', kopecks: 20000, reason: 'threw' });
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleSummary(ctx, { adminIds: ADMINS, users, purchases, refunds });
    const t = ctx.calls.reply[0].t;
    expect(t).toMatch(/1000[.,]00/); // balances
    expect(t).toMatch(/300[.,]00/);  // spent
    expect(t).toMatch(/200[.,]00/);  // pending refunds
  });

  it('/summary is ignored for a non-admin', async () => {
    const ctx = fakeCtx({ from: { id: 1 } });
    await handleSummary(ctx, { adminIds: ADMINS, users, purchases, refunds });
    expect(ctx.calls.reply.length).toBe(0);
  });

  it('/allorders lists every user\'s orders newest-first with @username', async () => {
    users.upsertOnStart(1, 'alice');
    purchases.record({ telegramId: 1, mercariUrl: 'https://jp.mercari.com/item/a', priceJpy: 1000, costRub: 90000, status: 'bought' });
    purchases.record({ telegramId: 2, mercariUrl: 'https://jp.mercari.com/item/b', priceJpy: 2000, costRub: 91000, status: 'failed' });
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleAllOrders(ctx, { adminIds: ADMINS, purchases });
    const t = ctx.calls.reply[0].t;
    expect(t).toMatch(/@alice/);
    expect(t.indexOf('item/b')).toBeLessThan(t.indexOf('item/a')); // newest first
  });

  it('/refunds lists each pending request with approve/reject buttons', async () => {
    refunds.create({ telegramId: 1, mercariUrl: 'https://jp.mercari.com/item/a', kopecks: 5000, reason: 'threw' });
    refunds.create({ telegramId: 2, mercariUrl: 'https://jp.mercari.com/item/b', kopecks: 3000, reason: 'error' });
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleRefunds(ctx, { adminIds: ADMINS, refunds });
    expect(ctx.calls.reply.length).toBe(2);
    const kb = JSON.stringify(ctx.calls.reply[0].extra.reply_markup);
    expect(kb).toMatch(/refund_approve:/);
    expect(kb).toMatch(/refund_reject:/);
  });

  it('/refunds reports none when there are no pending requests', async () => {
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleRefunds(ctx, { adminIds: ADMINS, refunds });
    expect(ctx.calls.reply[0].t).toMatch(/нет/i);
  });

  it('/topup accepts a @username instead of an id', async () => {
    users.upsertOnStart(1, 'neo'); users.setStatus(1, 'active');
    const ctx = fakeCtx({ from: { id: 99 }, match: '@neo 500' });
    await handleTopup(ctx, { adminIds: ADMINS, users, balances });
    expect(users.get(1)!.balanceRub).toBe(500_00);
  });

  it('/activate accepts a @username', async () => {
    users.upsertOnStart(1, 'neo');
    const ctx = fakeCtx({ from: { id: 99 }, match: '@neo' });
    await handleActivate(ctx, { adminIds: ADMINS, users, balances });
    expect(users.get(1)!.status).toBe('active');
  });

  it('/topup reports not-found for an unknown @username', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '@ghost 500' });
    await handleTopup(ctx, { adminIds: ADMINS, users, balances });
    expect(ctx.calls.reply[0].t).toMatch(/не найден/i);
  });
});

describe('handleHelp (status-aware)', () => {
  let users: UsersRepo;
  const ADMINS = [99];
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now);
  });
  const deps = () => ({ users, adminIds: ADMINS });

  it('tells an unknown user to /start', async () => {
    const ctx = fakeCtx({ from: { id: 5 } });
    await handleHelp(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/\/start/);
  });

  it('tells a pending user to await activation', async () => {
    users.upsertOnStart(5, 'u'); // pending
    const ctx = fakeCtx({ from: { id: 5 } });
    await handleHelp(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/активац/i);
    expect(ctx.calls.reply[0].t).not.toMatch(/\/users/); // no admin block
  });

  it('shows user commands to an active user, no admin block', async () => {
    users.upsertOnStart(5, 'u'); users.setStatus(5, 'active');
    const ctx = fakeCtx({ from: { id: 5 } });
    await handleHelp(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/\/orders/);
    expect(ctx.calls.reply[0].t).not.toMatch(/\/topup/);
  });

  it('appends the admin block for an admin', async () => {
    users.upsertOnStart(99, 'boss'); users.setStatus(99, 'active');
    const ctx = fakeCtx({ from: { id: 99 } });
    await handleHelp(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/\/topup/);
    expect(ctx.calls.reply[0].t).toMatch(/\/pricing/);
  });
});

describe('pricing admin commands', () => {
  let settings: SettingsRepo;
  const ADMINS = [99];
  const defaultPricing = { rubPerJpy: 0.68, markup: 0, planFeeJpy: 400 };
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    settings = new SettingsRepo(db, now);
  });
  const deps = () => ({ adminIds: ADMINS, settings, defaultPricing });

  it('ignores /rate for a non-admin (no override written)', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, match: '0.7' });
    await handleRate(ctx, deps());
    expect(ctx.calls.reply.length).toBe(0);
    expect(settings.get('rate')).toBeNull();
  });

  it('/rate sets the exchange rate override', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '0.7' });
    await handleRate(ctx, deps());
    expect(settings.getPricing(defaultPricing).rubPerJpy).toBe(0.7);
    expect(ctx.calls.reply[0].t).toMatch(/0\.7/);
  });

  it('/rate rejects a non-positive or malformed value', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '0' });
    await handleRate(ctx, deps());
    expect(settings.get('rate')).toBeNull();
    expect(ctx.calls.reply[0].t).toMatch(/Использование/i);
  });

  it('/markup accepts a fraction (0.1 = 10%)', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '0.1' });
    await handleMarkup(ctx, deps());
    expect(settings.getPricing(defaultPricing).markup).toBe(0.1);
  });

  it('/fee sets the JPY fee', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '500' });
    await handleFee(ctx, deps());
    expect(settings.getPricing(defaultPricing).planFeeJpy).toBe(500);
  });

  it('/pricing shows the current effective formula with an example', async () => {
    const ctx = fakeCtx({ from: { id: 99 } });
    await handlePricing(ctx, deps());
    // default (3000+400)*0.68 = 2312.00 ₽
    expect(ctx.calls.reply[0].t).toMatch(/2312/);
  });
});

describe('user card /info & per-user pricing edits', () => {
  const ADMINS = [99];
  const defaultPricing = { rubPerJpy: 0.68, markup: 0, planFeeJpy: 400 };
  let users: UsersRepo; let balances: BalancesRepo; let settings: SettingsRepo; let edits: PendingEdits;
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    users = new UsersRepo(db, now); balances = new BalancesRepo(db, now); settings = new SettingsRepo(db, now);
    edits = new PendingEdits();
    users.upsertOnStart(1, 'target'); users.setStatus(1, 'active');
  });
  const deps = () => ({ adminIds: ADMINS, users, balances, settings, defaultPricing, edits });

  it('/info renders a card with pricing / status / topup buttons (admin only)', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '@target' });
    await handleInfo(ctx, deps());
    const r = ctx.calls.reply[0];
    expect(r.t).toMatch(/target/);
    expect(r.t).toMatch(/Статус/i);
    const kb = JSON.stringify(r.extra.reply_markup);
    expect(kb).toMatch(/uedit:rate:1/);
    expect(kb).toMatch(/uedit:markup:1/);
    expect(kb).toMatch(/uedit:fee:1/);
    expect(kb).toMatch(/ustatus:blocked:1/); // active user → offer block
    expect(kb).toMatch(/utopup:1/);
  });

  it('/info is silent for a non-admin', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, match: '@target' });
    await handleInfo(ctx, deps());
    expect(ctx.calls.reply.length).toBe(0);
  });

  it('/info reports an unknown user', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, match: '@ghost' });
    await handleInfo(ctx, deps());
    expect(ctx.calls.reply[0].t).toMatch(/не найден/i);
  });

  it('clicking "edit markup" prompts with a force_reply and stores a pending edit', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: 'uedit:markup:1' } });
    await handleUserCallback(ctx, deps());
    expect(ctx.calls.answer.length).toBe(1);
    const r = ctx.calls.reply[0];
    expect(r.t).toMatch(/markup|наценк/i);
    expect(r.extra.reply_markup.force_reply).toBe(true);
    // the pending edit drives the next admin reply
    const reply = fakeCtx({ from: { id: 99 }, message: { text: '0.3' } });
    const consumed = await handleAdminReply(reply, deps());
    expect(consumed).toBe(true);
    expect(settings.getUserOverrides(1).markup).toBe(0.3);
  });

  it('an admin reply applies a per-user override and echoes the updated card', async () => {
    edits.set(99, { action: 'pricing', targetId: 1, key: 'markup' });
    const ctx = fakeCtx({ from: { id: 99 }, message: { text: '0,3' } });
    const consumed = await handleAdminReply(ctx, deps());
    expect(consumed).toBe(true);
    expect(settings.getUserOverrides(1).markup).toBe(0.3);
    expect(ctx.calls.reply.some((r: any) => /0[.,]3/.test(r.t))).toBe(true);
  });

  it('an admin reply of "сброс" clears the per-user override', async () => {
    settings.setUser(1, 'markup', '0.3');
    edits.set(99, { action: 'pricing', targetId: 1, key: 'markup' });
    const ctx = fakeCtx({ from: { id: 99 }, message: { text: 'сброс' } });
    const consumed = await handleAdminReply(ctx, deps());
    expect(consumed).toBe(true);
    expect(settings.getUserOverrides(1).markup).toBeUndefined();
  });

  it('rejects an invalid pricing value without writing an override', async () => {
    edits.set(99, { action: 'pricing', targetId: 1, key: 'rate' });
    const ctx = fakeCtx({ from: { id: 99 }, message: { text: '0' } }); // rate must be > 0
    const consumed = await handleAdminReply(ctx, deps());
    expect(consumed).toBe(true);
    expect(settings.getUserOverrides(1).rate).toBeUndefined();
    expect(ctx.calls.reply[0].t).toMatch(/> 0|неверн|использов/i);
  });

  it('an admin topup reply credits the balance', async () => {
    edits.set(99, { action: 'topup', targetId: 1 });
    const ctx = fakeCtx({ from: { id: 99 }, message: { text: '500' } });
    const consumed = await handleAdminReply(ctx, deps());
    expect(consumed).toBe(true);
    expect(users.get(1)!.balanceRub).toBe(500_00);
  });

  it('handleAdminReply passes through (false) when the admin has no pending edit', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, message: { text: 'https://jp.mercari.com/item/m1' } });
    const consumed = await handleAdminReply(ctx, deps());
    expect(consumed).toBe(false);
    expect(ctx.calls.reply.length).toBe(0);
  });

  it('ustatus callback toggles the status and re-renders the card', async () => {
    const ctx = fakeCtx({ from: { id: 99 }, callbackQuery: { data: 'ustatus:blocked:1' } });
    await handleUserCallback(ctx, deps());
    expect(users.get(1)!.status).toBe('blocked');
    expect(ctx.calls.answer.length).toBe(1);
    const kb = JSON.stringify(ctx.calls.edit[0].extra.reply_markup);
    expect(kb).toMatch(/ustatus:active:1/); // now blocked → offer activate
  });

  it('a user callback is ignored for a non-admin', async () => {
    const ctx = fakeCtx({ from: { id: 1 }, callbackQuery: { data: 'ustatus:blocked:1' } });
    await handleUserCallback(ctx, deps());
    expect(users.get(1)!.status).toBe('active'); // unchanged
  });
});
