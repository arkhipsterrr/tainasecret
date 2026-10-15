import type { JsubClient, OrderRow } from '@arhip/core';
import { PurchaseQueue, costKopecks, type PricingConfig } from '@arhip/core';
import type { BalancesRepo, PurchasesRepo, RefundRequestsRepo, Db } from '@arhip/db';

export interface BuyLogFields {
  outcome: 'ok' | 'fail';
  telegramId: number;
  url: string;
  priceJpy: number;
  costKopecks: number;
  maxPriceJpy: number;
  jsubStatus?: string;
  finalUrl?: string | null;
  runId?: string | null;
  error?: string | null;
}

/**
 * One-line, greppable diagnostic for every buy attempt (success and failure).
 * runId links the line to the saved page HTML + network artifacts under
 * runsDir/<runId>/. Missing optionals render empty, never "undefined".
 */
export function formatBuyLog(f: BuyLogFields): string {
  const v = (x: unknown) => (x === undefined || x === null ? '' : String(x));
  return (
    `buy ${f.outcome}: user=${f.telegramId} url=${f.url} priceJpy=${f.priceJpy} ` +
    `cost=${f.costKopecks} maxPriceJpy=${f.maxPriceJpy} jsubStatus=${v(f.jsubStatus)} ` +
    `finalUrl=${v(f.finalUrl)} runId=${v(f.runId)} error=${v(f.error)}`
  );
}

export interface BuyContext {
  db: Db;
  // `confirmViaOrders` is the slow, authoritative check (RawJsubClient only):
  // for an ambiguous outcome it looks the order up in /en/orders. Optional so
  // the browser client (which lacks it) still works, falling back to a refund.
  client: Pick<JsubClient, 'buy'> & {
    confirmViaOrders?: (mercariUrl: string) => Promise<OrderRow | null>;
  };
  balances: BalancesRepo;
  purchases: PurchasesRepo;
  refunds: RefundRequestsRepo;
  queue: PurchaseQueue;
  pricing: PricingConfig;
  // Per-url in-flight guard (a single shared Map, created once alongside the
  // queue). A buy stays "in flight" from the moment it holds funds until its
  // outcome is fully settled — INCLUDING the slow orders-confirmation that runs
  // outside the queue. A concurrent buy for the SAME url waits for it, so
  // client.buy is never fired twice for one url (no duplicate vendor purchase).
  inflight: Map<string, Promise<void>>;
}

export type BuyResult =
  | { status: 'bought'; costKopecks: number; finalUrl?: string }
  | { status: 'insufficient' }
  | { status: 'not_active' }
  | { status: 'already_bought' }
  // Shop-side deposit empty (/deposits/choose): the buy definitively did NOT go
  // through, so the user's hold is auto-refunded immediately (no admin gate).
  | { status: 'insufficient_shop'; costKopecks: number }
  // Failed/ambiguous buy: money is NOT auto-refunded — a refund request is
  // opened for an admin to approve/reject. `reason` is the underlying jsub
  // status ('price_exceeded' | 'error' | 'threw').
  | { status: 'refund_pending'; requestId: number; costKopecks: number; reason: string; url: string };

// Sentinel returned from the queued job when the url was already bought by the
// time the job ran (i.e. a concurrent call beat us).
const ALREADY_BOUGHT_LATE = Symbol('already_bought_late');
type QueuedResult = Awaited<ReturnType<JsubClient['buy']>> | typeof ALREADY_BOUGHT_LATE;

