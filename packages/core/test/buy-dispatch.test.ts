import { describe, it, expect, vi } from 'vitest';
import { JsubClient } from '../src/jsub/client.ts';

const URL = 'https://jp.mercari.com/item/m111';
const BOUGHT = { status: 'bought' as const, finalUrl: 'https://shop/-fin', runId: 'r1' };
const FRESH = { status: 'insufficient_balance' as const, finalUrl: 'https://shop/pay', runId: 'r2' };

// A fake runner that never invokes the passed fn (no real Playwright page). It
// lets us assert the buy DISPATCH: which path runs and, crucially, that a fresh
// navigation never follows a parked attempt that already ran (no double buy).
// Typed loosely (any) because vi.fn() mocks don't satisfy PageRunner's generic
// method signatures; behaviour is what we assert, not types.
function fakeRunner(over: { withPage?: any; withParkedPage?: any }): any {
  return {
    withPage: vi.fn(async () => { throw new Error('withPage not stubbed'); }),
    withParkedPage: vi.fn(async () => ({ hit: false })),
    ...over,
  };
}

describe('JsubClient.buy dispatch', () => {
  it('returns the parked result and never navigates fresh on a hit', async () => {
    const runner = fakeRunner({
      withParkedPage: vi.fn(async () => ({ hit: true, result: BOUGHT })),
      withPage: vi.fn(),
    });
    const client = new JsubClient(runner, 'https://shop');

    const r = await client.buy(URL, {});

    expect(r).toEqual(BOUGHT);
    expect(runner.withParkedPage).toHaveBeenCalledOnce();
    expect(runner.withPage).not.toHaveBeenCalled();
  });

  it('falls back to a fresh navigation only on a true parked miss', async () => {
    const runner = fakeRunner({
      withParkedPage: vi.fn(async () => ({ hit: false })),
      withPage: vi.fn(async () => FRESH),
    });
    const client = new JsubClient(runner, 'https://shop');

    const r = await client.buy(URL, {});

    expect(r).toEqual(FRESH);
    expect(runner.withPage).toHaveBeenCalledOnce();
  });

  it('propagates a parked-attempt error WITHOUT a fresh retry (no double buy)', async () => {
    const runner = fakeRunner({
      withParkedPage: vi.fn(async () => { throw new Error('click_failed_midway'); }),
      withPage: vi.fn(),
    });
    const client = new JsubClient(runner, 'https://shop');

    await expect(client.buy(URL, {})).rejects.toThrow('click_failed_midway');
    expect(runner.withPage).not.toHaveBeenCalled();
  });

  it('preview parks the page under the normalized url key', async () => {
    const runner = fakeRunner({
      withPage: vi.fn(async () => ({ title: '', priceJPY: null, plans: [], balanceHint: null })),
    });
    const client = new JsubClient(runner, 'https://shop');

    await client.preview('https://jp.mercari.com/en/item/m222/');

    // second arg to withPage is the park key; must be the canonical url so a
    // later buy for the same item hits the parked page.
    expect(runner.withPage.mock.calls[0][1]).toBe('https://jp.mercari.com/item/m222');
  });
});
