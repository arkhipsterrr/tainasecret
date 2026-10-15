// ONE-SHOT controlled buy with a cookie jar (the proven fix, not yet deployed):
// seed a jar from the freshly-synced storageState, inject a jar+manual-redirect
// fetch into the DEPLOYED RawJsubClient so every hop (incl. POST -> -fin) carries
// the rotating auth cookie. Single process / single jar so rotation never kills
// the session between steps. preview (alive + price) -> buy (cap = preview price)
// -> confirm via /en/orders. Read artifacts under RUNS_DIR.
import { readFileSync } from 'node:fs';
import { socksDispatcher } from 'fetch-socks';
import { fetch as undiciFetch } from 'undici';
import { RawJsubClient } from './src/jsub/raw-client.ts';
import { cookieHeaderFromState } from './src/jsub/raw-transport.ts';
import { ResearchLog } from './src/research/recorder.ts';

function makeCookieJar(seed: string) {
  const m = new Map<string, string>();
  for (const p of seed.split('; ')) { const i = p.indexOf('='); if (i > 0) m.set(p.slice(0, i), p.slice(i + 1)); }
  return {
    header: () => [...m].map(([k, v]) => `${k}=${v}`).join('; '),
    apply: (list: string[]) => { for (const sc of list || []) { const kv = sc.split(';')[0]; const i = kv.indexOf('='); if (i > 0) m.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } },
  };
}

const base = process.env.JSUB_BASE_URL!;
const u = new URL(process.env.PROXY_URL!);
const dispatcher = socksDispatcher({ type: 5, host: u.hostname, port: Number(u.port) }, { connections: 4, keepAliveTimeout: 60_000 });
const jar = makeCookieJar(cookieHeaderFromState(JSON.parse(readFileSync(process.env.STORAGE_STATE_PATH!, 'utf8'))));

const jarFetch = async (url: string, init: any = {}) => {
  let curUrl = url;
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  const baseHeaders = { ...(init.headers || {}) };
  for (let hop = 0; hop < 10; hop++) {
    const headers: any = { ...baseHeaders, cookie: jar.header() };
    if (method === 'GET') delete headers['content-type'];
    const r: any = await undiciFetch(curUrl, { method, headers, body, dispatcher, redirect: 'manual' });
    jar.apply(r.headers.getSetCookie?.() ?? []);
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      const next = new URL(loc, curUrl).toString();
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      curUrl = next;
      try { await r.body?.cancel(); } catch { /* */ }
      continue;
    }
    const text = await r.text();
    console.log(`  [hop ${hop}] ${method} -> ${r.status} ${curUrl.slice(0, 80)}`);
    return { status: r.status, url: curUrl, text: async () => text };
  }
  throw new Error('too_many_redirects');
};

const research = new ResearchLog(process.env.RESEARCH_LOG_PATH!, process.env.RUNS_DIR!);
const client = new RawJsubClient(base, () => jar.header(), jarFetch as any, research);
const TARGET = 'https://jp.mercari.com/item/m34867004501';

console.log('=== PREVIEW ===');
const p = await client.preview(TARGET);
console.log('PREVIEW:', JSON.stringify({ title: (p.title || '').slice(0, 60), priceJPY: p.priceJPY, plans: (p.plans || []).map((x: any) => x.value) }));
if (p.priceJPY == null) { console.log('ABORT: no price / not buyable'); process.exit(1); }

console.log('=== BUY (cap =', p.priceJPY, 'JPY) ===');
const r = await client.buy(TARGET, { plan: '1', maxPriceJPY: p.priceJPY });
console.log('BUY OUTCOME:', JSON.stringify(r));

console.log('=== CONFIRM via /en/orders ===');
const ord = await client.confirmViaOrders(TARGET, { attempts: 5, delayMs: 2000 });
console.log('CONFIRM:', ord ? JSON.stringify({ orderNo: ord.orderNo, status: ord.status, date: ord.date, title: (ord.title || '').slice(0, 40) }) : 'NOT FOUND ON ACCOUNT');
process.exit(0);
