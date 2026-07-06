// One-at-a-time serializer for orchestrator turns. The orchestrator is a single
// PTY with one stdin; concurrent turns (a voice /chat, a heartbeat /jobs, a kanban
// dispatch) otherwise interleave on that stdin AND both waiters resolve on the
// first `result`, so subscribers get another turn's deltas. This serializes: each
// turn runs only after the previous turn RELEASES (its result landed, or a safety
// timeout fired so a wedged turn can't block the queue forever).
//
// Extracted + injectable (setTimeoutFn/clearTimeoutFn) so it's unit-testable.

export function createSerializer({ maxHoldMs = 30 * 60 * 1000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let tail = Promise.resolve();

  // enqueue(fn): waits for the previous turn to release, then runs fn(release).
  // fn should do the write and return its result (e.g. a waiter); it MUST call
  // release() when the turn is done (or it releases automatically after maxHoldMs).
  // Returns whatever fn returns.
  return async function enqueue(fn) {
    const prev = tail;
    let releaseNext;
    tail = new Promise((r) => { releaseNext = r; });
    await prev.catch(() => {});
    let released = false;
    const timer = setTimeoutFn(() => { if (!released) { released = true; releaseNext(); } }, maxHoldMs);
    const release = () => {
      if (released) return;
      released = true;
      clearTimeoutFn(timer);
      releaseNext();
    };
    try {
      return await fn(release);
    } catch (err) {
      release();
      throw err;
    }
  };
}

// Resolve a promise, but if it doesn't settle within ms, resolve with onTimeout()
// instead — so a wedged orchestrator turn can't hang an HTTP request forever.
export function withTimeout(promise, ms, onTimeout, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeoutFn(() => {
      if (done) return;
      done = true;
      resolve(onTimeout());
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeoutFn(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeoutFn(timer); reject(e); } }
    );
  });
}
