// JSON-line logger used across the gateway. Runner tails stdout/stderr.

export function logEvent(stream, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: "http-gateway",
    stream,
    ...payload
  });
  if (stream === "stderr") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function logTagged(tag, payload) {
  logEvent("stdout", { kind: tag, ...payload });
}
