// Human-like send pacing (brief rule 6): every actual send goes through this
// queue, which (a) never runs two sends concurrently and (b) inserts a
// randomized delay before each one. There is no batch-send action anywhere in
// this Fitting's catalog, so the ONLY way a message reaches the wire is one
// call at a time through here — even a caller that fired several send_text
// calls back to back would still have them paced out serially, never bursted.
export function randomDelayMs(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export class SendQueue {
  constructor({ minDelayMs = 1200, maxDelayMs = 3500, sleep } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tail = Promise.resolve();
  }

  enqueue(task) {
    const run = this.tail.then(async () => {
      await this.sleep(randomDelayMs(this.minDelayMs, this.maxDelayMs));
      return task();
    });
    // Swallow the outcome in the chain itself so one rejected send does not
    // wedge every send queued after it; the caller's own awaited `run` still
    // sees the real rejection.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
