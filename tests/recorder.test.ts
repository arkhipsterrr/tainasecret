import { describe, it, expect } from 'vitest';
import { ResearchLog } from '@arhip/core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'research-'));
  return { dir, log: new ResearchLog(join(dir, 'log.ndjson'), join(dir, 'runs')) };
}

describe('ResearchLog', () => {
  it('newRunId returns unique ids', () => {
    const { log } = tmp();
    expect(log.newRunId()).not.toBe(log.newRunId());
  });

  it('saveArtifacts writes html and network', async () => {
    const { dir, log } = tmp();
    await log.saveArtifacts('r1', {
      html: '<h1>hi</h1>',
      network: [{ ts: 't', method: 'GET', url: 'u', resType: 'document', post: null }],
    });
    expect(readFileSync(join(dir, 'runs', 'r1', 'page.html'), 'utf8')).toContain('hi');
    expect(readFileSync(join(dir, 'runs', 'r1', 'network.ndjson'), 'utf8')).toContain('"method":"GET"');
  });

  it('writeRecord appends a json line', async () => {
    const { dir, log } = tmp();
    await log.writeRecord({
      ts: 't', action: 'buy', url: 'u', status: 'bought',
      priceJPY: 100, plan: '1', finalUrl: 'f', error: null, runId: 'r1',
    });
    const raw = readFileSync(join(dir, 'log.ndjson'), 'utf8').trim();
    expect(JSON.parse(raw).status).toBe('bought');
  });
});
