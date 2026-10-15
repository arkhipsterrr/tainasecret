import type { Page, Request, Response } from 'playwright';
import { PATHS, SELECTORS } from '../session/constants.ts';
import { classifyOutcome, type BuyStatus, type LayerVerdict } from './outcome.ts';
import type { ResearchLog, NetworkEntry } from '../research/recorder.ts';
import { requestEntry, responseEntry, shouldCaptureBody, readPageSignals } from './netlog.ts';
import { formatTiming, timed } from '../session/browser.ts';
import { normalizeMercariUrl } from '../validation.ts';
import { parseJpyDigits, type Plan, type Preview, type BuyOutcome } from './types.ts';

/**
 * The subset of Session the client drives. Decouples the client from the
 * concrete Session (and makes the buy/preview dispatch unit-testable with a
 * fake). `withPage` optionally parks the page under `parkAs` for later reuse;
 * `withParkedPage` reuses a matching parked page if one is still valid.
 */
export interface PageRunner {
  withPage<T>(fn: (page: Page) => Promise<T>, parkAs?: string): Promise<T>;
  withParkedPage<T>(key: string, fn: (page: Page) => Promise<T>): Promise<{ hit: boolean; result?: T }>;
}

export type { BuyOutcome } from './types.ts';

// Plan A ("150 JPY/order") is the operator's default. Confirm the exact radio
// value with scripts/dump-purchase.ts against a live session; recon strongly
// suggests "1" (the default non-selected submit used "2").
const PLAN_A_DEFAULT = '1';
const DOMAIN = 'j-subculture.com';

/**
 * Read the Mercari item price (JPY) from the order table's "Price" row.
 *
 * IMPORTANT: never scan for the largest ¥ number on the page — the direct-
 * purchase page ALSO renders the account's deposit balance ("Your total
 * deposit, including locked funds, is …"), which is unrelated to the item and
 * would wildly overprice the order. The item price lives in the row whose
 * `<th>` is exactly "Price", inside `.cur-price-main .num`.
 */
async function readItemPriceJPY(page: Page): Promise<number | null> {
  const raw = await page.evaluate(() => {
    const th = Array.from(document.querySelectorAll('th'))
      .find((el) => (el.textContent ?? '').trim() === 'Price');
    const td = th?.nextElementSibling as HTMLElement | null;
    return td?.querySelector('.cur-price-main .num')?.textContent ?? '';
  }).catch(() => '');
  return parseJpyDigits(raw);
}

interface LogInfo {
  status: string;
  priceJPY: number | null;
  plan: string | null;
  // Layered outcome (url + logical) for triage — see classifyOutcome.
  urlVerdict?: LayerVerdict;
  logicalVerdict?: LayerVerdict;
  outcomeReason?: string;
}

export class JsubClient {
  constructor(private session: PageRunner, private baseUrl: string, private recorder?: ResearchLog) {}

  /** Canonical key both preview (park) and buy (reuse) agree on. */
  private parkKey(mercariUrl: string): string {
    try { return normalizeMercariUrl(mercariUrl); } catch { return mercariUrl; }
  }

  private async openPurchasePage(page: Page, mercariUrl: string): Promise<void> {
    const t0 = performance.now();
    await page.goto(this.baseUrl + PATHS.directPurchase(mercariUrl), { waitUntil: 'domcontentloaded' });
    console.log(formatTiming('openPurchasePage', performance.now() - t0));
    if (page.url().includes('/users/personal-edit')) throw new Error('profile_incomplete');
    if (page.url().includes('/users/login')) throw new Error('needs_login');
  }

  private async readPlans(page: Page): Promise<Plan[]> {
    return page.$$eval(SELECTORS.planRadios, (els) =>
      els.map((e) => ({
        value: (e as HTMLInputElement).value,
        label: ((e.closest('label') as HTMLElement)?.innerText ?? '').trim().slice(0, 80),
      })));
  }

  /**
   * Run `fn` against the page while (optionally) capturing network + HTML and
   * appending a research record. `fn` returns the caller's result plus the log
   * fields to record. Records on both success and error.
   */
  private async recorded<T>(
    action: string,
    url: string,
    page: Page,
    fn: (runId: string | null) => Promise<{ result: T; log: LogInfo }>,
  ): Promise<T> {
    const net: NetworkEntry[] = [];
    // Response bodies are read asynchronously; collect the in-flight reads so
    // dump() can await them before serializing `net`.
    const pending: Promise<void>[] = [];
    let runId: string | null = null;
    // Keep handler refs so they can be detached: a parked page survives across
    // preview→buy, so leaving listeners attached would double-count and leak.
    let reqHandler: ((req: Request) => void) | undefined;
    let respHandler: ((resp: Response) => void) | undefined;
    if (this.recorder) {
      runId = this.recorder.newRunId();
      reqHandler = (req) => {
        if (!req.url().includes(DOMAIN)) return;
        net.push(requestEntry(new Date().toISOString(), req));
      };
      respHandler = (resp) => {
        if (!resp.url().includes(DOMAIN)) return;
        const capture = shouldCaptureBody(resp.status(), resp.request().method());
        pending.push((async () => {
          const body = capture ? await resp.text().catch(() => null) : null;
          net.push(responseEntry(new Date().toISOString(), resp, body));
        })());
      };
      page.on('request', reqHandler);
      page.on('response', respHandler);
    }
    const dump = async (status: string, log: Partial<LogInfo>, error: string | null) => {
      if (!this.recorder || !runId) return;
      await Promise.allSettled(pending);
      const html = await page.content().catch(() => '');
      const signals = await readPageSignals(page);
      await this.recorder.saveArtifacts(runId, { html, network: net });
      await this.recorder.writeRecord({
        ts: new Date().toISOString(),
        action,
        url,
        status,
        priceJPY: log.priceJPY ?? null,
        plan: log.plan ?? null,
        finalUrl: page.url(),
        error,
        runId,
        title: signals.title,
        alert: signals.alert,
        urlVerdict: log.urlVerdict ?? null,
        logicalVerdict: log.logicalVerdict ?? null,
        outcomeReason: log.outcomeReason ?? null,
      });
    };
    try {
      const { result, log } = await fn(runId);
      await dump(log.status, log, null);
      return result;
    } catch (e) {
      await dump('error', {}, (e as Error).message);
      throw e;
    } finally {
      if (reqHandler) page.off('request', reqHandler);
      if (respHandler) page.off('response', respHandler);
    }
  }

