// Card → Outpost affinity (GARRISON-UNIFY-V1 S9, D27). Self-contained: this file
// provides the SEAM the run engine uses to honour a card's `outpost` affinity, plus a
// minimal v1 dispatch that relays a run to a remote Mac. The engine wiring (parking a
// card whose named outpost is offline) is the caller's job — this module is pure policy
// + one thin transport helper, kept deliberately small.
//
// A card MAY carry `card.outpost` = the NAME of a registered outpost it must run on
// (e.g. a change that can only be validated on macOS). No affinity = run locally.

// Decide where a card should run given the live outpost list (the GET /outposts shape:
// [{ name, connected, ... }]). Pure — no I/O.
//   • no affinity            → { ok: true, local: true }        (run on the local operative)
//   • affinity, connected    → { ok: true, outpost: <name> }    (dispatch to that outpost)
//   • affinity, registered   → { ok: false, reason }            (named but offline → engine parks)
//     but offline
//   • affinity, unknown name → { ok: false, reason }            (never registered → engine parks)
export function resolveOutpostDispatch(card, outposts = []) {
  const name = typeof card?.outpost === "string" ? card.outpost.trim() : "";
  if (!name) return { ok: true, local: true };

  const list = Array.isArray(outposts) ? outposts : [];
  const entry = list.find((o) => o && o.name === name);
  if (!entry) {
    const known = list.map((o) => o?.name).filter(Boolean).join(", ") || "(none registered)";
    return {
      ok: false,
      outpost: name,
      reason: `Card is pinned to outpost "${name}", which is not registered (known: ${known}). Pair it in the Outposts view, then retry.`,
    };
  }
  if (!entry.connected) {
    return {
      ok: false,
      outpost: name,
      reason: `Card is pinned to outpost "${name}", which is registered but offline. Bring the Mac online (check the bridge), then retry.`,
    };
  }
  return { ok: true, outpost: name };
}

// A runFn-shaped async fn ({ prompt }) → { reply } that relays the run to a remote
// outpost by exec.run of a `claude -p` invocation on the Mac, via the host's blocking
// RPC endpoint (POST /outposts/:name/rpc).
//
// v1 dispatch — deliberately minimal and honest about its limits:
//   • The prompt is base64-encoded and decoded on the remote, so no shell-quoting of a
//     multi-line prompt is needed; it is piped into `claude -p` (print mode) over stdin.
//   • The host relays RPCs with a short blocking timeout (~10s), so this path suits
//     SHORT exec.run work. A full, long-running interactive `claude` turn is FUTURE work:
//     outposts will run their own gateway and the run will dispatch through it, not through
//     a single blocking exec.run. Do not grow this function toward that — it is the seam,
//     not the destination.
export function outpostRunFn(daemonUrl, outpostName) {
  const base = String(daemonUrl || "http://127.0.0.1:3702").replace(/\/+$/, "");
  return async ({ prompt }) => {
    const b64 = Buffer.from(String(prompt ?? ""), "utf8").toString("base64");
    // Decode the prompt on the remote and pipe it into claude print-mode. printf keeps the
    // base64 blob intact (no interpolation); base64 -d is present on macOS + Linux.
    const command = `printf %s ${b64} | base64 -d | claude -p`;
    const res = await fetch(`${base}/outposts/${encodeURIComponent(outpostName)}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-caller": "kanban" },
      body: JSON.stringify({ type: "exec.run", payload: { command } }),
    });
    if (!res.ok) {
      throw new Error(`outpost dispatch to "${outpostName}" failed: HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(data.error || `outpost dispatch to "${outpostName}" failed`);
    }
    const payload = data.result?.payload ?? {};
    const reply = payload.stdout ?? payload.output ?? payload.text ?? "";
    return { reply: String(reply) };
  };
}
