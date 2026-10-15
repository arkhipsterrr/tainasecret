import 'dotenv/config';
import { loadConfig, Session, JsubClient, RawJsubClient, createRawClient, ResearchLog, PurchaseQueue } from '@arhip/core';
import { openDb, migrate, UsersRepo, BalancesRepo, PurchasesRepo, SettingsRepo, RefundRequestsRepo } from '@arhip/db';
import { loadBotConfig } from './config.ts';
import { PreviewCache } from './preview-cache.ts';
import { buyForUser } from './services/purchase.ts';
import { buildBot } from './bot.ts';

const botCfg = loadBotConfig();
const coreCfg = loadConfig();
const db = openDb(botCfg.sqlitePath); migrate(db);
const iso = () => new Date().toISOString();
const users = new UsersRepo(db, iso);
const balances = new BalancesRepo(db, iso);
const purchases = new PurchasesRepo(db, iso);
const settings = new SettingsRepo(db, iso);
const refunds = new RefundRequestsRepo(db, iso);

// Crash recovery: refund holds left orphaned by a process killed mid-purchase.
const recon = balances.reconcileHolds();
if (recon.refundedCount > 0) {
  console.warn(`reconcile: refunded ${recon.refundedCount} orphaned hold(s), total ${recon.refundedKopecks} kopecks`);
  for (const d of recon.details) {
    console.warn(`  refunded ${d.kopecks} kopecks to ${d.telegramId} for ${d.url}`);
  }
}
const queue = new PurchaseQueue();
// Per-url in-flight guard shared across all buys (see buyForUser): a single
// shared Map so concurrent same-url buys serialize instead of double-charging.
const inflight = new Map<string, Promise<void>>();
const session = new Session(coreCfg);
const research = new ResearchLog(coreCfg.researchLogPath, coreCfg.runsDir);
// Raw HTTP (browserless) preview/buy when enabled; browser client is the default.
const client: Pick<JsubClient, 'preview' | 'buy'> | RawJsubClient =
  coreCfg.rawHttp ? createRawClient(coreCfg, research) : new JsubClient(session, coreCfg.baseUrl, research);
console.log(`buy engine: ${coreCfg.rawHttp ? 'raw-http' : 'browser'}`);

const previews = new PreviewCache(10 * 60_000, () => Date.now());
// Previews the user never acts on expire lazily but are only evicted on access;
// sweep periodically so abandoned entries don't leak.
setInterval(() => previews.sweep(), 10 * 60_000).unref();

const bot = buildBot({
  botToken: botCfg.token,
  users,
  balances,
  purchases,
  refunds,
  previews,
  previewFn: async (url) => {
    const p = await client.preview(url);
    if (p.priceJPY == null) throw new Error('price_unavailable');
    return { title: p.title, priceJpy: p.priceJPY, plans: p.plans };
  },
  buy: (id, url, jpy, onValidating) =>
    buyForUser(
      // Per-user effective pricing so the charge matches the price the user was
      // shown (env default ⊕ global override ⊕ that user's personal override).
      { db, client, balances, purchases, refunds, queue, inflight, pricing: settings.getPricingFor(id, botCfg.pricing) },
      id, url, jpy, onValidating,
    ),
  settings,
  defaultPricing: botCfg.pricing,
  adminIds: botCfg.adminIds,
});
bot.start();
console.log('bot started (long-polling)');
