import type { BalancesRepo } from '../repositories/balances.ts';
import type { RefundRequestsRepo, RefundRequest } from '../repositories/refund-requests.ts';

export type RefundDecisionOutcome = 'approved' | 'rejected' | 'already' | 'not_found';

export interface RefundDecision {
  outcome: RefundDecisionOutcome;
  request: RefundRequest | null;
}

/**
 * Resolve a pending refund request, shared by the bot's inline buttons and the
 * admin API so both go through ONE idempotent path.
 *
 * The request is claimed (pending → approved/rejected) BEFORE any money moves,
 * so a double-click — or two admins acting at once — can never refund twice:
 * the second caller sees `already` and no balance changes. On approve the held
 * money is returned; on reject it stays debited.
 */
export function applyRefundDecision(
  refunds: Pick<RefundRequestsRepo, 'get' | 'resolve'>,
  balances: Pick<BalancesRepo, 'refund'>,
  id: number,
  approve: boolean,
): RefundDecision {
  const request = refunds.get(id);
  if (!request) return { outcome: 'not_found', request: null };

  const claimed = refunds.resolve(id, approve ? 'approved' : 'rejected');
  if (!claimed) return { outcome: 'already', request };

  if (approve) balances.refund(request.telegramId, request.kopecks, request.mercariUrl);
  return { outcome: approve ? 'approved' : 'rejected', request };
}
