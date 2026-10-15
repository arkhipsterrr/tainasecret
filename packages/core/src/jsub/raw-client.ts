import { PATHS } from '../session/constants.ts';
import { parsePurchasePage, buildBuyBody, readHtmlSignals } from './parse.ts';
import { orderForMercariUrl, type OrderRow } from './orders.ts';
import { classifyOutcome } from './outcome.ts';
import { timed } from '../session/browser.ts';
import type { Preview, BuyOutcome } from './types.ts';
import type { ResearchLog, NetworkEntry } from '../research/recorder.ts';

const BODY_LIMIT = 3000;
/** The subset of ResearchLog the raw client needs (kept narrow for tests). */
export type RawRecorder = Pick<ResearchLog, 'newRunId' | 'saveArtifacts' | 'writeRecord'>;

interface RecordData {
  runId: string | null;
  html: string;
  net: NetworkEntry[];
  status: string;
  finalUrl: string;
  priceJPY: number | null;
  alert: string | null;
  urlVerdict?: string | null;
  logicalVerdict?: string | null;
  reason?: string | null;
  error: string | null;
}

// Plan A ("150 JPY/order") — the operator's default, same as the browser client.
const PLAN_A_DEFAULT = '1';

// A minimal fetch surface so the client is transport-agnostic and unit-testable
// with a fake. Production injects undici's fetch (optionally over a SOCKS
// dispatcher for the tunnel); tests inject a stub.
export interface RawResponse {
  status: number;
  url: string;
  text(): Promise<string>;
}
export interface RawFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse>;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/**
 * Browserless j-subculture client: preview/buy over plain HTTP using the saved
 * session cookies. One request instead of a full Chromium render (~46 requests).
 * Login stays browser-only (reCAPTCHA); this reuses that session's cookies.
 */
export class RawJsubClient {
  constructor(
    private baseUrl: string,
    /** Current session cookie header, re-read each call so a re-import is picked up. */
    private cookieHeader: () => string,
    private fetchFn: RawFetch,
    /** Optional research recorder: saves the page HTML + request/response log per run. */
    private recorder?: RawRecorder,
  ) {}

  private reqEntry(method: string, url: string, body: string | null): NetworkEntry {
    return { ts: new Date().toISOString(), kind: 'request', method, url, resType: 'document', post: body ? body.slice(0, BODY_LIMIT) : null };
  }

  private respEntry(method: string, resp: RawResponse, body: string): NetworkEntry {
    return { ts: new Date().toISOString(), kind: 'response', method, url: resp.url, resType: 'document', post: null, status: resp.status, respBody: body ? body.slice(0, BODY_LIMIT) : null };
  }

