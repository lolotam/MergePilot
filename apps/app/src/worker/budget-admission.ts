/**
 * Monthly-budget admission for reviews running at the same time in this worker process. The
 * check is serialized per workspace, and each admitted review holds a reservation (its bots ×
 * the per-review budget) until it finishes. Admission is first come, first served: a merely
 * queued review never counts against another, and parallel reviews cannot all pass on the same
 * spend figure. Reservations live in this process only; a second worker process would admit on
 * its own.
 */
export class BudgetAdmission {
  private readonly reserved = new Map<string, number>();
  private readonly turns = new Map<string, Promise<void>>();

  /**
   * Waits for this workspace's turn, then calls `fits` with the amount other admitted reviews
   * hold. Resolves to the release function when admitted, or null when `fits` says no.
   */
  async admit(workspaceId: string, amountUsd: number, fits: (reservedUsd: number) => Promise<boolean>): Promise<(() => void) | null> {
    const previous = this.turns.get(workspaceId) ?? Promise.resolve();
    let done!: () => void;
    const mine = previous.then(() => new Promise<void>((resolve) => { done = resolve; }));
    this.turns.set(workspaceId, mine);
    await previous;
    try {
      const held = this.reserved.get(workspaceId) ?? 0;
      if (!(await fits(held))) return null;
      this.reserved.set(workspaceId, held + amountUsd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (this.reserved.get(workspaceId) ?? 0) - amountUsd;
        if (left > 1e-9) this.reserved.set(workspaceId, left);
        else this.reserved.delete(workspaceId);
      };
    } finally {
      done();
      if (this.turns.get(workspaceId) === mine) this.turns.delete(workspaceId);
    }
  }

  /** The amount admitted reviews of the workspace hold now (for tests and logs). */
  heldUsd(workspaceId: string): number {
    return this.reserved.get(workspaceId) ?? 0;
  }
}

/** The worker process's admission, shared by every job it runs. */
export const processBudgetAdmission = new BudgetAdmission();
