// Pure jsub types + helpers shared by the browser client and the raw-HTTP
// client. Kept free of Playwright so the raw path never loads a browser.

import type { BuyStatus } from './outcome.ts';

export type Plan = { value: string; label: string };
export type Preview = { title: string; priceJPY: number | null; plans: Plan[]; balanceHint: string | null };

/** Result of a buy attempt, shared by the browser and raw-HTTP clients. */
export type BuyOutcome = { status: BuyStatus; finalUrl: string; runId: string | null };

/** Parse a JPY amount string like "2,600 JPY" / "¥73,500" → 2600 / 73500. */
export function parseJpyDigits(text: string): number | null {
  const digits = (text ?? '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}
