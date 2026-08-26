// Is the CLIENT leg of a dev tunnel actually carrying traffic?
//
// WHY THIS IS NOT A `net.connect`. The host side of this fitting already learnt
// that liveness is not health (scripts/host-tunnel.sh) - a `devtunnel host` the
// relay kicked stays alive, hosting nothing. The client side has the same
// disease one level lower: `devtunnel connect` opens 127.0.0.1:<port> and then
// stops servicing it. The listener is still there, so the kernel completes the
// three-way handshake out of the accept backlog and a connect-only probe
// reports "up" for a forward that has never moved a byte. That is exactly the
// outage that produced "Connection timed out during banner exchange" against a
// tunnel a 12-deep accept queue had already given up on, and the reason
// forwards.mjs's probeRoundTrip exists for the ssh -L case.
//
// So the probe asks for EVIDENCE, and the cheapest evidence on an ssh port is
// the identification string sshd sends unprompted the moment the connection
// establishes: ~50 bytes, one round trip, and receiving it proves the whole
// chain - local listener, `devtunnel connect`, Microsoft's relay, `devtunnel
// host` on the far box, and that box's sshd. Nothing else here is end to end
// that cheaply, and this is literally the check the ssh client itself fails
// when the tunnel is wedged, so the probe reproduces the real failure rather
// than approximating it.

import net from "node:net";

/**
 * Probe an ssh endpoint for its banner.
 *
 * TWO INDEPENDENT DEADLINES, deliberately. The connect half is loopback and
 * must be short; the banner half crosses the relay and the remote's sshd and
 * must be generous. A single combined timeout cannot express "the local half is
 * fine, the far half is not" - which is the entire diagnosis.
 *
 * Resolves one of:
 *   {state:"up",      banner, ms}   the chain carries
 *   {state:"wedged",  detail, ms}   connected, not one byte back  (accept-backlog wedge)
 *   {state:"refused", detail, ms}   nothing accepting             (client died / never bound)
 *   {state:"closed",  detail, ms}   accepted then hung up
 *   {state:"foreign", head, ms}     something answered, but it is not ssh
 *
 * VERDICTS, NOT A BOOLEAN, because the actions differ: a wedge is repaired by
 * replacing the client, and `foreign` must never be repaired at all - some
 * other service owns that port and killing anything over it would be vandalism.
 */
export function probeSshBanner(host, port, { connectMs = 1500, readMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let connected = false;
    let head = "";
    let readTimer = null;
    const sock = net.connect({ host, port });
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ ...out, ms: Date.now() - startedAt });
    };
    const connectTimer = setTimeout(
      () => done({ state: "refused", detail: `no TCP connect to ${host}:${port} within ${connectMs}ms` }),
      connectMs
    );
    sock.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      readTimer = setTimeout(
        () => done({
          state: "wedged",
          detail: `127.0.0.1:${port} accepted the connection but sent no ssh banner within ${readMs}ms - the listener is up and servicing nothing`
        }),
        readMs
      );
      // sshd speaks first, so this write is not needed to elicit the banner. It
      // is here so the far end logs an ordinary protocol disconnect instead of
      // "Did not receive identification string", which is the port-scanner line
      // and would make the remote's auth log unreadable at one probe per tick.
      try { sock.write("SSH-2.0-Garrison-Probe\r\n"); } catch { /* the error handler has it */ }
    });
    sock.on("data", (d) => {
      head += d.toString("latin1");
      if (head.startsWith("SSH-")) {
        return done({ state: "up", banner: head.split(/\r?\n/)[0].trim().slice(0, 120) });
      }
      // Fewer than four bytes cannot rule "SSH-" in or out yet.
      if (head.length >= 4) return done({ state: "foreign", head: head.slice(0, 120) });
    });
    sock.on("error", (err) => done(
      connected
        ? { state: "closed", detail: `the far end dropped the connection: ${err.message}` }
        : { state: "refused", detail: err.message }
    ));
    sock.on("close", () => done(
      connected
        ? { state: "closed", detail: "the far end accepted and then closed without a banner" }
        : { state: "refused", detail: `nothing is listening on ${host}:${port}` }
    ));
  });
}

/**
 * Turn a tunnel description into the one sentence that says what to DO about
 * it, or null when the description gives no reason not to try connecting.
 * Pure, so the wording is pinned by a test rather than by whoever last read a
 * log - this string is the whole user-facing diagnosis.
 */
export function explainTunnel(info, dt) {
  if (info.ok) {
    if (info.hostConnections === 0) {
      return `nothing is hosting devtunnel ${dt.tunnel}: the tunnel exists and this box is logged in, but no machine is running \`devtunnel host\` for it. Start it ON THE REMOTE - \`devtunnel host ${dt.tunnel}\` - then retry. Logging in again here changes nothing.`;
    }
    if (info.ports.length && !info.ports.includes(dt.port)) {
      return `devtunnel ${dt.tunnel} is hosted but forwards no port ${dt.port} (it carries ${info.ports.join(", ")}). Add it on the remote: \`devtunnel port create ${dt.tunnel} -p ${dt.port}\`.`;
    }
    return null;
  }
  if (info.reason === "login") {
    const lede = info.expired
      ? `this box's dev tunnels login has EXPIRED (a GitHub login lasts well under a day), so ${dt.tunnel} cannot be reached`
      : `this box is not logged in to dev tunnels, so ${dt.tunnel} cannot be reached`;
    return `${lede} - run \`devtunnel user login -g -d\` as this user, HERE, not on the remote. (Each Garrison instance redirects XDG_DATA_HOME, so the login must be visible at $XDG_DATA_HOME/DevTunnels; the setup hook links the real store in.)`;
  }
  if (info.reason === "missing") {
    return `devtunnel ${dt.tunnel} does not exist - deleted, or owned by a different account than the one logged in here. Recreate it and repoint the transport.`;
  }
  return null;
}

/**
 * The verb `explainTunnel` deliberately does not supply.
 *
 * explainTunnel answers "what should the human read"; this answers "what should
 * the process DO", and the difference matters most where the old code had
 * neither: a description it could not interpret returned null, which the caller
 * read as PERMISSION TO PROCEED. Under a saturated uplink `devtunnel show` is
 * precisely what times out, so the least-informed case was silently the most
 * eager one. `unknown` is now its own action with its own repair cap.
 *
 *   replace - the service says the remote is hosting our port; the broken half
 *             is ours, so replacing the local client can fix it.
 *   park    - nothing a local client can do (nobody hosting, no such port,
 *             credential lapsed, tunnel gone). Spawning one would burn the
 *             settle window and change nothing.
 *   unknown - we could not find out. Try, but count the tries.
 */
export function classifyTunnel(info, dt) {
  const message = explainTunnel(info, dt);
  if (info?.ok) {
    if (info.hostConnections === 0) return { action: "park", reason: "unhosted", message };
    if (info.ports?.length && !info.ports.includes(dt.port)) {
      return { action: "park", reason: "no-port", message };
    }
    return { action: "replace", reason: "hosted", message: null };
  }
  if (info?.reason === "login") return { action: "park", reason: "login", message };
  if (info?.reason === "missing") return { action: "park", reason: "missing", message };
  return { action: "unknown", reason: "unknown", message: null };
}
