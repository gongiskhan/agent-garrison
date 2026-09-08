// The native SDK can admit a prompt while configured MCP servers are still
// pending. Hold input at the host boundary so the first inference sees the same
// working tools as subsequent turns. No configured servers means no extra work.
export function createMcpReadyQuery(queryFactory, { prompt, options }, { timeoutMs = 15_000, pollMs = 100 } = {}) {
  const names = Object.keys(options?.mcpServers ?? {});
  if (!names.length) return queryFactory({ prompt, options });

  let releaseInput;
  const inputReady = new Promise((resolve) => { releaseInput = resolve; });
  let connected = false;
  let stopped = false;
  let rejectStop;
  const stop = new Promise((_, reject) => { rejectStop = reject; });
  // This rejection may precede the first iterator read during synchronous close.
  stop.catch(() => {});
  const abortError = () => Object.assign(new Error("Agent SDK MCP startup was cancelled"), { name: "AbortError" });
  const cancelStartup = () => {
    if (connected || stopped) return;
    stopped = true;
    releaseInput(false);
    rejectStop(abortError());
  };
  const input = (async function* () {
    if (!(await inputReady) || stopped) return;
    if (typeof prompt === "string") {
      yield { type: "user", session_id: "", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    } else {
      for await (const message of prompt) yield message;
    }
  })();
  const client = queryFactory({ prompt: input, options });
  const signal = options?.abortController?.signal;
  signal?.addEventListener("abort", cancelStartup, { once: true });
  if (signal?.aborted) cancelStartup();
  let last = names.map((name) => `${name}: pending`).join(", ");
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error(`Agent SDK MCP startup timed out after ${timeoutMs}ms (${last}); no prompt was sent`)), timeoutMs);
  });
  const readiness = (async () => {
    try {
      if (typeof client.mcpServerStatus !== "function") throw new Error("Agent SDK cannot verify configured MCP server readiness; no prompt was sent");
      while (true) {
        const statusRequest = Promise.resolve().then(() => client.mcpServerStatus()).catch(() => {
          throw new Error(`Agent SDK could not verify configured MCP server readiness (${last}); no prompt was sent`);
        });
        const statuses = await Promise.race([statusRequest, stop, timeout]);
        const selected = names.map((name) => ({ name, status: statuses.find((server) => server.name === name)?.status ?? "pending" }));
        last = selected.map(({ name, status }) => `${name}: ${status}`).join(", ");
        if (selected.some(({ status }) => ["failed", "needs-auth", "disabled"].includes(status))) {
          throw new Error(`Agent SDK configured MCP server is unavailable (${last}); no prompt was sent`);
        }
        if (selected.every(({ status }) => status === "connected")) {
          if (stopped) throw abortError();
          connected = true;
          releaseInput(true);
          return;
        }
        let poll;
        try {
          await Promise.race([new Promise((resolve) => { poll = setTimeout(resolve, pollMs); }), stop, timeout]);
        } finally { clearTimeout(poll); }
      }
    } catch (error) {
      releaseInput(false);
      try { client.close(); } catch { /* failed startup is already closed */ }
      throw error;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancelStartup);
    }
  })();
  readiness.catch(() => {});

  // Preserve the Query's control methods and their receiver. Closing/interrupting
  // during startup must release a blocked iterator without ever admitting input.
  // An interrupted standing query is rebuilt by the adapter after its pump exits.
  let proxy;
  proxy = new Proxy(client, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => proxy;
      if (property === "next") return async (...args) => { await readiness; return target.next(...args); };
      if (property === "return") return async (...args) => {
        if (!connected) { cancelStartup(); target.close(); return { done: true, value: args[0] }; }
        return target.return(...args);
      };
      if (property === "close") return (...args) => { cancelStartup(); return target.close(...args); };
      if (property === "interrupt") return async (...args) => {
        if (!connected) { cancelStartup(); target.close(); return; }
        return target.interrupt(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}
