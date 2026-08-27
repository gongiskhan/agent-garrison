// Web Push (RFC 8291 message encryption + RFC 8292 VAPID), dependency-free.
//
// Why hand-rolled instead of the `web-push` npm package: this fitting has no
// package.json and its setup hook is a single `node ui/build.mjs`. Adding a
// dependency would change that contract and put an npm install in front of
// every `up`. Node's crypto has P-256 ECDH, HMAC-SHA-256 and AES-128-GCM,
// which is the entire requirement.
//
// Why this matters at all: Web Push is the ONLY way to reach a phone with a
// background notification without shipping an app through the App Store or
// Play. iOS 16.4+ supports it for web apps ADDED TO THE HOME SCREEN — the
// permission prompt is unavailable in a plain Safari tab, so an iPhone user
// must install the PWA first. That constraint is the whole reason the UI nags
// about installing before asking for permission.

import crypto from "node:crypto";

const P256 = "prime256v1";

export function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64");
}

// A VAPID identity is a long-lived P-256 keypair. The PUBLIC key is handed to
// the browser at subscribe time and is baked into the resulting endpoint, so
// rotating it invalidates every existing subscription — treat it as durable.
export function generateVapidKeys() {
  const ecdh = crypto.createECDH(P256);
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

// ES256 JWT proving to the push service which application server is sending.
// `audience` is the ORIGIN of the push endpoint (not the full URL) and
// `subject` must be a mailto: or https: contact — push services reject both if
// malformed, with an opaque 400.
export function vapidAuthorization({ audience, subject, publicKey, privateKey, expirySeconds = 12 * 3600, now = Date.now }) {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64url(
    JSON.stringify({ aud: audience, exp: Math.floor(now() / 1000) + expirySeconds, sub: subject })
  );
  const signingInput = `${header}.${body}`;

  // Node signs ECDSA as DER; JWS wants the raw r||s pair.
  const key = crypto.createPrivateKey({
    key: derPkcs8FromRawP256(unb64url(privateKey)),
    format: "der",
    type: "pkcs8"
  });
  const der = crypto.sign("sha256", Buffer.from(signingInput), key);
  const sig = derToJose(der);
  return `vapid t=${signingInput}.${b64url(sig)}, k=${publicKey}`;
}

// Wrap a raw 32-byte P-256 scalar in the PKCS#8 envelope Node requires. The
// prefix is a fixed DER header for id-ecPublicKey/prime256v1; only the private
// scalar varies, so templating it avoids pulling in an ASN.1 encoder.
function derPkcs8FromRawP256(raw) {
  const prefix = Buffer.from("308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex");
  if (raw.length !== 32) throw new Error(`P-256 private key must be 32 bytes, got ${raw.length}`);
  return Buffer.concat([prefix, raw]);
}

// DER SEQUENCE{INTEGER r, INTEGER s} -> 64-byte r||s, left-padded.
function derToJose(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const readInt = () => {
    if (der[offset++] !== 0x02) throw new Error("malformed ECDSA signature");
    const len = der[offset++];
    let val = der.subarray(offset, offset + len);
    offset += len;
    while (val.length > 32 && val[0] === 0x00) val = val.subarray(1); // strip sign byte
    return Buffer.concat([Buffer.alloc(32 - val.length), val]);
  };
  return Buffer.concat([readInt(), readInt()]);
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// Single-block HKDF — every output here is <= 32 bytes, so one iteration is
// always enough and the counter is a constant 0x01.
function hkdf(salt, ikm, info, length) {
  return hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/**
 * RFC 8291 aes128gcm. Returns the complete body to POST: the header (salt,
 * record size, sender public key) followed by one ciphertext record.
 */
export function encryptPayload({ payload, p256dh, auth, salt = crypto.randomBytes(16), senderKeys = null }) {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  if (uaPublic.length !== 65) throw new Error(`p256dh must be a 65-byte P-256 point, got ${uaPublic.length}`);
  if (authSecret.length !== 16) throw new Error(`auth secret must be 16 bytes, got ${authSecret.length}`);

  const ecdh = crypto.createECDH(P256);
  if (senderKeys) ecdh.setPrivateKey(unb64url(senderKeys.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // The key_info binds both public keys, so a ciphertext cannot be replayed
  // against a different subscription even with the same shared secret.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // 0x02 is the last-record delimiter (0x01 would mean "more records follow").
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// Decrypt our own output. Exists so the encryption chain can be round-tripped
// in tests without a live browser subscription — a silent crypto bug would
// otherwise only show up as pushes that never arrive.
export function decryptPayload({ body, uaPrivateKey, uaPublicKey, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ecdh = crypto.createECDH(P256);
  ecdh.setPrivateKey(unb64url(uaPrivateKey));
  const sharedSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), unb64url(uaPublicKey), asPublic]);
  const ikm = hkdf(unb64url(auth), sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return out.subarray(0, out.length - 1).toString("utf8"); // drop the 0x02 delimiter
}

/**
 * Deliver one push. Returns {ok, status, gone} — `gone` marks a subscription
 * the push service has permanently rejected (404/410), which the caller MUST
 * delete, or a stale endpoint is retried forever.
 */
export async function sendPush({ subscription, payload, vapid, fetchImpl = fetch, timeoutMs = 15000 }) {
  const endpoint = subscription?.endpoint;
  if (!endpoint) return { ok: false, status: 0, gone: false, error: "no endpoint" };
  const audience = new URL(endpoint).origin;
  const body = encryptPayload({
    payload,
    p256dh: subscription.keys?.p256dh,
    auth: subscription.keys?.auth
  });
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: vapidAuthorization({ ...vapid, audience })
    },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
