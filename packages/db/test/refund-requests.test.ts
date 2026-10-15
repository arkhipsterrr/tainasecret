import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { RefundRequestsRepo } from '../src/repositories/refund-requests.ts';

const now = () => '2026-09-14T00:00:00.000Z';

describe('RefundRequestsRepo', () => {
  let repo: RefundRequestsRepo;
  beforeEach(() => {
    const db = openDb(':memory:'); migrate(db);
    repo = new RefundRequestsRepo(db, now);
  });

  it('creates a pending request and reads it back', () => {
    const id = repo.create({ telegramId: 1, mercariUrl: 'u', kopecks: 6000, reason: 'error', runId: 'r1' });
    const r = repo.get(id)!;
    expect(r.telegramId).toBe(1);
    expect(r.status).toBe('pending');
    expect(r.kopecks).toBe(6000);
    expect(r.reason).toBe('error');
    expect(r.runId).toBe('r1');
    expect(r.resolvedAt).toBeNull();
  });

  it('lists only pending requests, newest first', () => {
    const a = repo.create({ telegramId: 1, mercariUrl: 'a', kopecks: 100, reason: 'error' });
    const b = repo.create({ telegramId: 1, mercariUrl: 'b', kopecks: 200, reason: 'error' });
    repo.resolve(b, 'approved');
    expect(repo.listPending().map((r) => r.id)).toEqual([a]);
  });

  it('resolve transitions pending → approved exactly once (guards double-click)', () => {
    const id = repo.create({ telegramId: 1, mercariUrl: 'u', kopecks: 100, reason: 'error' });
    expect(repo.resolve(id, 'approved')).toBe(true);
    expect(repo.get(id)!.status).toBe('approved');
    expect(repo.get(id)!.resolvedAt).toBe(now());
    // A second decision on an already-resolved request is a no-op.
    expect(repo.resolve(id, 'rejected')).toBe(false);
    expect(repo.get(id)!.status).toBe('approved');
  });

  it('get returns null for an unknown id', () => {
    expect(repo.get(999)).toBeNull();
  });
});
