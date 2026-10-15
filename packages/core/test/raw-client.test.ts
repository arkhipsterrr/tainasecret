import { describe, it, expect, vi } from 'vitest';
import { RawJsubClient } from '../src/jsub/raw-client.ts';
import { PATHS } from '../src/session/constants.ts';

const BASE = 'https://www.j-subculture.com';
const ITEM = 'https://jp.mercari.com/item/m88297815004';
const PURCHASE_URL = BASE + PATHS.directPurchase(ITEM);

const HTML = `
<table><tr><th>Price</th><td><span class="cur-price-main"><span class="num">5,555</span> JPY</span></td></tr></table>
<input name="Other[custom_title]" value="Test Item">
<label><input type="radio" name="Other[plan_type_tmp]" value="1"> [Plan A] 150 JPY/order</label>
`;

function fakeFetch(resp: { status?: number; url?: string; text: string }) {
  return vi.fn(async (_url: string, _init?: any) => ({
    status: resp.status ?? 200,
    url: resp.url ?? PURCHASE_URL,
    text: async () => resp.text,
  }));
}

describe('RawJsubClient.preview', () => {
  it('fetches the purchase page and returns the parsed preview', async () => {
    const client = new RawJsubClient(BASE, () => 'sid=abc', fakeFetch({ text: HTML }));
    const p = await client.preview(ITEM);
    expect(p.priceJPY).toBe(5555);
    expect(p.title).toBe('Test Item');
    expect(p.plans.map((x) => x.value)).toEqual(['1']);
  });

  it('requests the correct URL with the session cookie header', async () => {
    const fetchFn = fakeFetch({ text: HTML });
    const client = new RawJsubClient(BASE, () => 'sid=abc; auth=xyz', fetchFn);
    await client.preview(ITEM);
    expect(fetchFn.mock.calls[0][0]).toBe(PURCHASE_URL);
    expect((fetchFn.mock.calls[0][1] as any).headers.cookie).toBe('sid=abc; auth=xyz');
  });

  it('throws needs_login when the request lands on the login page', async () => {
    const client = new RawJsubClient(BASE, () => '', fakeFetch({ url: BASE + '/en/users/login', text: '<html></html>' }));
    await expect(client.preview(ITEM)).rejects.toThrow('needs_login');
  });
});

const BUY_PAGE = `
<html><body>
<table><tr><th>Price</th><td><span class="cur-price-main"><span class="num">5,555</span> JPY</span></td></tr></table>
<form action="/en/shoppings/mercari-direct-purchase?shopping_url=X" method="post">
  <input type="hidden" name="Other[quantity]" value="1">
  <input type="radio" name="Other[plan_type_tmp]" value="1">
  <input type="radio" name="Other[plan_type_tmp]" value="2" checked>
  <input type="hidden" name="Other[agreement]" value="0">
  <input type="checkbox" name="Other[agreement]" value="1">
  <input type="submit" name="order" value="Agree & Buy Now">
</form>
</body></html>`;

const FIN_URL = BASE + '/en/shoppings/mercari-direct-purchase-fin?shopping_url=X';

// Routes GET vs POST to different fixtures so a buy can be simulated end-to-end.
function twoStep(getR: { status?: number; url?: string; text: string }, postR?: { status?: number; url?: string; text: string }) {
  return vi.fn(async (_url: string, init?: any) => {
    const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const r = isPost ? postR! : getR;
    return { status: r.status ?? 200, url: r.url ?? PURCHASE_URL, text: async () => r.text };
  });
}

