// APNs sender — ported from ios-thing's proven mac-bridge/apns.js (zero
// dependencies, ES256 JWT via Node crypto, HTTP/2). Kept faithful:
//
// - `dsaEncoding: 'ieee-p1363'` yields the JOSE r||s signature APNs requires
//   (the DER default is rejected);
// - the provider JWT is cached under 40 minutes (APNs wants 20-60 min);
// - per-token outcomes {status, reason, ok, dead} so the caller prunes dead
//   tokens (410 / BadDeviceToken / Unregistered);
// - an IDEMPOTENT finalize backed by a timeout fills unresolved tokens as
//   failed, destroys the session once and resolves once — without it a
//   fire-and-forget promise never settles when the session dies mid-flight.
//
// Adaptations for this fitting: config and secrets come from the resolved cfg
// (vault-delivered APNS_TEAM_ID / APNS_KEY_ID / APNS_P8 — the key CONTENT,
// PEM or base64, same sniff the fastlane lane uses; never a path), the
// `retry-after` response header is surfaced so the notifier's backoff can
// honour it, and the http2 connect function is injectable for tests.

import crypto from "node:crypto";
import http2 from "node:http2";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The vault seals the .p8 CONTENT. Accept it pasted raw (PEM with the
// BEGIN/END lines) or base64-encoded — the same sniff as the TestFlight lane.
export function decodeP8(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.includes("BEGIN PRIVATE KEY") ? decoded : null;
  } catch {
    return null;
  }
}

export class ApnsSender {
  constructor({ cfg, counters = null, log = console, connectFn = null, now = () => Date.now(), timeoutMs = 10000 }) {
    this.cfg = cfg;
    this.counters = counters;
    this.log = log;
    this.connectFn = connectFn ?? ((origin) => http2.connect(origin));
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cachedJwt = null;
    this.cachedAt = 0;
  }

  host() {
    return this.cfg.apnsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  }

  enabled() {
    const s = this.cfg.secrets;
    return Boolean(s.apnsTeamId && s.apnsKeyId && decodeP8(s.apnsP8));
  }

  // Cache the provider JWT (APNs wants it refreshed between 20-60 min).
  providerToken() {
    const nowSec = Math.floor(this.now() / 1000);
    if (this.cachedJwt && nowSec - this.cachedAt < 2400) return this.cachedJwt; // < 40 min
    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.cfg.secrets.apnsKeyId }));
    const payload = b64url(JSON.stringify({ iss: this.cfg.secrets.apnsTeamId, iat: nowSec }));
    const signingInput = `${header}.${payload}`;
    const key = decodeP8(this.cfg.secrets.apnsP8);
    const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
    this.cachedJwt = `${signingInput}.${b64url(sig)}`;
    this.cachedAt = nowSec;
    return this.cachedJwt;
  }

  // Send one alert to many device tokens. Resolves with per-token outcomes so
  // the caller can prune dead tokens; never rejects.
  notify(tokens, { title, body, data } = {}) {
    return new Promise((resolve) => {
      if (!this.enabled()) {
        resolve({ skipped: "apns-unconfigured", results: [] });
        return;
      }
      const list = (tokens || []).filter(Boolean);
      if (!list.length) {
        resolve({ skipped: "no-tokens", results: [] });
        return;
      }

      let jwt;
      try {
        jwt = this.providerToken();
      } catch (err) {
        resolve({ error: `jwt: ${err.message}`, results: [] });
        return;
      }

      const payload = JSON.stringify({
        aps: {
          alert: { title: title || "Garrison", body: body || "" },
          sound: "default",
          // Break through Focus modes + the Scheduled Summary. Takes full
          // effect with the Time Sensitive entitlement the app carries;
          // harmless (downgraded to a normal alert) without it.
          "interruption-level": "time-sensitive"
        },
        ...(data || {})
      });

      // cfg.apnsBaseUrl is the sandboxed-E2E mock redirect (env-only test
      // hook, plain h2c); production always connects to the real gateway.
      const client = this.connectFn(this.cfg.apnsBaseUrl || `https://${this.host()}`);
      const results = new Map(); // token -> outcome
      let settled = false;
      // Idempotent teardown: fills any unresolved token as failed, closes the
      // session exactly once, resolves the promise once.
      const finalize = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const t of list) {
          if (!results.has(t)) {
            results.set(t, { token: t, status: 0, reason: "connection-closed", ok: false, dead: false, retryAfter: null });
          }
        }
        try {
          client.destroy();
        } catch {}
        resolve({ results: [...results.values()] });
      };
      const timer = setTimeout(finalize, this.timeoutMs);
      timer.unref?.();
      client.on("error", finalize);
      client.on("close", finalize);
      client.on("goaway", finalize);

      let pending = list.length;
      const settleOne = (r) => {
        if (settled || results.has(r.token)) return;
        results.set(r.token, r);
        if (--pending === 0) finalize();
      };

      for (const token of list) {
        let req;
        try {
          req = client.request({
            ":method": "POST",
            ":path": `/3/device/${token}`,
            "apns-topic": this.cfg.apnsTopic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            authorization: `bearer ${jwt}`,
            "content-type": "application/json"
          });
        } catch (err) {
          settleOne({ token, status: 0, reason: err.message, ok: false, dead: false, retryAfter: null });
          continue;
        }
        let status = 0;
        let retryAfter = null;
        let respBody = "";
        req.setEncoding("utf8");
        req.on("response", (h) => {
          status = h[":status"];
          const ra = Number.parseInt(String(h["retry-after"] ?? ""), 10);
          retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null;
        });
        req.on("data", (d) => (respBody += d));
        req.on("end", () => {
          let reason = "";
          try {
            reason = respBody ? JSON.parse(respBody).reason || "" : "";
          } catch {}
          const dead = status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
          settleOne({ token, status, reason, ok: status === 200, dead, retryAfter });
        });
        req.on("error", (err) => settleOne({ token, status: 0, reason: err.message, ok: false, dead: false, retryAfter: null }));
        req.write(payload);
        req.end();
      }
    });
  }
}
