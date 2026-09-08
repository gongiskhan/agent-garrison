// Durable store of browser push subscriptions.
//
// A subscription is not a secret in the credential sense, but it IS a
// capability: anyone holding it plus the VAPID private key can push to that
// device. Written 0600 alongside the fitting's other state.
//
// Keyed by endpoint because that is what the browser regenerates on
// resubscribe — keying by anything else accumulates dead endpoints that push
// services 410 forever.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function stateDir(env = process.env) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "web-channel");
}

export function subscriptionsFile(env = process.env) {
  return path.join(stateDir(env), "push-subscriptions.json");
}

export function readSubscriptions(env = process.env) {
  const file = subscriptionsFile(env);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

function write(subscriptions, env = process.env) {
  const file = subscriptionsFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ subscriptions }, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return subscriptions;
}

// Upsert on endpoint: a browser that re-subscribes (new keys, same endpoint, or
// after a permission reset) must replace its row rather than add one, or every
// notification arrives twice.
export function saveSubscription(subscription, env = process.env, { label = null, at = new Date().toISOString() } = {}) {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    throw new Error("subscription must carry an https endpoint");
  }
  if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("subscription must carry p256dh and auth keys");
  }
  const rows = readSubscriptions(env).filter((s) => s.endpoint !== endpoint);
  rows.push({
    endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    label,
    createdAt: at
  });
  return write(rows, env);
}

export function removeSubscription(endpoint, env = process.env) {
  const rows = readSubscriptions(env);
  const next = rows.filter((s) => s.endpoint !== endpoint);
  if (next.length !== rows.length) write(next, env);
  return rows.length - next.length;
}

export function vapidFromEnv(env = process.env) {
  const publicKey = (env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY || "").trim();
  // A push service rejects a JWT whose `sub` is not mailto: or https:, with an
  // opaque error, so default to something valid rather than empty.
  const subject = (env.VAPID_SUBJECT || "").trim() || "mailto:garrison@localhost";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}
