// Dev Env's two-phase terminal submission, shared with Conversations. Ink
// needs text/paste and Enter in separate writes or it can swallow the submit.
export async function submitTerminalText({ write, enter }, text, {
  delayMs = 600,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  signal,
} = {}) {
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error("Terminal message was cancelled before submission"), { name: "AbortError", code: "claude_message_cancelled" });
  };
  check();
  await write(text);
  await wait(delayMs);
  check();
  await enter();
}
