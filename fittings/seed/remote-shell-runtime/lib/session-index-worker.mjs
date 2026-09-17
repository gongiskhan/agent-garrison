// Native discovery includes synchronous filesystem and CLI/database reads.
// Keep those off the HTTP/terminal thread, with one persistent worker so the
// listers retain their last successful metadata cache across refreshes.
import { Worker, parentPort, workerData } from "node:worker_threads";
import { buildIndex, ownedRows } from "./session-index.mjs";

if (workerData?.garrisonSessionIndex === true && parentPort) {
  parentPort.on("message", (options) => {
    try { parentPort.postMessage({ rows: buildIndex(options) }); }
    catch (error) { parentPort.postMessage({ error: error?.message ?? String(error) }); }
  });
}

export function createIndexBuilder({ timeoutMs = 30_000, workerUrl = new URL(import.meta.url) } = {}) {
  let worker = null;
  let pending = null;
  let closed = false;
  function finish(error, rows) {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    worker?.unref();
    if (error) request.reject(error);
    else request.resolve(rows);
  }
  function discard(current, error) {
    if (worker !== current) return;
    worker = null;
    finish(error);
    void current.terminate();
  }
  return {
    build({ manager = null, ...options } = {}) {
      if (closed) return Promise.reject(new Error("Session index builder closed"));
      if (pending) return pending.promise;
      if (!worker) {
        const current = new Worker(workerUrl, { workerData: { garrisonSessionIndex: true } });
        worker = current;
        current.on("message", (message) => {
          if (worker !== current) return;
          finish(message.error ? new Error(message.error) : null, message.rows);
        });
        current.on("error", (error) => discard(current, error));
        current.on("exit", (code) => discard(current, new Error(`Session index worker exited (${code})`)));
        current.unref();
      }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const current = worker;
      const timer = setTimeout(() => discard(current, new Error("Session index build timed out")), timeoutMs);
      timer.unref?.();
      pending = { promise, resolve, reject, timer };
      current.ref();
      try {
        // Only plain row metadata crosses the thread boundary, never PTYs,
        // sockets, event listeners or native SessionManager instances.
        current.postMessage({
          ...(process.env.VITEST ? { claudeBackgroundAgents: [] } : {}),
          ...options, ownedSessions: ownedRows(manager, options.now ?? Date.now())
        });
      } catch (error) { finish(error); }
      return promise;
    },
    async close() {
      closed = true;
      const current = worker;
      worker = null;
      finish(new Error("Session index builder closed"));
      if (current) await current.terminate();
    }
  };
}
