/** Each action reads the latest revision only after all preceding actions have settled. */
export class OperationQueue {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(action);
    this.pending = next;
    return next;
  }
}
