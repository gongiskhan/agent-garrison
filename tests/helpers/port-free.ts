import net from "node:net";

// Many fixture suites bind FIXED loopback ports and then poll /health until
// something answers. When a previous run was killed before its afterAll (a
// Ctrl-C, a runner timeout), the servers it spawned keep those ports, the new
// spawn dies on EADDRINUSE unseen (stdio is ignored), and the poll happily
// accepts the stranger - the test then runs against yesterday's state and
// fails on a phantom. Refusing up front names the squatter instead.
export async function assertPortFree(port: number, host = "127.0.0.1"): Promise<void> {
  const open = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(1000);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
  if (open) {
    throw new Error(
      `port ${host}:${port} already has a listener - a fixture server from an earlier run is still alive. ` +
      `Find it with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` and stop it before rerunning.`
    );
  }
}

export async function assertPortsFree(ports: number[], host = "127.0.0.1"): Promise<void> {
  for (const port of ports) await assertPortFree(port, host);
}
