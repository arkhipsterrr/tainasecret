// SAFE integration test — runs only against the dummy 0-balance account.
// It verifies the whole purchase path WITHOUT ever spending money: a buy
// attempt on 0 balance must classify as `insufficient_balance`.
// Requires a valid saved session (run `npx tsx scripts/login.ts` first).
//   npm run test:integration
import { describe, it, expect } from 'vitest';
import { loadConfig, Session, JsubClient } from '@arhip/core';

const ITEM = process.env.TEST_MERCARI_URL ?? 'https://jp.mercari.com/item/m88297815004';

describe('JsubClient against dummy 0-balance account', () => {
  const cfg = loadConfig();
  const client = new JsubClient(new Session(cfg), cfg.baseUrl);

  it('preview returns a title and plan list', async () => {
    const p = await client.preview(ITEM);
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.plans.length).toBeGreaterThan(0);
  });

  it('buy on 0 balance classifies as insufficient_balance (no money spent)', async () => {
    const r = await client.buy(ITEM, {});
    expect(r.status).toBe('insufficient_balance');
  });
});
