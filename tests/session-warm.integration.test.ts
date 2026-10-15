// SAFE integration test — launches a REAL headless Chromium but never touches
// the shop: it drives about:blank only. Verifies the warm-browser lifecycle:
// the browser is launched once and reused across withPage calls, and dispose()
// tears it down. No session, no proxy, no money.
//   npm run test:integration
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, type Config } from '@arhip/core';

const statePath = join(tmpdir(), `warm-state-${process.pid}.json`);

function fakeConfig(): Config {
  return {
    baseUrl: 'https://example.com',
    port: 0,
    storageStatePath: statePath,
    ledgerPath: '',
    apiToken: null,
    researchLogPath: '',
    runsDir: '',
    proxyUrl: null,
    rawHttp: false,
    credentials: { username: 'x', password: 'y' },
  };
}

describe('Session warm browser lifecycle', () => {
  let session: Session;
  let launches = 0;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('timing browser.launch=')) launches++;
    });
    session = new Session(fakeConfig());
  });

  afterAll(async () => {
    await session.dispose();
    logSpy.mockRestore();
    rmSync(statePath, { force: true });
  });

  it('reuses one browser across multiple withPage calls', async () => {
    const first = await session.withPage(async (page) => {
      await page.goto('about:blank');
      return page.url();
    });
    const second = await session.withPage(async (page) => {
      await page.goto('about:blank');
      return page.url();
    });

    expect(first).toBe('about:blank');
    expect(second).toBe('about:blank');
    expect(launches).toBe(1); // launched once, reused for the second call
  });

  it('rebuilds after dispose', async () => {
    await session.dispose();
    await session.withPage(async (page) => {
      await page.goto('about:blank');
      return page.url();
    });
    expect(launches).toBe(2); // dispose forced a fresh launch
  });
});
