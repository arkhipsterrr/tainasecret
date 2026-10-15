import { describe, it, expect } from 'vitest';
import { ResearchReader, ResearchLog } from '@arhip/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rreader-'));
  const logPath = join(dir, 'log.ndjson');
  const runsDir = join(dir, 'runs');
  return { logPath, runsDir, log: new ResearchLog(logPath, runsDir), reader: new ResearchReader(logPath, runsDir) };
}

function rec(runId: string, extra = {}) {
  return { ts: 't', action: 'buy', url: 'u', status: 'previewed', priceJPY: 1, plan: null, finalUrl: 'f', error: null, runId, ...extra };
}

describe('ResearchReader', () => {
  it('recent returns newest-first, capped', async () => {
    const { log, reader } = setup();
    await log.writeRecord(rec('1-1'));
    await log.writeRecord(rec('1-2'));
    await log.writeRecord(rec('1-3'));
    const out = await reader.recent(2);
    expect(out.map((r) => r.runId)).toEqual(['1-3', '1-2']);
  });

  it('recent on missing log returns []', async () => {
    const { reader } = setup();
    expect(await reader.recent(10)).toEqual([]);
  });

  it('getRun returns record + html + network', async () => {
    const { log, reader } = setup();
    await log.writeRecord(rec('111-1'));
    await log.saveArtifacts('111-1', {
      html: '<h1>page</h1>',
      network: [{ ts: 't', method: 'POST', url: 'https://x/y', resType: 'document', post: 'a=1' }],
    });
    const run = await reader.getRun('111-1');
    expect(run?.record?.runId).toBe('111-1');
    expect(run?.html).toContain('page');
    expect(run?.network[0].method).toBe('POST');
  });

  it('rejects path-traversal runIds', async () => {
    const { reader } = setup();
    expect(await reader.getRun('../../etc/passwd')).toBeNull();
    expect(await reader.getRun('..')).toBeNull();
  });

  it('missing run → null', async () => {
    const { reader } = setup();
    expect(await reader.getRun('999-999')).toBeNull();
  });
});
