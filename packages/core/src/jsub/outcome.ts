export type BuyStatus = 'bought' | 'insufficient_balance' | 'price_exceeded' | 'error';

/** A single layer's read of the outcome. `inconclusive` = this layer can't tell. */
export type LayerVerdict = 'bought' | 'insufficient_balance' | 'error' | 'inconclusive';

export interface OutcomeInput {
  /** The post-submit landing URL. */
  url: string;
  /** Visible page alert/flash text captured after the submit (from readPageSignals). */
  alert?: string | null;
}

export interface Outcome {
  /** Final decision, combining the layers below. */
  status: 'bought' | 'insufficient_balance' | 'error';
  /** What the URL alone implies. */
  url: LayerVerdict;
  /** What the page content (alert text) implies — authoritative for `-fin`. */
  logical: LayerVerdict;
  /** Human-readable explanation for triage/logs. */
  reason: string;
}

// The proxy site shows this exact flash on a genuinely paid Instant Purchase.
// It is the ONLY trustworthy success signal: the landing URL (`-fin`) is byte-
// identical whether the payment went through or not (confirmed 2026-09-13 an
// empty-alert `-fin` did NOT pay; 2026-09-14 a success-alert `-fin` did).
const SUCCESS_ALERT = /successfully purchased the item on mercari/i;

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

/** Layer 1 — what the landing URL alone says. `-fin` is deliberately inconclusive. */
function urlVerdict(path: string): LayerVerdict {
  if (path.includes('/deposits/choose')) return 'insufficient_balance';
  if (path.includes('mercari-direct-purchase-fin')) return 'inconclusive';
  if (/\/shoppings\/(complete|thanks)/.test(path)) return 'bought';
  return 'error';
}

/** Layer 2 — what the page alert text says. Only a positive success alert counts. */
function logicalVerdict(alert: string | null | undefined): LayerVerdict {
  if (alert && SUCCESS_ALERT.test(alert)) return 'bought';
  return 'inconclusive';
}

/**
 * Classify a buy outcome from two independent layers and combine them.
 *
 * Success requires POSITIVE confirmation — never inferred from a bare redirect:
 *  - the logical layer (a genuine "Successfully purchased" alert), or
 *  - an unambiguous success URL (`/shoppings/complete|thanks`).
 * The old classifier trusted the URL alone, so a `-fin` landing (identical on
 * success and failure) and even a `/mypage` bounce were misread — the former
 * refunded real paid orders, the latter reported phantom purchases.
 */
export function classifyOutcome(input: OutcomeInput): Outcome {
  const path = pathOf(input.url);
  const url = urlVerdict(path);
  const logical = logicalVerdict(input.alert);

  if (logical === 'bought') {
    return { status: 'bought', url, logical, reason: 'page alert confirms the purchase' };
  }
  if (url === 'bought') {
    return { status: 'bought', url, logical, reason: 'landed on a confirmed success page' };
  }
  if (url === 'insufficient_balance') {
    return { status: 'insufficient_balance', url, logical, reason: 'redirected to the deposit page' };
  }
  const reason = url === 'inconclusive'
    ? 'finish page without a success confirmation — payment did not go through'
    : `unexpected landing page: ${path}`;
  return { status: 'error', url, logical, reason };
}
