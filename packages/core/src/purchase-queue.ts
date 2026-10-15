export class PurchaseQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.count++;
    const run = this.tail.then(job, job); // run regardless of prior outcome
    // keep the chain alive but swallow errors so one failure doesn't poison the queue
    this.tail = run.then(() => { this.count--; }, () => { this.count--; });
    return run as Promise<T>;
  }

  get pending(): number { return this.count; }
}