  async preview(mercariUrl: string): Promise<Preview> {
    // Park the loaded purchase page so an immediate buy for the same item can
    // reuse it (skips a full re-navigation — the snipe path).
    return timed('preview', () => this.session.withPage((page) =>
      this.recorded<Preview>('preview', mercariUrl, page, async () => {
        await this.openPurchasePage(page, mercariUrl);
        const title = (await page.locator(SELECTORS.titleField).inputValue().catch(() => '')) || '';
        const priceJPY = await readItemPriceJPY(page);
        const plans = await this.readPlans(page);
        return { result: { title, priceJPY, plans, balanceHint: null }, log: { status: 'previewed', priceJPY, plan: null } };
      }), this.parkKey(mercariUrl)));
  }

  async buy(
    mercariUrl: string,
    opts: { plan?: string; maxPriceJPY?: number },
  ): Promise<BuyOutcome> {
    return timed('buy', async () => {
      const key = this.parkKey(mercariUrl);
      // First try a parked preview page. `withParkedPage` returns hit:false ONLY
      // on a true miss (no page touched); if it ran the buy and then threw, the
      // error propagates and we must NOT retry a fresh navigation — that would be
      // a double buy.
      const attempt = await this.session.withParkedPage<BuyOutcome>(key, (page) =>
        this.recorded<BuyOutcome>('buy', mercariUrl, page, (runId) => this.completeBuy(page, opts, runId)));
      if (attempt.hit) return attempt.result!;

      // True miss: no valid parked page. Navigate fresh.
      return this.session.withPage<BuyOutcome>((page) =>
        this.recorded<BuyOutcome>('buy', mercariUrl, page, async (runId) => {
          await this.openPurchasePage(page, mercariUrl);
          return this.completeBuy(page, opts, runId);
        }));
    });
  }

  /**
   * The purchase steps on an already-loaded direct-purchase page: read price,
   * enforce the cap, select plan + agreement, click, classify. Shared by the
   * parked-page and fresh-navigation buy paths.
   */
  private async completeBuy(
    page: Page,
    opts: { plan?: string; maxPriceJPY?: number },
    runId: string | null,
  ): Promise<{ result: BuyOutcome; log: LogInfo }> {
    const priceJPY = await readItemPriceJPY(page);
    const planValue = opts.plan ?? PLAN_A_DEFAULT;

    if (opts.maxPriceJPY != null && priceJPY != null && priceJPY > opts.maxPriceJPY) {
      const result = { status: 'price_exceeded' as const, finalUrl: page.url(), runId };
      return { result, log: { status: 'price_exceeded', priceJPY, plan: planValue } };
    }

    const planRadio = page.locator(`${SELECTORS.planRadios}[value="${planValue}"]`);
    if (await planRadio.count() === 0) throw new Error('plan_not_found');
    await planRadio.check();

    const agreement = page.locator(SELECTORS.agreement);
    if (await agreement.count() === 0) throw new Error('agreement_missing');
    await agreement.check();

    const buyBtn = page.locator(SELECTORS.buyButton);
    if (await buyBtn.count() === 0) throw new Error('buy_button_missing');

    const tClick = performance.now();
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      buyBtn.click(),
    ]);
    console.log(formatTiming('buy.clickNav', performance.now() - tClick));

    // Classify from BOTH the landing URL and the page alert. The `-fin`
    // finish page is identical on success and failure, so the alert
    // ("Successfully purchased the item on Mercari.") is the authoritative
    // signal — a URL-only verdict refunds genuinely paid orders.
    const finalUrl = page.url();
    const { alert } = await readPageSignals(page);
    const outcome = classifyOutcome({ url: finalUrl, alert });
    const result = { status: outcome.status, finalUrl, runId };
    return {
      result,
      log: {
        status: outcome.status, priceJPY, plan: planValue,
        urlVerdict: outcome.url, logicalVerdict: outcome.logical, outcomeReason: outcome.reason,
      },
    };
  }
}
