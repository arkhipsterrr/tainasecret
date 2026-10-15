import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, NetworkEntry } from './recorder.ts';

// runId is `${Date.now()}-${n}` — restrict to that shape so `:runId` can never
// escape runsDir via path traversal.
const RUNID_RE = /^[0-9]+-[0-9]+$/;

export interface RunDetail {
  record: RunRecord | null;
  html: string;
  network: NetworkEntry[];
}

function parseLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as T; } catch { return null; }
    })
    .filter((r): r is T => r !== null);
}

/** Read-only view over the research log + per-run artifacts. */
export class ResearchReader {
  constructor(private logPath: string, private runsDir: string) {}

  private async readRecords(): Promise<RunRecord[]> {
    const raw = await readFile(this.logPath, 'utf8').catch(() => '');
    return parseLines<RunRecord>(raw);
  }

  /** Newest-first, capped. */
  async recent(limit: number): Promise<RunRecord[]> {
    const recs = await this.readRecords();
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    return recs.slice(-n).reverse();
  }

  async getRun(runId: string): Promise<RunDetail | null> {
    if (!RUNID_RE.test(runId)) return null;
    const record = (await this.readRecords()).find((r) => r.runId === runId) ?? null;
    const dir = join(this.runsDir, runId);
    const html = await readFile(join(dir, 'page.html'), 'utf8').catch(() => '');
    const netRaw = await readFile(join(dir, 'network.ndjson'), 'utf8').catch(() => '');
    if (record === null && html === '' && netRaw === '') return null;
    return { record, html, network: parseLines<NetworkEntry>(netRaw) };
  }
}
