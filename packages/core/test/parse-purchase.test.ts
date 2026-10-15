import { describe, it, expect } from 'vitest';
import { parsePurchasePage, buildBuyBody, readHtmlSignals } from '../src/jsub/parse.ts';

// Mirrors the real direct-purchase page structure confirmed via the raw-HTTP
// spike: an item "Price" row AND a separate "Order Total" row (both use
// .cur-price-main .num), a prefilled custom_title input, and three plan radios
// inside their labels.
const HTML = `
<table>
  <tr><th>Price</th><td><span class="cur-price-main"><span class="num">5,555</span> JPY</span></td></tr>
  <tr><th>Order Total</th><td><span class="cur-price-main"><span class="num">73,500</span> JPY</span></td></tr>
</table>
<input type="text" name="Other[custom_title]" value="PLAY COMME des GARCONS ポロシャツ ブラック M">
<label><input type="radio" name="Other[plan_type_tmp]" value="1"> Plan A (150 JPY/order)</label>
<label><input type="radio" name="Other[plan_type_tmp]" value="2" checked> Plan B (300 JPY/order)</label>
<label><input type="radio" name="Other[plan_type_tmp]" value="3"> Plan C (600 JPY/order)</label>
`;

describe('parsePurchasePage', () => {
  it('reads the item Price row, never the Order Total row', () => {
    expect(parsePurchasePage(HTML).priceJPY).toBe(5555);
  });

  it('reads the prefilled item title', () => {
    expect(parsePurchasePage(HTML).title).toBe('PLAY COMME des GARCONS ポロシャツ ブラック M');
  });

  it('reads every plan with its value and label', () => {
    const { plans } = parsePurchasePage(HTML);
    expect(plans.map((p) => p.value)).toEqual(['1', '2', '3']);
    expect(plans[0].label).toContain('Plan A');
    expect(plans[2].label).toContain('Plan C');
  });

  it('degrades to empty/null instead of throwing on an unexpected page', () => {
    const r = parsePurchasePage('<html><body>nothing useful here</body></html>');
    expect(r.priceJPY).toBeNull();
    expect(r.title).toBe('');
    expect(r.plans).toEqual([]);
  });
});

// Mirrors the real buy form: hidden defaults + a hidden/checkbox pair for
// agreement & photo-service + radio groups. Plan B is the page's default
// checked radio — the browser overrides it to Plan A by clicking.
const BUY_HTML = `
<form action="/en/shoppings/mercari-direct-purchase?shopping_url=X" method="post">
  <input type="hidden" name="Other[quantity]" value="1">
  <input type="text" name="Other[custom_title]" value="Test Item">
  <input type="text" name="Other[message]" value="">
  <input type="radio" name="Other[plan_type_tmp]" value="1">
  <input type="radio" name="Other[plan_type_tmp]" value="2" checked>
  <input type="radio" name="Other[plan_type_tmp]" value="3">
  <input type="hidden" name="Other[is_item_photo_service]" value="0">
  <input type="checkbox" name="Other[is_item_photo_service]" value="1">
  <input type="hidden" name="Other[agreement]" value="0">
  <input type="checkbox" name="Other[agreement]" value="1">
  <input type="submit" name="order" value="Agree & Buy Now">
</form>`;

describe('buildBuyBody', () => {
  it('overrides the plan radio to the chosen plan (not the page default)', () => {
    const out = buildBuyBody(BUY_HTML, { plan: '1' })!;
    const p = new URLSearchParams(out.body);
    expect(p.getAll('Other[plan_type_tmp]')).toEqual(['1']); // only 1, never the default 2
  });

  it('forces the agreement checkbox checked', () => {
    const p = new URLSearchParams(buildBuyBody(BUY_HTML, { plan: '1' })!.body);
    expect(p.getAll('Other[agreement]')).toContain('1');
  });

  it('does NOT opt into the paid photo service', () => {
    const p = new URLSearchParams(buildBuyBody(BUY_HTML, { plan: '1' })!.body);
    const photo = p.getAll('Other[is_item_photo_service]');
    expect(photo).toContain('0');   // hidden default sent
    expect(photo).not.toContain('1'); // checkbox left unchecked
  });

  it('includes the submit button and returns the form action', () => {
    const out = buildBuyBody(BUY_HTML, { plan: '1' })!;
    expect(new URLSearchParams(out.body).has('order')).toBe(true);
    expect(out.action).toBe('/en/shoppings/mercari-direct-purchase?shopping_url=X');
  });

  it('returns null when there is no buy form', () => {
    expect(buildBuyBody('<div>no form here</div>', { plan: '1' })).toBeNull();
  });
});

describe('readHtmlSignals', () => {
  it('extracts the title and joined alert text', () => {
    const html = '<title>Order error</title><div class="alert">Payment failed</div><div role="alert">Try again</div>';
    const s = readHtmlSignals(html);
    expect(s.title).toBe('Order error');
    expect(s.alert).toBe('Payment failed | Try again');
  });

  it('returns a null alert when there is none', () => {
    const s = readHtmlSignals('<title>ok</title><p>fine</p>');
    expect(s.alert).toBeNull();
  });
});
