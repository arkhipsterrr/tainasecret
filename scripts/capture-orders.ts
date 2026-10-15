// One-off capture of the /en/orders list HTML (ground truth for the orders
// parser). Headed Chromium on the SAME .pw-user profile the bot uses, NO proxy
// (residential IP is WAF-clean, same as research-buy.ts). If the saved session
// is dead you'll land on /login — just sign in by hand in the same window, then
// come back to the orders page; the profile persists.
//
//   npx tsx scripts/capture-orders.ts
//
// Output -> packages/core/test/fixtures/orders-*.html  (real page HTML)
//
// Flow: it opens the orders page, then walks pages 1..N. When you press Enter
// (or close the window) it snapshots whatever orders pages loaded into fixtures.
import { chromium, loadConfig, type BrowserContext, type Page } from '@arhip/core';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cfg = loadConfig();
const FIXTURES = join('packages', 'core', 'test', 'fixtures');
// Use a SEPARATE profile, not the bot's .pw-user: that profile auto-logs into a
// throwaway account and holds the bot's mercari cookies. A fresh dir means a
// clean login screen — sign in under the RIGHT account once and it persists
// here. Override with PROFILE_DIR=…; CLEAR=1 wipes it first for a truly fresh
// start (e.g. after logging into the wrong account).
const PROFILE_DIR = process.env.PROFILE_DIR ?? '.pw-capture';
if (process.env.CLEAR === '1') {
  await rm(PROFILE_DIR, { recursive: true, force: true });
  console.log(`cleared profile ${PROFILE_DIR}`);
}
// The orders list paginates as /en/orders/index/N (seen in the 09-14 network
// capture). Grab the first page plus a couple more so the parser is exercised
// against real pagination markup, not a single hand-picked page.
const ORDER_PATHS = ['/en/orders', '/en/orders/index/1', '/en/orders/index/2'];

await mkdir(FIXTURES, { recursive: true });

const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
  // NO proxy on purpose: the residential IP is WAF-clean.
});

const page: Page = ctx.pages()[0] ?? (await ctx.newPage());

function fixtureName(path: string): string {
  const slug = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'orders';
  return `${slug}.html`;
}

async function capture(path: string): Promise<void> {
  const url = cfg.baseUrl + path;
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  const landed = page.url();
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  if (/\/users\/login/.test(landed)) {
    console.log(`  [skip] ${path} -> redirected to LOGIN (${landed}); sign in and re-run`);
    return;
  }
  const file = join(FIXTURES, fixtureName(path));
  await writeFile(file, html);
  const itemIds = [...new Set((html.match(/m\d{11,}/g) ?? []))];
  console.log(`  [saved] ${path} -> ${file}`);
  console.log(`          title="${title}"  bytes=${html.length}  mercariItemIds=${itemIds.length ? itemIds.join(',') : 'NONE'}`);
}

console.log(`\nHeaded browser open on profile ${PROFILE_DIR}.`);
console.log('If it lands on /login, sign in by hand, then press Enter here to capture.\n');

// Start on the orders page so login state is immediately visible.
await page.goto(cfg.baseUrl + '/en/orders', { waitUntil: 'domcontentloaded' }).catch(() => {});

await new Promise<void>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const done = () => { try { rl.close(); } catch { /* */ } resolve(); };
  rl.on('line', done);
  ctx.on('close', done);
  process.on('SIGINT', done);
  console.log('Press Enter when the orders page is visible (logged in)…');
});

console.log('\nCapturing order pages…');
for (const p of ORDER_PATHS) await capture(p);

try { await ctx.close(); } catch { /* already closed */ }
console.log(`\nDone. Fixtures in ${FIXTURES}\\`);
process.exit(0);
