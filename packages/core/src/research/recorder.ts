import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface NetworkEntry {
  ts: string;
  /** 'request' for outgoing calls, 'response' for the server's reply. */
  kind?: 'request' | 'response';
  method: string;
  url: string;
  resType: string;
  post: string | null;
  /** Response-only: HTTP status, status text and a truncated body snippet. */
  status?: number;
  statusText?: string;
  respBody?: string | null;
}

export interface RunRecord {
  ts: string;
  action: string;
  url: string;
  status: string;
  priceJPY: number | null;
  plan: string | null;
  finalUrl: string;
  error: string | null;
  runId: string;
  /** Page diagnostics captured at dump time: document title + visible alert text. */
  title?: string;
  alert?: string | null;
  /** Layered outcome for triage: the URL-layer verdict, the logical (alert) verdict, and why. */
  urlVerdict?: string | null;
  logicalVerdict?: string | null;
  outcomeReason?: string | null;
}

/**
 * Research log: one JSON line per preview/buy in `logPath`, plus the final page
 * HTML and per-domain network calls under `runsDir/<runId>/`.
 */
export class ResearchLog {
  private counter = 0;

  constructor(private logPath: string, private runsDir: string) {}

  newRunId(): string {
    this.counter += 1;
    return `${Date.now()}-${this.counter}`;
  }

  async saveArtifacts(runId: string, data: { html: string; network: NetworkEntry[] }): Promise<void> {
    const dir = join(this.runsDir, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'page.html'), data.html);
    await writeFile(join(dir, 'network.ndjson'), data.network.map((n) => JSON.stringify(n)).join('\n') + '\n');
  }

  async writeRecord(rec: RunRecord): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, JSON.stringify(rec) + '\n');
  }
}
