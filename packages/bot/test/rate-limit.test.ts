import { describe, it, expect } from 'vitest';
import { RateLimiter, RATE_LIMITS, classifyUpdate } from '../src/rate-limit.ts';

describe('RateLimiter', () => {
  it('allows up to max within the window, then blocks', () => {
    let t = 0; const rl = new RateLimiter(() => t);
    const rule = { max: 2, windowMs: 1000 };
    expect(rl.allow('k', rule)).toBe(true);
    expect(rl.allow('k', rule)).toBe(true);
    expect(rl.allow('k', rule)).toBe(false); // 3rd within window
  });

  it('resets after the window slides past old hits', () => {
    let t = 0; const rl = new RateLimiter(() => t);
    const rule = { max: 1, windowMs: 1000 };
    expect(rl.allow('k', rule)).toBe(true);
    expect(rl.allow('k', rule)).toBe(false);
    t = 1001;
    expect(rl.allow('k', rule)).toBe(true); // old hit expired
  });

  it('tracks keys independently', () => {
    let t = 0; const rl = new RateLimiter(() => t);
    const rule = { max: 1, windowMs: 1000 };
    expect(rl.allow('a', rule)).toBe(true);
    expect(rl.allow('b', rule)).toBe(true); // different key not affected
    expect(rl.allow('a', rule)).toBe(false);
  });
});

describe('classifyUpdate', () => {
  it('classifies a buy callback as buy', () => {
    expect(classifyUpdate({ callbackQuery: { data: 'buy:abc' } })).toBe('buy');
  });
  it('classifies a cancel callback as light', () => {
    expect(classifyUpdate({ callbackQuery: { data: 'cancel:abc' } })).toBe('light');
  });
  it('classifies a plain text (mercari link) as preview', () => {
    expect(classifyUpdate({ message: { text: 'https://jp.mercari.com/item/m1' } })).toBe('preview');
  });
  it('classifies a command as light', () => {
    expect(classifyUpdate({ message: { text: '/help' } })).toBe('light');
  });
  it('has rules for every class', () => {
    expect(RATE_LIMITS.buy).toBeDefined();
    expect(RATE_LIMITS.preview).toBeDefined();
    expect(RATE_LIMITS.light).toBeDefined();
  });
});
