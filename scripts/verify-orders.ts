// Non-interactive reconciliation: open the REAL shop account's /en/orders list
// (headed, residential IP is WAF-clean, .pw-capture profile — NOT the bot's
// throwaway .pw-user) and cross-check the disputed purchases against what the
// account actually shows. Prints every order plus a per-item verdict, then exits.
// If the profile's session is dead it lands on /login and reports NEED_LOGIN so
// you can sign in once via scripts/capture-orders.ts and re-run this.
//   npx tsx scripts/verify-orders.ts
import { loadConfig, parseOrdersPage, chromium, type BrowserContext, type Page, type OrderRow } from '@arhip/core';

const cfg = loadConfig();
const PROFILE = process.env.PROFILE_DIR ?? '.pw-capture';
// The 4 DB orders (status 'failed') whose POST may actually have gone through.
const DISPUTED = ['m40198561975', 'm27688411462', 'm85744032100', 'm99647196906'];
const PATHS = ['/en/orders', '/en/orders/index/1', '/en/orders/index/2', '/en/orders/index/3'];

const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
const page: Page = ctx.pages()[0] ?? (await ctx.newPage());

const all: OrderRow[] = [];
let needLogin = false;
for (const p of PATHS) {
  await page.goto(cfg.baseUrl + p, { waitUntil: 'networkidle' }).catch(() => {});
  if (/\/users\/login/.test(page.url())) { needLogin = true; break; }
  const rows = parseOrdersPage(await page.content());
  if (rows.length === 0) break; // past the last page
  all.push(...rows);
}
await ctx.close().catch(() => {});

if (needLogin) {
  console.log('NEED_LOGIN: the .pw-capture session is dead (landed on /login).');
  console.log('Run `npx tsx scripts/capture-orders.ts`, sign in by hand once, then re-run this.');
  process.exit(2);
}

// Dedupe across paginated pages by order number.
const seen = new Set<string>();
const uniq = all.filter((r) => (seen.has(r.orderNo) ? false : (seen.add(r.orderNo), true)));

console.log(`\nTOTAL ORDERS ON ACCOUNT: ${uniq.length}\n`);
for (const r of uniq) {
  console.log(JSON.stringify({ orderNo: r.orderNo, status: r.status, date: r.date, item: r.mercariItemId, title: r.title.slice(0, 45) }));
}
console.log('\n--- DISPUTED ITEMS (DB status = failed) ---');
for (const id of DISPUTED) {
  const hit = uniq.find((r) => r.mercariItemId === id);
  console.log(hit ? `${id}  FOUND  status=${hit.status}  orderNo=${hit.orderNo}  date=${hit.date}` : `${id}  NOT ON ACCOUNT`);
}
process.exit(0);
