import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import type { Config } from '../config.ts';
import { PATHS } from './constants.ts';
import { classifyAlive, type AliveReason } from './alive.ts';
import { shouldBlockResource, needsRebuild, formatTiming, parkedHit, timed } from './browser.ts';

export class Session {
  private lock: Promise<unknown> = Promise.resolve();
  // Warm browser: launched once and kept alive across operations. Rebuilt only
  // when the process dies or the storage state changes on disk. Removes the
  // 1–3 s cold Chromium launch from every preview/buy.
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private ctxStateMtimeMs: number | null = null;
  // A single parked page from the last preview, reusable by an immediate buy
  // for the same item (the snipe path). Short TTL so slow clicks fall back to a
  // fresh — and thus fresher — navigation.
  private parked: { key: string; page: Page; expiresAt: number } | null = null;
  private static readonly PARK_TTL_MS = 90_000;

  constructor(private cfg: Config) {}

  private url(path: string): string {
    return this.cfg.baseUrl + path;
  }

  private proxyOpt() {
    return this.cfg.proxyUrl ? { server: this.cfg.proxyUrl } : undefined;
  }

  /**
   * Launch a headed persistent browser and wait for the human to log in
   * (including solving reCAPTCHA). Saves the authenticated storageState.
   */
  async login(): Promise<void> {
    const ctx = await chromium.launchPersistentContext('.pw-user', {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
      proxy: this.proxyOpt(),
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(this.url(PATHS.login));
    // Human logs in + solves reCAPTCHA. Wait until we leave the login page.
    await page.waitForURL((u) => !u.pathname.includes('/users/login'), { timeout: 5 * 60_000 });
    await ctx.storageState({ path: this.cfg.storageStatePath });
    await ctx.close();
  }

  /**
   * Return the warm authenticated context, launching/rebuilding it only when
   * necessary. Blocks image/media/font requests to spare the SOCKS tunnel.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (!existsSync(this.cfg.storageStatePath)) throw new Error('needs_login');
    const mtime = statSync(this.cfg.storageStatePath).mtimeMs;
    const state = {
      connected: this.browser?.isConnected() ?? false,
      hasContext: this.ctx != null,
      builtMtimeMs: this.ctxStateMtimeMs,
    };
    if (needsRebuild(state, mtime)) {
      await this.dispose();
      const t0 = performance.now();
      this.browser = await chromium.launch({ headless: true, proxy: this.proxyOpt() });
      this.ctx = await this.browser.newContext({ storageState: this.cfg.storageStatePath });
      await this.ctx.route('**/*', (route) => {
        if (shouldBlockResource(route.request().resourceType())) return route.abort();
        return route.continue();
      });
      this.ctxStateMtimeMs = mtime;
      console.log(formatTiming('browser.launch', performance.now() - t0));
    }
    return this.ctx!;
  }

  /** Tear down the warm browser (and its context + parked page). Safe anytime. */
  async dispose(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.ctx = null;
    this.ctxStateMtimeMs = null;
    this.parked = null; // closing the browser closes all its pages
    await b?.close().catch(() => undefined);
  }

  /** Keep `page` open and park it under `key`, evicting any previous parked page. */
  private async parkPage(key: string, page: Page): Promise<void> {
    const prev = this.parked;
    this.parked = { key, page, expiresAt: Date.now() + Session.PARK_TTL_MS };
    if (prev && prev.page !== page) await prev.page.close().catch(() => undefined);
  }

  /**
   * Load an authenticated-only page and classify the result.
   * `reason` distinguishes a healthy login from an expired session
   * (`logged_out`) and a WAF/proxy block (`waf_blocked`) — the latter used to
   * be misreported as logged-in because the 403 page doesn't redirect.
   */
  async isAlive(): Promise<{ loggedIn: boolean; username: string | null; reason: AliveReason }> {
    try {
      return await timed('session.isAlive', () => this.withPage(async (page) => {
        const resp = await page.goto(this.url(PATHS.myPage), { waitUntil: 'domcontentloaded' });
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const { loggedIn, reason } = classifyAlive({
          status: resp?.status() ?? 0,
          finalUrl: page.url(),
          bodyText,
        });
        // username extraction is best-effort and non-critical; left null for now.
        return { loggedIn, username: null, reason };
      }));
    } catch {
      return { loggedIn: false, username: null, reason: 'unknown' as AliveReason };
    }
  }

  /**
   * Run `fn` with an authenticated page on the warm context. Serialized: one at
   * a time. If `parkAs` is given and `fn` succeeds, the page is kept open and
   * parked under that key for later reuse instead of being closed.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>, parkAs?: string): Promise<T> {
    const run = async (): Promise<T> => {
      const ctx = await this.ensureContext();
      const t0 = performance.now();
      let page: Page | undefined;
      let parked = false;
      try {
        page = await ctx.newPage();
        const result = await fn(page);
        if (parkAs && page) { await this.parkPage(parkAs, page); parked = true; }
        return result;
      } catch (e) {
        // If the browser died (tunnel drop, crash), drop the warm handles so the
        // next call rebuilds instead of reusing a dead context.
        if (!this.browser?.isConnected()) await this.dispose();
        throw e;
      } finally {
        if (!parked) await page?.close().catch(() => undefined);
        console.log(formatTiming('withPage', performance.now() - t0));
      }
    };
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }

  /**
   * If a valid parked page exists for `key`, run `fn` on it (serialized) and
   * return `{ hit: true, result }`; the page is consumed (closed) afterwards.
   * On any miss — no parked page, wrong key, expired, closed, or a session
   * re-import that rebuilt the context — return `{ hit: false }` WITHOUT running
   * `fn`, so the caller can safely fall back to a fresh navigation. Once `fn`
   * runs, its result or error is propagated (never a silent fallback).
   */
  async withParkedPage<T>(key: string, fn: (page: Page) => Promise<T>): Promise<{ hit: boolean; result?: T }> {
    const run = async (): Promise<{ hit: boolean; result?: T }> => {
      // Honor a session re-import first: a changed storage state rebuilds the
      // context here and disposes the parked page → clean miss, fresh nav.
      await this.ensureContext();
      const slot = this.parked;
      if (!parkedHit(slot, key, Date.now())) {
        if (slot) { this.parked = null; await slot.page.close().catch(() => undefined); }
        return { hit: false };
      }
      this.parked = null; // a parked page is used at most once
      const page = slot!.page;
      if (page.isClosed()) return { hit: false };
      const t0 = performance.now();
      try {
        const result = await fn(page);
        return { hit: true, result };
      } catch (e) {
        if (!this.browser?.isConnected()) await this.dispose();
        throw e;
      } finally {
        await page.close().catch(() => undefined);
        console.log(formatTiming('withParkedPage', performance.now() - t0));
      }
    };
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }

  async logout(): Promise<void> {
    if (existsSync(this.cfg.storageStatePath)) {
      await rm(this.cfg.storageStatePath);
    }
  }
}
