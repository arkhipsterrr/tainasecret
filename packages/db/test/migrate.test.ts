import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';

describe('migrate', () => {
  it('creates the three tables idempotently', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db); // idempotent
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['users', 'balance_txns', 'purchases']));
  });
});