  /** Persist the run: final page HTML + network log + one JSON record. No-op without a recorder. */
  private async record(action: string, url: string, d: RecordData): Promise<void> {
    if (!this.recorder || !d.runId) return;
    await this.recorder.saveArtifacts(d.runId, { html: d.html, network: d.net });
    await this.recorder.writeRecord({
      ts: new Date().toISOString(), action, url, status: d.status,
      priceJPY: d.priceJPY, plan: null, finalUrl: d.finalUrl, error: d.error, runId: d.runId,
      alert: d.alert, urlVerdict: d.urlVerdict ?? null, logicalVerdict: d.logicalVerdict ?? null,
      outcomeReason: d.reason ?? null,
    });
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
      cookie: this.cookieHeader(),
      ...extra,
    };
  }

  /** Assert the response is an authenticated purchase page, not a redirect away. */
  private assertAuthed(resp: RawResponse): void {
    if (resp.url.includes('/users/personal-edit')) throw new Error('profile_incomplete');
    if (resp.url.includes('/users/login')) throw new Error('needs_login');
  }

  async preview(mercariUrl: string): Promise<Preview> {
    return timed('preview', async () => {
      const runId = this.recorder?.newRunId() ?? null;
      const url = this.baseUrl + PATHS.directPurchase(mercariUrl);
      const net: NetworkEntry[] = [this.reqEntry('GET', url, null)];
      const resp = await this.fetchFn(url, { headers: this.headers() });
      const html = await resp.text();
      net.push(this.respEntry('GET', resp, html));
      try {
        this.assertAuthed(resp);
        const preview = parsePurchasePage(html);
        await this.record('preview', mercariUrl, {
          runId, html, net, status: 'previewed', finalUrl: resp.url,
          priceJPY: preview.priceJPY, alert: readHtmlSignals(html).alert, error: null,
        });
        return preview;
      } catch (e) {
        await this.record('preview', mercariUrl, {
          runId, html, net, status: 'error', finalUrl: resp.url, priceJPY: null, alert: null, error: (e as Error).message,
        });
        throw e;
      }
    });
  }

  async buy(mercariUrl: string, opts: { plan?: string; maxPriceJPY?: number }): Promise<BuyOutcome> {
    return timed('buy', async () => {
      const runId = this.recorder?.newRunId() ?? null;
      const net: NetworkEntry[] = [];
      const getUrl = this.baseUrl + PATHS.directPurchase(mercariUrl);
      // `page`/`postHtml` accumulate so the catch can still dump the last page we saw.
      let page = '';
      let postHtml = '';
      let priceJPY: number | null = null;
      let alert: string | null = null;
      let finalUrl = getUrl;
      try {
        // 1) GET the purchase page for fresh form defaults + the current price.
        net.push(this.reqEntry('GET', getUrl, null));
        const getResp = await this.fetchFn(getUrl, { headers: this.headers() });
        page = await getResp.text();
        net.push(this.respEntry('GET', getResp, page));
        finalUrl = getResp.url;
        this.assertAuthed(getResp);

        // 2) Price cap — fail CLOSED if the price can't be read (avoids the C2 bug
        // where a null price silently skipped the guard and bought at any price).
        priceJPY = parsePurchasePage(page).priceJPY;
        if (opts.maxPriceJPY != null) {
          if (priceJPY == null) throw new Error('price_unavailable');
          if (priceJPY > opts.maxPriceJPY) {
            await this.record('buy', mercariUrl, { runId, html: page, net, status: 'price_exceeded', finalUrl, priceJPY, alert: null, error: null });
            return { status: 'price_exceeded', finalUrl, runId };
          }
        }

        // 3) Build the POST body from the page's OWN form (plan + agreement only).
        const form = buildBuyBody(page, { plan: opts.plan ?? PLAN_A_DEFAULT });
        if (!form) throw new Error('buy_form_missing');
        // The action comes from the (untrusted) upstream HTML. Pin it to the base
        // origin before POSTing — an absolute off-origin action would otherwise
        // carry the session cookie to an attacker host.
        const actionUrl = new URL(form.action, this.baseUrl);
        if (actionUrl.origin !== new URL(this.baseUrl).origin) throw new Error('buy_form_offsite');
        const action = actionUrl.toString();

        // 4) Submit and classify the response by URL + alert (same logic as browser).
        net.push(this.reqEntry('POST', action, form.body));
        const postResp = await this.fetchFn(action, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
          body: form.body,
        });
        postHtml = await postResp.text();
        net.push(this.respEntry('POST', postResp, postHtml));
        finalUrl = postResp.url;
        alert = readHtmlSignals(postHtml).alert;
        const outcome = classifyOutcome({ url: finalUrl, alert });
        await this.record('buy', mercariUrl, {
          runId, html: postHtml, net, status: outcome.status, finalUrl, priceJPY, alert,
          urlVerdict: outcome.url, logicalVerdict: outcome.logical, reason: outcome.reason, error: null,
        });
        return { status: outcome.status, finalUrl, runId };
      } catch (e) {
        await this.record('buy', mercariUrl, {
          runId, html: postHtml || page, net, status: 'error', finalUrl, priceJPY, alert, error: (e as Error).message,
        });
        // Surface the runId on the error so the caller's failure/refund records
        // can still link to this run's saved page + network log.
        if (runId != null && e instanceof Error) (e as Error & { runId?: string }).runId = runId;
        throw e;
      }
    });
  }

  /**
   * Slow, authoritative confirmation: poll the orders list for the order placed
   * for `mercariUrl`. Unlike the buy POST's flash alert (missing on the byte-
   * identical `-fin` page), an order appearing here PROVES the purchase went
   * through. The order can take a few seconds to show up after payment, so we
   * poll `attempts` times with `delayMs` between. Returns the matched order as
   * soon as it appears, or null once the budget is spent. `sleep` is injected so
   * tests run without real delays.
   */
  async confirmViaOrders(
    mercariUrl: string,
    opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<OrderRow | null> {
    const attempts = opts.attempts ?? 6;
    const delayMs = opts.delayMs ?? 3000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = this.baseUrl + PATHS.orders;
    return timed('confirm-orders', async () => {
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(delayMs);
        const resp = await this.fetchFn(url, { headers: this.headers() });
        const html = await resp.text();
        this.assertAuthed(resp);
        const order = orderForMercariUrl(html, mercariUrl);
        if (order) return order;
      }
      return null;
    });
  }
}
