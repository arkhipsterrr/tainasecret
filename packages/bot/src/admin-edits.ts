import type { PricingKey } from '@arhip/db';

/**
 * A single pending force-reply edit an admin has started from a user card:
 * either setting a pricing knob (`key` present) or topping up a balance.
 */
export interface PendingEdit {
  action: 'pricing' | 'topup';
  targetId: number;
  key?: PricingKey;
}

/**
 * In-memory map of admin_id → the edit they're currently entering. A card
 * button (uedit/utopup) records the pending edit; the admin's next text reply
 * consumes it. Single-process, deliberately not persisted — a bot restart just
 * cancels any half-entered edit (the admin re-clicks the button).
 */
export class PendingEdits {
  private m = new Map<number, PendingEdit>();
  set(adminId: number, e: PendingEdit): void { this.m.set(adminId, e); }
  /** Read and remove the pending edit for this admin (one-shot). */
  take(adminId: number): PendingEdit | undefined {
    const e = this.m.get(adminId);
    this.m.delete(adminId);
    return e;
  }
}
