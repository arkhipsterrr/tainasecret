import { Bot } from 'grammy';
import type { UsersRepo, BalancesRepo, PurchasesRepo, SettingsRepo, RefundRequestsRepo } from '@arhip/db';
import type { PricingConfig } from '@arhip/core';
import type { PreviewCache } from './preview-cache.ts';
import type { BuyResult } from './services/purchase.ts';
import { handleStart } from './handlers/start.ts';
import { handleBalance } from './handlers/balance.ts';
import { handleOrders } from './handlers/orders.ts';
import { handleHelp } from './handlers/help.ts';
import { handleLink } from './handlers/link.ts';
import { handleBuyCallback } from './handlers/buy-callback.ts';
import {
  handleUsers, handleActivate, handleBlock, handleTopup,
  handleSummary, handleAllOrders, handleRefunds,
  handleRate, handleMarkup, handleFee, handlePricing, handleSignupDecision, handleRefundDecision,
  handleInfo, handleUserCallback, handleAdminReply,
} from './handlers/admin.ts';
import { PendingEdits } from './admin-edits.ts';
import { RateLimiter, RATE_LIMITS, classifyUpdate } from './rate-limit.ts';

export interface BotDeps {
  botToken: string;
  users: UsersRepo;
  balances: BalancesRepo;
  purchases: PurchasesRepo;
  refunds: RefundRequestsRepo;
  previews: PreviewCache;
  previewFn: (url: string) => Promise<{ title: string; priceJpy: number; plans: unknown[] }>;
  buy: (
    telegramId: number,
    url: string,
    priceJpy: number,
    onValidating?: () => void | Promise<void>,
  ) => Promise<BuyResult>;
  settings: SettingsRepo;
  defaultPricing: PricingConfig;
  adminIds: number[];
}

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.botToken);

  // Per-user rate limiting (429-equivalent): reject over-limit updates with a
  // short notice instead of processing them. Buy stays generous; cheap/spammy
  // classes are tighter. Runs before every handler.
  const limiter = new RateLimiter(() => Date.now());
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid == null) return next();
    const cls = classifyUpdate(ctx);
    if (limiter.allow(`${uid}:${cls}`, RATE_LIMITS[cls])) return next();
    if (ctx.callbackQuery) {
      try { await ctx.answerCallbackQuery({ text: '⭐ Слишком часто, подождите.' }); } catch { /* ignore */ }
    } else {
      try { await ctx.reply('⭐ Слишком часто, подождите.'); } catch { /* ignore */ }
    }
    // stop: do not call next()
  });

  bot.command('start', (ctx) => handleStart(ctx, { users: deps.users, adminIds: deps.adminIds }));
  bot.command('help', (ctx) => handleHelp(ctx, { users: deps.users, adminIds: deps.adminIds }));
  bot.command('balance', (ctx) => handleBalance(ctx, { users: deps.users, balances: deps.balances }));
  bot.command('orders', (ctx) => handleOrders(ctx, { users: deps.users, purchases: deps.purchases }));

  // Admin-only (gated by TELEGRAM_ADMIN_IDS); silently ignored for everyone else.
  const admin = { adminIds: deps.adminIds, users: deps.users, balances: deps.balances };
  bot.command('users', (ctx) => handleUsers(ctx, admin));
  bot.command('activate', (ctx) => handleActivate(ctx, admin));
  bot.command('block', (ctx) => handleBlock(ctx, admin));
  bot.command('topup', (ctx) => handleTopup(ctx, admin));

  // Per-user control panel (/info card) + its inline actions. `edits` holds the
  // pending force-reply state each admin is entering (bot-scoped, in-memory).
  const edits = new PendingEdits();
  const userCard = {
    adminIds: deps.adminIds, users: deps.users, balances: deps.balances,
    settings: deps.settings, defaultPricing: deps.defaultPricing, edits,
  };
  bot.command('info', (ctx) => handleInfo(ctx, userCard));

  // Catalog views (moved from the web console).
  bot.command('summary', (ctx) =>
    handleSummary(ctx, { adminIds: deps.adminIds, users: deps.users, purchases: deps.purchases, refunds: deps.refunds }));
  bot.command('allorders', (ctx) => handleAllOrders(ctx, { adminIds: deps.adminIds, purchases: deps.purchases }));
  bot.command('refunds', (ctx) => handleRefunds(ctx, { adminIds: deps.adminIds, refunds: deps.refunds }));

  // Admin pricing overrides (live, no restart) — gated the same way.
  const pricingAdmin = { adminIds: deps.adminIds, settings: deps.settings, defaultPricing: deps.defaultPricing };
  bot.command('pricing', (ctx) => handlePricing(ctx, pricingAdmin));
  bot.command('rate', (ctx) => handleRate(ctx, pricingAdmin));
  bot.command('markup', (ctx) => handleMarkup(ctx, pricingAdmin));
  bot.command('fee', (ctx) => handleFee(ctx, pricingAdmin));

  bot.on('message:text', async (ctx) => {
    // An admin mid-edit (force-reply from a user card) consumes their reply here
    // before it's mistaken for a Mercari link.
    if (await handleAdminReply(ctx, userCard)) return;
    return handleLink(ctx, {
      users: deps.users,
      previews: deps.previews,
      previewFn: deps.previewFn,
      // Per-user effective pricing (env default ⊕ global override ⊕ user override).
      pricing: deps.settings.getPricingFor(ctx.from.id, deps.defaultPricing),
    });
  });
  bot.callbackQuery(/^(buy|cancel):/, (ctx) =>
    handleBuyCallback(ctx, { previews: deps.previews, buy: deps.buy, adminIds: deps.adminIds }),
  );
  bot.callbackQuery(/^(approve|decline):/, (ctx) =>
    handleSignupDecision(ctx, { adminIds: deps.adminIds, users: deps.users }),
  );
  bot.callbackQuery(/^(refund_approve|refund_reject):/, (ctx) =>
    handleRefundDecision(ctx, { adminIds: deps.adminIds, refunds: deps.refunds, balances: deps.balances }),
  );
  bot.callbackQuery(/^(uedit|ustatus|utopup):/, (ctx) => handleUserCallback(ctx, userCard));

  return bot;
}
