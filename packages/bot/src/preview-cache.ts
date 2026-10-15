export interface CachedPreview { url: string; title: string; priceJpy: number }

export class PreviewCache {
  private map = new Map<string, { userId: number; at: number; data: CachedPreview }>();
  private seq = 0;
  constructor(private ttlMs: number, private now: () => number) {}

  put(userId: number, data: CachedPreview): string {
    const id = (++this.seq).toString(36);
    this.map.set(id, { userId, at: this.now(), data });
    return id;
  }
  take(userId: number, id: string): CachedPreview | null {
    const e = this.map.get(id);
    if (!e) return null;
    if (e.userId !== userId) return null;
    if (this.now() - e.at > this.ttlMs) { this.map.delete(id); return null; }
    this.map.delete(id);
    return e.data;
  }

  /** Number of entries currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.map.size;
  }

  /**
   * Evict every expired entry. `take()` only expires entries lazily on access,
   * so previews the user never acted on would leak forever; call this on an
   * interval. Returns the number of entries removed.
   */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [id, e] of this.map) {
      if (t - e.at > this.ttlMs) { this.map.delete(id); removed++; }
    }
    return removed;
  }
}
