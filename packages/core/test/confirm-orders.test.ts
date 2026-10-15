import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RawJsubClient } from '../src/jsub/raw-client.ts';

const BASE = 'https://www.j-subculture.com';
const ITEM = 'https://jp.mercari.com/item/m27688411462'; // the refund-#3 item, "Paid" in the fixture
const NONE = '<html><body><p>no orders yet</p></body></html>';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8');

/** Fake fetch that returns a different orders page body per call (simulates the
 *  order taking a few polls to show up after payment). */
function pagesInSequence(bodies: string[]) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: any) => {
    const text = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return { status: 200, url: BASE + '/en/orders', text: async () => text };
  });
}

const noSleep = async () => {};

describe('RawJsubClient.confirmViaOrders', () => {
  it('returns the order once it appears after a few polls', async () => {
    const fetchFn = pagesInSequence([NONE, NONE, fx('en-orders.html')]);
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn);
    const order = await client.confirmViaOrders(ITEM, { attempts: 5, delayMs: 0, sleep: noSleep });
    expect(order?.status).toBe('Paid');
    expect(order?.orderNo).toBe('ORD-2245911');
    expect(fetchFn).toHaveBeenCalledTimes(3); // stopped as soon as it appeared
  });

  it('gives up and returns null when the order never appears', async () => {
    const fetchFn = pagesInSequence([NONE]);
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn);
    const order = await client.confirmViaOrders(ITEM, { attempts: 3, delayMs: 0, sleep: noSleep });
    expect(order).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3); // polled the full budget
  });

  it('requests /en/orders with the session cookie header', async () => {
    const fetchFn = pagesInSequence([fx('en-orders.html')]);
    const client = new RawJsubClient(BASE, () => 'sid=abc; auth=xyz', fetchFn);
    await client.confirmViaOrders(ITEM, { attempts: 1, delayMs: 0, sleep: noSleep });
    expect(fetchFn.mock.calls[0][0]).toBe(BASE + '/en/orders');
    expect((fetchFn.mock.calls[0][1] as any).headers.cookie).toBe('sid=abc; auth=xyz');
  });
});