describe('RawJsubClient.buy', () => {
  it('submits the form and classifies a success-alert finish page as bought', async () => {
    const fetchFn = twoStep(
      { text: BUY_PAGE },
      { url: FIN_URL, text: '<div class="alert">Successfully purchased the item on Mercari.</div>' },
    );
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn);
    const r = await client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 });
    expect(r.status).toBe('bought');
    expect(r.finalUrl).toBe(FIN_URL);
    // the POST went to the resolved action, form-urlencoded, with the plan override
    const post = fetchFn.mock.calls.find((c) => (c[1] as any)?.method?.toUpperCase() === 'POST')!;
    expect(post[0]).toBe(BASE + '/en/shoppings/mercari-direct-purchase?shopping_url=X');
    expect((post[1] as any).headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(new URLSearchParams((post[1] as any).body).getAll('Other[plan_type_tmp]')).toEqual(['1']);
  });

  it('classifies a deposit redirect as insufficient_balance', async () => {
    const fetchFn = twoStep({ text: BUY_PAGE }, { url: BASE + '/en/deposits/choose', text: '<html></html>' });
    const client = new RawJsubClient(BASE, () => '', fetchFn);
    const r = await client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 });
    expect(r.status).toBe('insufficient_balance');
  });

  it('enforces the price cap and never POSTs when the item is too expensive', async () => {
    const fetchFn = twoStep({ text: BUY_PAGE });
    const client = new RawJsubClient(BASE, () => '', fetchFn);
    const r = await client.buy(ITEM, { plan: '1', maxPriceJPY: 5000 });
    expect(r.status).toBe('price_exceeded');
    expect(fetchFn.mock.calls.some((c) => (c[1] as any)?.method?.toUpperCase() === 'POST')).toBe(false);
  });

  it('fails closed (no POST) when the price cannot be read but a cap is set', async () => {
    const noPrice = BUY_PAGE.replace(/<table>[\s\S]*<\/table>/, '');
    const fetchFn = twoStep({ text: noPrice });
    const client = new RawJsubClient(BASE, () => '', fetchFn);
    await expect(client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 })).rejects.toThrow('price_unavailable');
    expect(fetchFn.mock.calls.some((c) => (c[1] as any)?.method?.toUpperCase() === 'POST')).toBe(false);
  });

  it('throws needs_login (no POST) when the buy GET lands on the login page', async () => {
    const fetchFn = twoStep({ url: BASE + '/en/users/login', text: '<html></html>' });
    const client = new RawJsubClient(BASE, () => '', fetchFn);
    await expect(client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 })).rejects.toThrow('needs_login');
    expect(fetchFn.mock.calls.some((c) => (c[1] as any)?.method?.toUpperCase() === 'POST')).toBe(false);
  });

  // Guard: the form action is parsed from the (untrusted) upstream HTML. An
  // off-origin action must NOT be POSTed to — that would leak the session cookie
  // to an attacker host.
  it('refuses (no POST) when the buy form action points off-origin', async () => {
    const offsite = BUY_PAGE.replace(
      '/en/shoppings/mercari-direct-purchase?shopping_url=X',
      'https://attacker.example/mercari-direct-purchase?shopping_url=X',
    );
    const fetchFn = twoStep({ text: offsite });
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn);
    await expect(client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 })).rejects.toThrow('buy_form_offsite');
    expect(fetchFn.mock.calls.some((c) => (c[1] as any)?.method?.toUpperCase() === 'POST')).toBe(false);
  });
});

const PRICE_NO_FORM =
  '<table><tr><th>Price</th><td><span class="cur-price-main"><span class="num">5,555</span> JPY</span></td></tr></table>';

function fakeRecorder() {
  const artifacts: any[] = [];
  const records: any[] = [];
  let n = 0;
  return {
    artifacts, records,
    newRunId: () => 'run-' + (++n),
    saveArtifacts: async (runId: string, data: any) => { artifacts.push({ runId, ...data }); },
    writeRecord: async (rec: any) => { records.push(rec); },
  };
}

describe('RawJsubClient research recording', () => {
  it('records evidence and returns the runId on a successful buy', async () => {
    const rec = fakeRecorder();
    const fetchFn = twoStep(
      { text: BUY_PAGE },
      { url: FIN_URL, text: '<div class="alert">Successfully purchased the item on Mercari.</div>' },
    );
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn, rec);
    const r = await client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 });

    expect(r.runId).toBe('run-1');
    expect(rec.records[0]).toMatchObject({
      action: 'buy', status: 'bought', finalUrl: FIN_URL, runId: 'run-1',
      urlVerdict: 'inconclusive', logicalVerdict: 'bought',
    });
    // the POST response (status + the purchase page) is captured
    expect(rec.artifacts[0].html).toContain('Successfully purchased');
    expect(rec.artifacts[0].network).toContainEqual(
      expect.objectContaining({ kind: 'response', method: 'POST', status: 200 }),
    );
  });

  it('records the failing page and rethrows on buy_form_missing', async () => {
    const rec = fakeRecorder();
    const fetchFn = twoStep({ text: PRICE_NO_FORM });
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn, rec);

    await expect(client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 })).rejects.toThrow('buy_form_missing');
    expect(rec.records[0]).toMatchObject({ action: 'buy', status: 'error', error: 'buy_form_missing', runId: 'run-1' });
    expect(rec.artifacts[0].html).toContain('Price'); // the GET page was saved
  });

  it('works without a recorder and reports a null runId', async () => {
    const fetchFn = twoStep(
      { text: BUY_PAGE },
      { url: FIN_URL, text: '<div class="alert">Successfully purchased the item on Mercari.</div>' },
    );
    const client = new RawJsubClient(BASE, () => 'sid=abc', fetchFn);
    const r = await client.buy(ITEM, { plan: '1', maxPriceJPY: 6000 });
    expect(r.status).toBe('bought');
    expect(r.runId).toBeNull();
  });
});
