// Tracked research browser: headed Chromium on the SAME logged-in profile the
// bot uses (.pw-user), NO proxy, NO docker services. You drive a real purchase
// by hand; the script records the FULL flow so we can see why "the shop doesn't
// respond" even though the bot reports OK, and capture the true funded-success
// page shape (still unknown).
//
//   npx tsx scripts/research-buy.ts
//
// Output -> artifacts/research/<timestamp>/
//   trace.zip          full Playwright trace: open with `npx playwright show-trace <path>`
//   network.ndjson     every j-subculture.com request/response (+ POST/doc/error bodies)
//   console.ndjson     browser console messages
//   pages.ndjson       index of every page load (ts, url, title)
//   pages/NNN-*.html   full HTML of each loaded page (incl. the success page)
//   pages/NNN-*.png    full-page screenshot of each load
import { chromium, loadConfig, type BrowserContext, type Page } from '@arhip/core';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cfg = loadConfig();
const DOMAIN = 'j-subculture.com';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join('artifacts', 'research', stamp);
const pagesDir = join(outDir, 'pages');
await mkdir(pagesDir, { recursive: true });

const net: unknown[] = [];
const consoleLogs: unknown[] = [];
const pageIdx: unknown[] = [];
const pending: Promise<void>[] = [];

const now = () => new Date().toISOString();

const ctx: BrowserContext = await chromium.launchPersistentContext('.pw-user', {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
  // NO proxy on purpose: residential IP is WAF-clean, this reproduces a plain
  // human purchase, not the server's proxied path.
});

await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });

ctx.on('request', (req) => {
  if (!req.url().includes(DOMAIN)) return;
  net.push({
    t: 'req', ts: now(), method: req.method(), url: req.url(),
    resourceType: req.resourceType(), postData: req.postData() ?? null,
    headers: req.headers(),
  });
});

ctx.on('response', (resp) => {
  if (!resp.url().includes(DOMAIN)) return;
  pending.push((async () => {
    const method = resp.request().method();
    const status = resp.status();
    const headers = resp.headers();
    const ct = headers['content-type'] ?? '';
    // Capture bodies where they help: documents, JSON/XML, any redirect/error,
    // and every POST (the buy submit). Skip big binaries.
    const wantBody = /text|html|json|xml/i.test(ct) || status >= 300 || method === 'POST';
    let body: string | null = wantBody ? await resp.text().catch(() => null) : null;
    if (body && body.length > 300_000) body = body.slice(0, 300_000) + '…[truncated]';
    net.push({ t: 'resp', ts: now(), method, url: resp.url(), status, headers, bodyLen: body?.length ?? null, body });
  })());
});

let counter = 0;
function slug(u: string): string {
  try {
    const url = new URL(u);
    return (url.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root').slice(0, 60);
  } catch { return 'page'; }
}

async function snapshot(page: Page, reason: string): Promise<void> {
  const n = String(++counter).padStart(3, '0');
  const url = page.url();
  const title = await page.title().catch(() => '');
  const base = `${n}-${slug(url)}`;
  try { await writeFile(join(pagesDir, `${base}.html`), await page.content()); } catch { /* page navigating */ }
  try { await page.screenshot({ path: join(pagesDir, `${base}.png`), fullPage: true }); } catch { /* ignore */ }
  pageIdx.push({ n, ts: now(), reason, url, title });
  console.log(`  [snap ${n}] ${reason.padEnd(6)} ${url}  "${title}"`);
}

function wire(page: Page): void {
  page.on('load', () => { pending.push(snapshot(page, 'load')); });
  page.on('console', (msg) => { consoleLogs.push({ ts: now(), type: msg.type(), text: msg.text() }); });
  page.on('pageerror', (err) => { consoleLogs.push({ ts: now(), type: 'pageerror', text: String(err) }); });
}
for (const p of ctx.pages()) wire(p);
ctx.on('page', wire);

// Start on My Page so login state is immediately visible (redirects to /login if
// the saved session is dead — just sign in in the same window, the profile persists).
const first = ctx.pages()[0] ?? (await ctx.newPage());
await first.goto(cfg.baseUrl + '/en/users/mypage/', { waitUntil: 'domcontentloaded' }).catch(() => {});

// Finish signal decoupled from window close: when a sentinel file appears we
// stop WHILE the context is still alive, so trace.zip is written. (Closing the
// window also ends the session, but then only the live-captured HTML snapshots
// and network.ndjson survive — the trace is best-effort in that case.)
const STOP = join('artifacts', 'research', 'STOP');
if (existsSync(STOP)) await rm(STOP).catch(() => {});

console.log(`\nTracked browser open. Recording to ${outDir}`);
console.log(`Do the REAL purchase by hand. To finish: create the file  ${STOP}`);
console.log('(or press Enter here on a TTY, or just close the window).\n');

await new Promise<void>((resolve) => {
  let settled = false;
  const done = () => { if (settled) return; settled = true; clearInterval(poll); try { rl.close(); } catch { /* */ } resolve(); };
  const poll = setInterval(() => { if (existsSync(STOP)) done(); }, 1000);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', done);              // Enter on a real terminal
  ctx.on('close', done);            // user closed the browser window
  process.on('SIGINT', done);       // Ctrl+C
});

// Flush: stop tracing while the context is still alive, await in-flight body
// reads, then write the convenience NDJSON/HTML alongside the trace.
if (ctx.browser()?.isConnected() ?? false) {
  try { await ctx.tracing.stop({ path: join(outDir, 'trace.zip') }); }
  catch (e) { console.error('trace stop failed:', (e as Error).message); }
}
await Promise.allSettled(pending);

const write = (name: string, rows: unknown[]) =>
  writeFile(join(outDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
await write('network.ndjson', net);
await write('console.ndjson', consoleLogs);
await write('pages.ndjson', pageIdx);

try { await ctx.close(); } catch { /* already closed */ }

console.log(`\nSaved:`);
console.log(`  ${join(outDir, 'trace.zip')}   ->  npx playwright show-trace "${join(outDir, 'trace.zip')}"`);
console.log(`  ${join(outDir, 'network.ndjson')}  (${net.length} entries)`);
console.log(`  ${join(outDir, 'pages.ndjson')}    (${pageIdx.length} page loads)`);
console.log(`  ${pagesDir}\\  (HTML + screenshots)`);
process.exit(0);
