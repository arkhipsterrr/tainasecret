import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { UsersRepo } from '../src/repositories/users.ts';
import { BalancesRepo } from '../src/repositories/balances.ts';

const now = () => '2026-09-12T00:00:00.000Z';

describe('UsersRepo', () => {
  let repo: UsersRepo;
  beforeEach(() => { const db = openDb(':memory:'); migrate(db); repo = new UsersRepo(db, now); });

  it('creates a pending user on first start and is idempotent', () => {
    const u = repo.upsertOnStart(42, 'neo');
    expect(u.status).toBe('pending');
    expect(u.balanceRub).toBe(0);
    const again = repo.upsertOnStart(42, 'neo2'); // updates username, keeps status/balance
    expect(again.status).toBe('pending');
    expect(again.username).toBe('neo2');
  });

  it('sets status', () => {
    repo.upsertOnStart(42, 'neo');
    repo.setStatus(42, 'active');
    expect(repo.get(42)!.status).toBe('active');
  });

  it('getByUsername finds a user, tolerating a leading @ and case', () => {
    repo.upsertOnStart(42, 'Neo');
    expect(repo.getByUsername('Neo')!.telegramId).toBe(42);
    expect(repo.getByUsername('@Neo')!.telegramId).toBe(42);
    expect(repo.getByUsername('neo')!.telegramId).toBe(42); // case-insensitive
    expect(repo.getByUsername('nobody')).toBeNull();
  });

  it('totalBalance sums balances across all users (kopecks)', () => {
    const db = openDb(':memory:'); migrate(db);
    const users = new UsersRepo(db, now);
    const balances = new BalancesRepo(db, now);
    users.upsertOnStart(1, 'a'); users.upsertOnStart(2, 'b');
    balances.topup(1, 30000, 's'); balances.topup(2, 12000, 's');
    expect(users.totalBalance()).toBe(42000);
  });

  // Fix 4: upsertOnStart must not overwrite status or balance
  it('upsertOnStart preserves status and balance when the user restarts', () => {
    const db = openDb(':memory:'); migrate(db);
    const users = new UsersRepo(db, now);
    const balances = new BalancesRepo(db, now);

    // Initial registration and activation.
    users.upsertOnStart(1, 'alice');
    users.setStatus(1, 'active');
    // Add some balance.
    balances.topup(1, 5000, 'seed');
    expect(users.get(1)!.balanceRub).toBe(5000);

    // User restarts the bot (new username).
    users.upsertOnStart(1, 'alice_new');

    const after = users.get(1)!;
    expect(after.status).toBe('active');        // status preserved
    expect(after.balanceRub).toBe(5000);         // balance unchanged
    expect(after.username).toBe('alice_new');    // username updated
  });
});
