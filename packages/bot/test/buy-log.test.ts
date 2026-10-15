import { describe, it, expect } from 'vitest';
import { formatBuyLog } from '../src/services/purchase.ts';

const base = {
  telegramId: 42,
  url: 'https://jp.mercari.com/item/m1',
  priceJpy: 1000,
  costKopecks: 69575,
  maxPriceJpy: 1000,
};

describe('formatBuyLog', () => {
  it('formats a successful buy with all diagnostic fields', () => {
    const line = formatBuyLog({ ...base, outcome: 'ok', jsubStatus: 'bought', finalUrl: 'https://j.com/complete', runId: '1700-7' });
    expect(line).toContain('buy ok:');
    expect(line).toContain('user=42');
    expect(line).toContain('url=https://jp.mercari.com/item/m1');
    expect(line).toContain('priceJpy=1000');
    expect(line).toContain('cost=69575');
    expect(line).toContain('maxPriceJpy=1000');
    expect(line).toContain('jsubStatus=bought');
    expect(line).toContain('finalUrl=https://j.com/complete');
    expect(line).toContain('runId=1700-7');
  });

  it('formats a failure with the mapped status and error message', () => {
    const line = formatBuyLog({ ...base, outcome: 'fail', jsubStatus: 'error', finalUrl: 'https://j.com/x', runId: null, error: 'plan_not_found' });
    expect(line).toContain('buy fail:');
    expect(line).toContain('jsubStatus=error');
    expect(line).toContain('error=plan_not_found');
    expect(line).toContain('runId=');
  });

  it('renders missing optional fields as empty rather than "undefined"', () => {
    const line = formatBuyLog({ ...base, outcome: 'fail' });
    expect(line).not.toContain('undefined');
    expect(line).toContain('finalUrl=');
    expect(line).toContain('runId=');
    expect(line).toContain('error=');
  });
});
