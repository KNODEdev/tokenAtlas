/** Aim of one batch transaction: well under a second, so a waiting writer or reader is not starved. */
export const BATCH_MS = 400;

/**
 * Runs `step(size)` in successive transactions until it reports it is done. `size` is how many
 * units the step may take; it grows while batches stay short and shrinks when one took longer
 * than {@link BATCH_MS}, never below one.
 */
export function runInBatches(transact: (work: () => void) => void, step: (size: number) => boolean, initialSize = 1): void {
  let size = Math.max(1, initialSize);
  for (;;) {
    let done = false;
    const started = performance.now();
    transact(() => { done = step(size); });
    if (done) return;
    const elapsed = performance.now() - started;
    size = Math.max(1, Math.min(size * 4, Math.floor(size * BATCH_MS / Math.max(elapsed, 1))));
  }
}
