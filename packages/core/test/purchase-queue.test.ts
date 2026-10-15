import { describe, it, expect } from 'vitest';
import { PurchaseQueue } from '../src/purchase-queue.ts';

describe('PurchaseQueue', () => {
  it('runs jobs one at a time in order', async () => {
    const q = new PurchaseQueue();
    const order: number[] = [];
    let active = 0; let maxActive = 0;
    const job = (n: number) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n); active--;
      return n;
    };
    const results = await Promise.all([q.enqueue(job(1)), q.enqueue(job(2)), q.enqueue(job(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it('continues after a rejecting job', async () => {
    const q = new PurchaseQueue();
    const bad = q.enqueue(async () => { throw new Error('boom'); });
    const good = q.enqueue(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });
});
