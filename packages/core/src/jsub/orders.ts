import { parse, type HTMLElement } from 'node-html-parser';

export interface OrderRow {
  /** e.g. "ORD-2245911". */
  orderNo: string;
  /** e.g. "Paid", "Requested", "Canceled". */
  status: string;
  /** Link to the order detail page, e.g. "/en/orders/detail/66FE9AE9F8D2A3C". */
  detailUrl: string;
  /** Human date as shown, e.g. "Today, 03:59". */
  date: string;
  /** Item title, or '' when the row has none. */
  title: string;
  /** The decoded shopping_url the order was placed for. */
  shoppingUrl: string;
  /** The mercari item id from shoppingUrl, or null for non-mercari sources. */
  mercariItemId: string | null;
}

/** Extract the mercari item id (m + digits) from a url, or null if absent. */
export function mercariItemId(url: string): string | null {
  const m = url.match(/m\d{9,}/);
  return m ? m[0] : null;
}

/** The <a href> value with HTML entities normalised (node keeps &amp;). */
function href(a: HTMLElement | null): string {
  return (a?.getAttribute('href') ?? '').replace(/&amp;/g, '&');
}

/** Does this row start an order (status / ORD number / date)? Returns the ORD anchor. */
function orderAnchor(row: HTMLElement): HTMLElement | null {
  return row.querySelectorAll('a').find((a) => {
    const h = a.getAttribute('href') ?? '';
    return h.startsWith('/en/orders/detail/') && /^ORD-\d+/.test(a.text.trim());
  }) ?? null;
}

/** The /shoppings/detail link carrying the ordered item's shopping_url, if any. */
function itemAnchor(row: HTMLElement): HTMLElement | null {
  return row.querySelectorAll('a').find((a) => (a.getAttribute('href') ?? '').includes('shopping_url=')) ?? null;
}

/** Status text = the status cell minus its "Proxy Shopping"/order-type label. */
function statusOf(row: HTMLElement): string {
  const label = row.querySelectorAll('span').find((s) => (s.getAttribute('class') ?? '').includes('order-type'));
  const td = label?.closest('td');
  if (!td) return '';
  return td.text.replace(label!.text, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the /en/orders list into one OrderRow per order. Each order spans two
 * table rows: a header row (status / ORD number / qty / date / details) and an
 * item row (title + a /shoppings/detail?shopping_url=… link). We walk the rows
 * in order, opening an order on each header row and attaching the item found in
 * the following row(s). Degrades to [] on an empty list rather than throwing.
 */
export function parseOrdersPage(html: string): OrderRow[] {
  const rows: OrderRow[] = [];
  let current: OrderRow | null = null;

  for (const tr of parse(html).querySelectorAll('tr')) {
    const ord = orderAnchor(tr);
    if (ord) {
      current = {
        orderNo: ord.text.trim(),
        status: statusOf(tr),
        detailUrl: ord.getAttribute('href') ?? '',
        date: tr.querySelector('.mod-date-area')?.text.trim() ?? '',
        title: '',
        shoppingUrl: '',
        mercariItemId: null,
      };
      rows.push(current);
      continue;
    }
    const item = itemAnchor(tr);
    if (item && current && !current.shoppingUrl) {
      const shoppingUrl = new URL(href(item), 'https://www.j-subculture.com').searchParams.get('shopping_url') ?? '';
      current.shoppingUrl = shoppingUrl;
      current.mercariItemId = mercariItemId(shoppingUrl);
      const titleDiv = tr.querySelector('div');
      current.title = (titleDiv?.text ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return rows;
}

/** Find the order placed for a given mercari url, or null if it isn't listed. */
export function orderForMercariUrl(html: string, mercariUrl: string): OrderRow | null {
  const id = mercariItemId(mercariUrl);
  if (!id) return null;
  return parseOrdersPage(html).find((r) => r.mercariItemId === id) ?? null;
}
