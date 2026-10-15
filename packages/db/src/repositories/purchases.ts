import type { Db } from '../connection.ts';

export interface PurchaseInput {
  telegramId: number;
  mercariUrl: string;
  priceJpy: number;
  costRub: number;
  status: 'bought' | 'failed';
  runId?: string | null;
}

export interface Order {
  id: number;
  mercariUrl: string;
  priceJpy: number;
  costRub: number;
  status: string;
  runId: string | null;
  createdAt: string;
}

/** An order across all users, with the buyer's telegram id + username. */
export interface AdminOrder extends Order {
  telegramId: number;
  username: string | null;
}

export class PurchasesRepo {
  constructor(
    private db: Db,
    private now: () => string,
  ) {}

  isBought(url: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM purchases WHERE mercari_url = ? AND status = 'bought'").get(url);
  }

  record(p: PurchaseInput): void {
    this.db
      .prepare(
        `INSERT INTO purchases (telegram_id, mercari_url, price_jpy, cost_rub, status, run_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      )
      .run(p.telegramId, p.mercariUrl, p.priceJpy, p.costRub, p.status, p.runId ?? null, this.now());
  }

  /** A user's purchases, newest first. */
  listByUser(telegramId: number, limit: number): Order[] {
    return this.db
      .prepare(
        `SELECT id, mercari_url, price_jpy, cost_rub, status, run_id, created_at
           FROM purchases WHERE telegram_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(telegramId, limit)
      .map((r: any) => ({
        id: r.id,
        mercariUrl: r.mercari_url,
        priceJpy: r.price_jpy,
        costRub: r.cost_rub,
        status: r.status,
        runId: r.run_id,
        createdAt: r.created_at,
      }));
  }

  /** All users' purchases, newest first, joined with the buyer's username. */
  listAll(limit: number): AdminOrder[] {
    return this.db
      .prepare(
        `SELECT p.id, p.telegram_id, u.username, p.mercari_url, p.price_jpy, p.cost_rub,
                p.status, p.run_id, p.created_at
           FROM purchases p LEFT JOIN users u ON u.telegram_id = p.telegram_id
           ORDER BY p.id DESC LIMIT ?`,
      )
      .all(limit)
      .map((r: any) => ({
        id: r.id,
        telegramId: r.telegram_id,
        username: r.username ?? null,
        mercariUrl: r.mercari_url,
        priceJpy: r.price_jpy,
        costRub: r.cost_rub,
        status: r.status,
        runId: r.run_id,
        createdAt: r.created_at,
      }));
  }

  /** Total kopecks spent on successful purchases. */
  totalSpent(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost_rub), 0) AS s FROM purchases WHERE status = 'bought'").get() as any).s;
  }
}
