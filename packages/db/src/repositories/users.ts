import type { Db } from '../connection.ts';

export type UserStatus = 'pending' | 'active' | 'blocked';
export interface User {
  telegramId: number; username: string | null; status: UserStatus;
  balanceRub: number; createdAt: string;
}
const row2user = (r: any): User => r && ({
  telegramId: r.telegram_id, username: r.username, status: r.status,
  balanceRub: r.balance_rub, createdAt: r.created_at,
});

export class UsersRepo {
  constructor(private db: Db, private now: () => string) {}

  upsertOnStart(telegramId: number, username: string | null): User {
    this.db.prepare(
      `INSERT INTO users (telegram_id, username, status, balance_rub, created_at)
       VALUES (?, ?, 'pending', 0, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`
    ).run(telegramId, username, this.now());
    return this.get(telegramId)!;
  }
  get(telegramId: number): User | null {
    return row2user(this.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId)) ?? null;
  }
  /** Look up by username, tolerating a leading '@' and case differences. */
  getByUsername(username: string): User | null {
    const name = username.trim().replace(/^@/, '');
    if (!name) return null;
    return row2user(
      this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name),
    ) ?? null;
  }
  /** Total kopecks held across all user balances. */
  totalBalance(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(balance_rub), 0) AS s FROM users').get() as any).s;
  }
  setStatus(telegramId: number, status: UserStatus): void {
    this.db.prepare('UPDATE users SET status = ? WHERE telegram_id = ?').run(status, telegramId);
  }
  list(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(row2user);
  }
}
