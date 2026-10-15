import type { Db } from '../connection.ts';

export type RefundStatus = 'pending' | 'approved' | 'rejected';

export interface RefundRequestInput {
  telegramId: number;
  mercariUrl: string;
  kopecks: number;
  reason: string;
  runId?: string | null;
}

export interface RefundRequest {
  id: number;
  telegramId: number;
  mercariUrl: string;
  kopecks: number;
  reason: string;
  runId: string | null;
  status: RefundStatus;
  createdAt: string;
  resolvedAt: string | null;
}

function mapRow(r: any): RefundRequest {
  return {
    id: r.id,
    telegramId: r.telegram_id,
    mercariUrl: r.mercari_url,
    kopecks: r.kopecks,
    reason: r.reason,
    runId: r.run_id,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export class RefundRequestsRepo {
  constructor(private db: Db, private now: () => string) {}

  /** Create a pending refund request; returns its id. */
  create(input: RefundRequestInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO refund_requests (telegram_id, mercari_url, kopecks, reason, run_id, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)`,
      )
      .run(input.telegramId, input.mercariUrl, input.kopecks, input.reason, input.runId ?? null, this.now());
    return Number(info.lastInsertRowid);
  }

  get(id: number): RefundRequest | null {
    const r = this.db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(id);
    return r ? mapRow(r) : null;
  }

  /** Pending requests, newest first (for admin listing). */
  listPending(): RefundRequest[] {
    return this.db
      .prepare("SELECT * FROM refund_requests WHERE status = 'pending' ORDER BY id DESC")
      .all()
      .map(mapRow);
  }

  /** Total kopecks awaiting an admin decision. */
  totalPending(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(kopecks), 0) AS s FROM refund_requests WHERE status = 'pending'").get() as any).s;
  }

  /**
   * Resolve a PENDING request to approved/rejected. Returns true only if it
   * actually transitioned — a second click on an already-resolved request is a
   * no-op (returns false), so the caller never refunds twice.
   */
  resolve(id: number, status: 'approved' | 'rejected'): boolean {
    const info = this.db
      .prepare("UPDATE refund_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, this.now(), id);
    return info.changes > 0;
  }
}
