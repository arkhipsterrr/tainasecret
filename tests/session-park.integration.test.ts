// SAFE integration test — real headless Chromium on about:blank only, no shop.
// Verifies the Phase-3 parked-page lifecycle: a page parked by withPage() is
// reused by withParkedPage() for a matching key (same page object, so in-page
// state survives), consumed after one use, and a non-matching key never runs fn.
//   npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, type Config } from '@arhip/core';

const statePath = join(tmpdir(), `park-state-${process.pid}.json`);

function fakeConfig(): Config {
  return {
    baseUrl: 'https://example.com', port: 0, storageStatePath: statePath,
    ledgerPath: '', apiToken: null, researchLogPath: '', runsDir: '',
    proxyUrl: null, rawHttp: false, credentials: { username: 'x', password: 'y' },
  };
}

describe('Session parked-page lifecycle', () => {
  let session: Session;

  beforeAll(() => {
    writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    session = new Session(fakeConfig());
  });
  afterAll(async () => {
    await session.dispose();
    rmSync(statePath, { force: true });
  });

  it('reuses the same parked page for a matching key, then consumes it', async () => {
    await session.withPage(async (page) => {
      await page.goto('about:blank');
      await page.evaluate(() => { (window as any).__parked = 'yes'; });
      return null;
    }, 'k1');

    // A matching key reuses the SAME page: the in-page marker is still there.
    const hit = await session.withParkedPage('k1', (page) =>
      page.evaluate(() => (window as any).__parked));
    expect(hit.hit).toBe(true);
    expect(hit.result).toBe('yes');

    // Parked page is used at most once — a second attempt misses.
    let ranAgain = false;
    const again = await session.withParkedPage('k1', async () => { ranAgain = true; return 'x'; });
    expect(again.hit).toBe(false);
    expect(ranAgain).toBe(false);
  });

  it('never runs fn on a non-matching key (clean miss → caller navigates fresh)', async () => {
    await session.withPage(async (page) => { await page.goto('about:blank'); return null; }, 'kA');

    let ran = false;
    const res = await session.withParkedPage('kB', async () => { ran = true; return 'x'; });
    expect(res.hit).toBe(false);
    expect(ran).toBe(false);
  });
});
