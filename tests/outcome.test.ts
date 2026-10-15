import { describe, it, expect } from 'vitest';
import { classifyOutcome } from '@arhip/core';

const SUCCESS_ALERT =
  '×\n\t\tSuccessfully purchased the item on Mercari. | Save on Fees with Combined Orders!';

describe('classifyOutcome — layered (url + logical)', () => {
  it('deposit redirect → insufficient_balance (from the url layer)', () => {
    const o = classifyOutcome({ url: 'https://www.j-subculture.com/en/deposits/choose/' });
    expect(o.status).toBe('insufficient_balance');
    expect(o.url).toBe('insufficient_balance');
  });

  it('order-complete page → bought (from the url layer, no alert needed)', () => {
    const o = classifyOutcome({ url: 'https://www.j-subculture.com/en/shoppings/complete/?id=1' });
    expect(o.status).toBe('bought');
    expect(o.url).toBe('bought');
  });

  it('-fin WITH the success alert → bought (logical layer decides)', () => {
    const o = classifyOutcome({
      url: 'https://www.j-subculture.com/en/shoppings/mercari-direct-purchase-fin/',
      alert: SUCCESS_ALERT,
    });
    expect(o.status).toBe('bought');
    expect(o.logical).toBe('bought');
    expect(o.url).toBe('inconclusive'); // the url alone cannot tell success from failure
  });

  it('-fin WITHOUT a success alert → error (empty alert = payment did not go through)', () => {
    const o = classifyOutcome({
      url: 'https://www.j-subculture.com/en/shoppings/mercari-direct-purchase-fin/',
      alert: null,
    });
    expect(o.status).toBe('error');
    expect(o.url).toBe('inconclusive');
    expect(o.logical).toBe('inconclusive');
  });

  it('a mypage/orders redirect is NOT treated as bought without confirmation', () => {
    const o = classifyOutcome({ url: 'https://www.j-subculture.com/en/users/mypage/' });
    expect(o.status).toBe('error');
    expect(o.url).not.toBe('bought');
  });

  it('the direct-purchase FORM page (no submit yet) → error', () => {
    const o = classifyOutcome({ url: 'https://www.j-subculture.com/en/shoppings/mercari-direct-purchase' });
    expect(o.status).toBe('error');
  });

  it('carries a human-readable reason for triage', () => {
    const o = classifyOutcome({
      url: 'https://www.j-subculture.com/en/shoppings/mercari-direct-purchase-fin/',
      alert: SUCCESS_ALERT,
    });
    expect(typeof o.reason).toBe('string');
    expect(o.reason.length).toBeGreaterThan(0);
  });
});
