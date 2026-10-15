import { parse } from 'node-html-parser';
import { parseJpyDigits, type Plan, type Preview } from './types.ts';
import { ALERT_SELECTOR } from './netlog.ts';

const PLAN_RADIO_NAME = 'Other[plan_type_tmp]';
const TITLE_INPUT_NAME = 'Other[custom_title]';
const AGREEMENT_NAME = 'Other[agreement]';
const BUY_SUBMIT_NAME = 'order';

/**
 * Parse the direct-purchase page HTML into a Preview, without a browser.
 * Mirrors the DOM logic the Playwright client uses:
 *  - price = the row whose <th> is exactly "Price" → `.cur-price-main .num`
 *    (never the "Order Total" row, which would wildly overprice the order).
 *  - title = the value of input[name="Other[custom_title]"].
 *  - plans = each input[name="Other[plan_type_tmp]"] radio with its label text.
 * Degrades to empty/null on an unexpected page rather than throwing.
 */
export function parsePurchasePage(html: string): Preview {
  const root = parse(html);

  const priceTh = root.querySelectorAll('th').find((th) => th.text.trim() === 'Price');
  const priceTd = priceTh?.nextElementSibling ?? null;
  const priceText = priceTd?.querySelector('.cur-price-main .num')?.text ?? '';
  const priceJPY = parseJpyDigits(priceText);

  const title =
    root.querySelectorAll('input').find((i) => i.getAttribute('name') === TITLE_INPUT_NAME)
      ?.getAttribute('value') ?? '';

  const plans: Plan[] = root.querySelectorAll('input')
    .filter((i) => i.getAttribute('name') === PLAN_RADIO_NAME)
    .map((i) => ({
      value: i.getAttribute('value') ?? '',
      label: (i.closest('label')?.text ?? '').trim().slice(0, 80),
    }));

  return { title, priceJPY, plans, balanceHint: null };
}

/**
 * Build the urlencoded body for the buy POST from the page's OWN form, applying
 * exactly the two mutations the browser makes: select the chosen plan radio and
 * check the agreement box (and "click" the `order` submit). Every other field
 * keeps its page default — so we never opt into the paid photo service and never
 * guess postage. Faithfully reproduces a real browser submission.
 *
 * Returns null if the page has no buy form (e.g. a WAF/login page).
 */
export function buildBuyBody(html: string, opts: { plan: string }): { action: string; body: string } | null {
  // The live purchase page nests the buy <form> inside the site's search
  // <form>. Nested forms are invalid HTML, so node-html-parser (like a browser)
  // drops the inner one — `submit.closest('form')` then finds nothing and every
  // available buy fails with buy_form_missing. So locate the buy form by its raw
  // open tag (identified by the direct-purchase action) and parse JUST its
  // slice: a clean, standalone fragment the parser nests correctly.
  const open = html.match(/<form\b[^>]*\baction=(["'])([^"']*mercari-direct-purchase[^"']*)\1[^>]*>/i);
  if (open?.index == null) return null;
  const start = open.index + open[0].length;
  const close = html.indexOf('</form>', start);
  const form = parse(close >= 0 ? html.slice(start, close) : html.slice(start));

  const inputs = form.querySelectorAll('input');
  const hasBuySubmit = inputs.some(
    (i) => (i.getAttribute('type') ?? '').toLowerCase() === 'submit' && i.getAttribute('name') === BUY_SUBMIT_NAME);
  if (!hasBuySubmit) return null;

  const params = new URLSearchParams();
  for (const el of inputs) {
    const name = el.getAttribute('name');
    if (!name) continue;
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    const value = el.getAttribute('value') ?? '';
    const checked = el.getAttribute('checked') != null;
    switch (type) {
      case 'radio':
        // Override the plan group to our choice; other radios follow the page.
        if (name === PLAN_RADIO_NAME) { if (value === opts.plan) params.append(name, value); }
        else if (checked) params.append(name, value);
        break;
      case 'checkbox':
        // Force the agreement box; other checkboxes follow the page (photo
        // service stays off).
        if (name === AGREEMENT_NAME) params.append(name, value);
        else if (checked) params.append(name, value);
        break;
      case 'submit':
        if (name === BUY_SUBMIT_NAME) params.append(name, value); // the clicked button
        break;
      case 'button':
      case 'image':
      case 'reset':
        break;
      default: // text, hidden, textarea, email, number, … — always submitted
        params.append(name, value);
    }
  }
  return { action: open[2].replace(/&amp;/g, '&'), body: params.toString() };
}

export interface HtmlSignals {
  title: string;
  alert: string | null;
}

/**
 * Pure counterpart of readPageSignals for a raw HTML string: the <title> and any
 * alert/flash text. Used to classify a buy POST response without a browser.
 */
export function readHtmlSignals(html: string): HtmlSignals {
  const root = parse(html);
  const title = (root.querySelector('title')?.text ?? '').trim();
  const alert = root.querySelectorAll(ALERT_SELECTOR)
    .map((el) => el.text.trim())
    .filter(Boolean)
    .join(' | ');
  return { title, alert: alert ? alert.slice(0, 500) : null };
}
