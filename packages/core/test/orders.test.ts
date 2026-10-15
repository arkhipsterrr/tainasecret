import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOrdersPage, mercariItemId, orderForMercariUrl } from '../src/jsub/orders.ts';

// Real /en/orders pages captured 2026-09-15. Each order spans two <tr>: the
// first holds status / ORD number / date, the second holds the item title and a
// /shoppings/detail?shopping_url=… link whose query carries the mercari URL.
// The "Paid" order for m27688411462 (ORD-2245911) is the refund-#3 item, proving
// the purchase actually went through — this is the ground truth we parse against.
const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8');

describe('mercariItemId', () => {
  it('extracts the item id from a mercari url', () => {
    expect(mercariItemId('https://jp.mercari.com/item/m27688411462')).toBe('m27688411462');
  });

  it('returns null when there is no mercari item id', () => {
    expect(mercariItemId('https://item.fril.jp/6a1d9811aea50848661b6d9482c34a47')).toBeNull();
  });
});

describe('parseOrdersPage', () => {
  it('parses the refund-#3 order with its status and order number', () => {
    const rows = parseOrdersPage(fx('en-orders.html'));
    const row = rows.find((r) => r.mercariItemId === 'm27688411462');
    expect(row).toBeDefined();
    expect(row!.status).toBe('Paid');
    expect(row!.orderNo).toBe('ORD-2245911');
    expect(row!.title).toContain('PPFM');
  });

  it('parses every order on the page (one per ORD number)', () => {
    const rows = parseOrdersPage(fx('en-orders.html'));
    // The page holds exactly 40 orders (40 distinct ORD numbers); some carry
    // several item links, so the mercari-link count is higher and irrelevant.
    expect(rows.length).toBe(40);
    expect(rows.every((r) => /^ORD-\d+$/.test(r.orderNo))).toBe(true);
  });

  it('degrades to no orders on a page without an orders table', () => {
    expect(parseOrdersPage('<html><body><p>No orders yet.</p></body></html>')).toEqual([]);
  });
});

describe('orderForMercariUrl', () => {
  it('finds the paid order for a purchased mercari url', () => {
    const row = orderForMercariUrl(fx('en-orders.html'), 'https://jp.mercari.com/item/m27688411462');
    expect(row?.status).toBe('Paid');
  });

  it('returns null when the item is not in the orders list', () => {
    expect(orderForMercariUrl(fx('en-orders.html'), 'https://jp.mercari.com/item/m00000000000')).toBeNull();
  });
});