export async function buyForUser(
  ctx: BuyContext, telegramId: number, url: string, priceJpy: number,
  // Fired once when an ambiguous buy enters the slow orders-validation phase, so
  // the caller can tell the user "order placed — validating" instead of leaving
  // them on "buying…" for the whole poll. Never fired for a clean bought.
  onValidating?: () => void | Promise<void>,
): Promise<BuyResult> {
  // Fast-path: skip the hold entirely if already bought.
  if (ctx.purchases.isBought(url)) return { status: 'already_bought' };

  // Single-flight per url: if a buy for this url is already in flight (its
  // outcome, including the out-of-queue orders-confirmation, is not yet
  // settled), wait for it and then re-check. This is what stops a second
  // concurrent buy from firing client.buy again — the in-queue isBought re-check
  // alone is insufficient because the `bought` row is written only after the
  // ambiguous-settle poll, a window during which the second job would slip past.
  const inFlight = ctx.inflight.get(url);
  if (inFlight) {
    await inFlight;
    if (ctx.purchases.isBought(url)) return { status: 'already_bought' };
    // The in-flight buy did NOT end in a bought row (it failed / is refund-
    // pending). Fall through and make our own attempt.
  }

  let releaseInFlight!: () => void;
  const inFlightGate = new Promise<void>((resolve) => { releaseInFlight = resolve; });
  ctx.inflight.set(url, inFlightGate);

  try {
    const cost = costKopecks(priceJpy, ctx.pricing);
    const held = ctx.balances.hold(telegramId, cost, url);
    if (!held.ok) return { status: held.reason === 'insufficient' ? 'insufficient' : 'not_active' };

    // Settle a confirmed purchase: record the bought row and finalize the hold
    // atomically (a crash between them would leave a bought row unsettled).
    const recordBought = (runId: string | null, finalUrl?: string): BuyResult => {
      ctx.db.transaction(() => {
        ctx.purchases.record({ telegramId, mercariUrl: url, priceJpy, costRub: cost, status: 'bought', runId });
        ctx.balances.finalizePurchase(telegramId, cost, url);
      })();
      return { status: 'bought', costKopecks: cost, finalUrl };
    };

    // Failed/ambiguous buy: keep the hold debited, record the attempt, and open a
    // refund request an admin must approve — never auto-refund (that is how "money
    // back AND item bought" happened).
    const openRefund = (reason: string, runId: string | null): BuyResult => {
      const requestId = ctx.db.transaction(() => {
        ctx.purchases.record({ telegramId, mercariUrl: url, priceJpy, costRub: cost, status: 'failed', runId });
        return ctx.refunds.create({ telegramId, mercariUrl: url, kopecks: cost, reason, runId });
      })();
      return { status: 'refund_pending', requestId, costKopecks: cost, reason, url };
    };

    // 'error'/'threw' are ambiguous — the submit MAY have paid. The orders list is
    // the authoritative tie-breaker: if the order shows up there, settle as bought
    // instead of refunding. Runs OUTSIDE the queue (we're past the enqueue await),
    // so other users' buys aren't blocked by the slow poll — but the single-flight
    // guard above keeps a same-url buy from racing this window.
    const settleAmbiguous = async (reason: string, runId: string | null): Promise<BuyResult> => {
      if (ctx.client.confirmViaOrders) {
        await onValidating?.();
        let order: OrderRow | null = null;
        try { order = await ctx.client.confirmViaOrders(url); } catch { /* unreadable → treat as unconfirmed */ }
        if (order) {
          console.log(formatBuyLog({
            outcome: 'ok', telegramId, url, priceJpy, costKopecks: cost, maxPriceJpy: priceJpy,
            jsubStatus: `confirmed-via-orders:${order.status}`, runId,
          }));
          return recordBought(runId);
        }
      }
      console.error(formatBuyLog({
        outcome: 'fail', telegramId, url, priceJpy, costKopecks: cost, maxPriceJpy: priceJpy, jsubStatus: reason, runId,
      }));
      return openRefund(reason, runId);
    };

    try {
      // The queue serializes all buy jobs.  Re-check isBought INSIDE the job so
      // that two concurrent buyForUser calls for the same url cannot both run
      // client.buy — the second one will see the url already bought and bail out.
      const result: QueuedResult = await ctx.queue.enqueue(async (): Promise<QueuedResult> => {
        if (ctx.purchases.isBought(url)) return ALREADY_BOUGHT_LATE;
        return ctx.client.buy(url, { maxPriceJPY: priceJpy });
      });

      if (result === ALREADY_BOUGHT_LATE) {
        // A concurrent call already bought this url; refund our hold and bail.
        ctx.balances.refund(telegramId, cost, url);
        return { status: 'already_bought' };
      }

      if (result.status === 'bought') {
        console.log(formatBuyLog({
          outcome: 'ok', telegramId, url, priceJpy, costKopecks: cost, maxPriceJpy: priceJpy,
          jsubStatus: result.status, finalUrl: result.finalUrl, runId: result.runId ?? null,
        }));
        return recordBought(result.runId ?? null, result.finalUrl);
      }
      // An 'error' outcome is ambiguous (a `-fin` landing without a success alert
      // — the payment may well have gone through), so confirm against the orders
      // list before deciding. A clean price_exceeded / insufficient_balance means
      // no order was placed, so refund straight away (still admin-approved).
      // NOTE: `return await` (not bare `return`) is required so the single-flight
      // `finally` below releases the url only AFTER the slow orders-confirmation
      // completes — otherwise a waiting same-url buy wakes mid-poll, sees no
      // bought row yet, and buys again.
      if (result.status === 'error') return await settleAmbiguous('error', result.runId ?? null);
      if (result.status === 'insufficient_balance') {
        // Shop deposit empty (/deposits/choose): a DETERMINISTIC no-purchase, so
        // auto-refund the user now instead of holding funds behind an admin gate
        // (the gate is only for AMBIGUOUS outcomes where the item MAY have paid).
        ctx.balances.refund(telegramId, cost, url);
        ctx.purchases.record({ telegramId, mercariUrl: url, priceJpy, costRub: cost, status: 'failed', runId: result.runId ?? null });
        console.error(formatBuyLog({
          outcome: 'fail', telegramId, url, priceJpy, costKopecks: cost, maxPriceJpy: priceJpy,
          jsubStatus: 'insufficient_balance', finalUrl: (result as any).finalUrl ?? null, runId: result.runId ?? null,
        }));
        return { status: 'insufficient_shop', costKopecks: cost };
      }
      console.error(formatBuyLog({
        outcome: 'fail', telegramId, url, priceJpy, costKopecks: cost, maxPriceJpy: priceJpy,
        jsubStatus: result.status, finalUrl: (result as any).finalUrl ?? null, runId: result.runId ?? null,
      }));
      return openRefund(result.status, result.runId ?? null);
    } catch (e) {
      // A thrown buy is the most ambiguous case — the submit click may have gone
      // through — so it too is confirmed against the orders list before refunding.
      // The client attaches the runId to the error so records link to its evidence.
      const runId = (e as { runId?: string })?.runId ?? null;
      return await settleAmbiguous('threw', runId); // `await`: see the note above — keep the url held until settled
    }
  } finally {
    // Release the url only after the outcome is fully settled, so a waiter sees
    // the final bought/failed state (not the mid-flight window).
    ctx.inflight.delete(url);
    releaseInFlight();
  }
}
