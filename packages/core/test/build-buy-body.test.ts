import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBuyBody } from '../src/jsub/parse.ts';

// Real j-subculture direct-purchase pages captured 2026-09-15. The live pages
// wrap the buy <form> inside the site's search <form>; node-html-parser drops
// the (invalidly nested) inner form, so the old closest('form') approach found
// no form and every available buy failed with buy_form_missing. These fixtures
// lock in that the body is built from the raw form slice instead.
const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8');

describe('buildBuyBody on real (nested-form) pages', () => {
  it('builds the POST body for an available item despite the nested form', () => {
    const r = buildBuyBody(fx('buy-page-available.html'), { plan: '1' });
    expect(r).not.toBeNull();
    expect(r!.action).toContain('/en/shoppings/mercari-direct-purchase');
    const p = new URLSearchParams(r!.body);
    expect(p.getAll('Other[plan_type_tmp]')).toEqual(['1']); // only the chosen plan
    expect(p.getAll('Other[agreement]')).toContain('1'); // agreement forced on
    expect(p.has('order')).toBe(true); // the clicked submit
    // the paid photo service must stay off (checkbox not auto-checked)
    expect(p.getAll('Other[is_item_photo_service]')).not.toContain('1');
  });

  it('honours the chosen plan value', () => {
    const p = new URLSearchParams(buildBuyBody(fx('buy-page-available.html'), { plan: '2' })!.body);
    expect(p.getAll('Other[plan_type_tmp]')).toEqual(['2']);
  });

  it('builds the body for a second available item', () => {
    const r = buildBuyBody(fx('buy-page-available2.html'), { plan: '1' });
    expect(r).not.toBeNull();
    expect(new URLSearchParams(r!.body).has('order')).toBe(true);
  });

  it('returns null for a sold / unavailable item (no buy form present)', () => {
    expect(buildBuyBody(fx('buy-page-sold.html'), { plan: '1' })).toBeNull();
  });
});
