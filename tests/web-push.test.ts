// Web Push crypto (RFC 8291 / RFC 8292), hand-rolled because the fitting has no
// dependencies. A subtle mistake here does not throw - it produces ciphertext
// the push service accepts and the phone silently discards, which is
// indistinguishable from "notifications just don't work". So the encryption
// chain is round-tripped, and the VAPID JWT is verified with a real public key.
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  b64url,
  unb64url,
  generateVapidKeys,
  vapidAuthorization,
  encryptPayload,
  decryptPayload,
  sendPush
} from "../fittings/seed/web-channel-default/lib/webpush.mjs";

// Stand in for a browser's PushSubscription: a P-256 keypair plus a 16-byte
// auth secret, exactly what the Push API hands the page.
function fakeSubscription(endpoint = "https://push.example.com/sub/abc") {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    subscription: {
      endpoint,
      keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(crypto.randomBytes(16)) }
    },
    uaPrivateKey: b64url(ecdh.getPrivateKey()),
    uaPublicKey: b64url(ecdh.getPublicKey())
  };
}

describe("web push encryption (RFC 8291)", () => {
  it("round-trips a payload through the real derivation chain", () => {
    const { subscription, uaPrivateKey, uaPublicKey } = fakeSubscription();
    const payload = JSON.stringify({ title: "Garrison", body: "Book the car service" });
    const body = encryptPayload({
      payload,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    });
    const out = decryptPayload({
      body,
      uaPrivateKey,
      uaPublicKey,
      auth: subscription.keys.auth
    });
    expect(out).toBe(payload);
  });

  it("survives a payload with unicode and emoji-free accented text", () => {
    const { subscription, uaPrivateKey, uaPublicKey } = fakeSubscription();
    const payload = JSON.stringify({ title: "Lembrar", body: "Amanhã pode chover — às 10h" });
    const body = encryptPayload({ payload, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
    expect(decryptPayload({ body, uaPrivateKey, uaPublicKey, auth: subscription.keys.auth })).toBe(payload);
  });

  it("lays the header out as salt(16) || rs(4) || idlen(1) || senderKey(65)", () => {
    const { subscription } = fakeSubscription();
    const body = encryptPayload({
      payload: "x",
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      salt: Buffer.alloc(16, 7)
    });
    expect(body.subarray(0, 16).equals(Buffer.alloc(16, 7))).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65); // uncompressed P-256 point
    expect(body[21]).toBe(0x04); // …and it really is uncompressed
  });

  it("rejects malformed subscription keys instead of sending garbage", () => {
    expect(() => encryptPayload({ payload: "x", p256dh: b64url(Buffer.alloc(10)), auth: b64url(Buffer.alloc(16)) }))
      .toThrow(/65-byte/);
    const { subscription } = fakeSubscription();
    expect(() => encryptPayload({ payload: "x", p256dh: subscription.keys.p256dh, auth: b64url(Buffer.alloc(8)) }))
      .toThrow(/16 bytes/);
  });

  it("produces a different ciphertext every time (fresh salt and sender key)", () => {
    const { subscription } = fakeSubscription();
    const args = { payload: "same", p256dh: subscription.keys.p256dh, auth: subscription.keys.auth };
    expect(encryptPayload(args).equals(encryptPayload(args))).toBe(false);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT that verifies against the advertised public key", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({
      audience: "https://push.example.com",
      subject: "mailto:goncalo@ekoa.io",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(m).toBeTruthy();
    const [, jwt, advertisedKey] = m!;
    expect(advertisedKey).toBe(keys.publicKey);

    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(unb64url(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(unb64url(p).toString());
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe("mailto:goncalo@ekoa.io");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The signature must verify with the SAME public key we hand the browser,
    // or the push service rejects every send with an opaque 401.
    const pub = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
        unb64url(keys.publicKey)
      ]),
      format: "der",
      type: "spki"
    });
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: pub, dsaEncoding: "ieee-p1363" },
      unb64url(s)
    );
    expect(ok).toBe(true);
  });

  it("scopes the audience to the push endpoint's ORIGIN, not its full URL", async () => {
    const keys = generateVapidKeys();
    const { subscription } = fakeSubscription("https://fcm.googleapis.com/fcm/send/long-token-here");
    let seen: { url: string; headers: Record<string, string> } | null = null;
    await sendPush({
      subscription,
      payload: "hi",
      vapid: { subject: "mailto:a@b.c", publicKey: keys.publicKey, privateKey: keys.privateKey },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string> };
        return { ok: true, status: 201 } as Response;
      }) as unknown as typeof fetch
    });
    const claims = JSON.parse(unb64url(seen!.headers.Authorization.match(/t=[^.]+\.([^.]+)\./)![1]).toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(seen!.headers["Content-Encoding"]).toBe("aes128gcm");
  });
});

describe("push delivery outcomes", () => {
  const keys = generateVapidKeys();
  const vapid = { subject: "mailto:a@b.c", publicKey: keys.publicKey, privateKey: keys.privateKey };

  it("flags 404 and 410 as gone so the caller deletes the subscription", async () => {
    const { subscription } = fakeSubscription();
    for (const status of [404, 410]) {
      const res = await sendPush({
        subscription,
        payload: "x",
        vapid,
        fetchImpl: (async () => ({ ok: false, status }) as Response) as unknown as typeof fetch
      });
      expect(res.gone).toBe(true);
    }
  });

  it("does not mark a transient 500 as gone", async () => {
    const { subscription } = fakeSubscription();
    const res = await sendPush({
      subscription,
      payload: "x",
      vapid,
      fetchImpl: (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch
    });
    expect(res.gone).toBe(false);
    expect(res.ok).toBe(false);
  });
});

// The fan-out (kanban-loop): a reminder must reach EVERY notify-capable channel,
// not just the first match. Discovery is by probing running fittings rather than
// a hardcoded transport map - that map is why slack-channel, which has existed
// and can post, was invisible to notifications.
describe("multi-channel notification fan-out", () => {
  it("delivers to every fitting that accepts /notify and skips those that 404", async () => {
    const { fanOutNotification } = await import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "fanout-"));
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    for (const [id, port] of [["web-channel-default", 1], ["omi-channel", 2], ["drill", 3]]) {
      writeFileSync(
        path.join(home, "ui-fittings", `${id}.json`),
        JSON.stringify({ fittingId: id, url: `http://127.0.0.1:${port}` })
      );
    }
    const prev = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;

    const hits: string[] = [];
    const res = await fanOutNotification(
      { title: "Card due", text: "hello" },
      {
        fetchImpl: (async (url: string) => {
          hits.push(url);
          // drill is not a channel: it has no /notify route.
          return url.includes(":3/") ? { ok: false, status: 404 } : { ok: true, status: 200 };
        }) as unknown as typeof fetch
      }
    );

    if (prev === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prev;
    rmSync(home, { recursive: true, force: true });

    expect(hits).toHaveLength(3); // probed all three
    expect(res.map((r: { id: string }) => r.id).sort()).toEqual(["omi-channel", "web-channel-default"]);
  });

  it("skips the origin channel so the favourite surface is not notified twice", async () => {
    const { fanOutNotification } = await import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "fanout-skip-"));
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    for (const id of ["web-channel-default", "omi-channel"]) {
      writeFileSync(path.join(home, "ui-fittings", `${id}.json`), JSON.stringify({ fittingId: id, url: "http://127.0.0.1:1" }));
    }
    const prev = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;
    const res = await fanOutNotification(
      { title: "t", text: "x" },
      {
        skipFittingIds: ["omi-channel"],
        fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
      }
    );
    if (prev === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    expect(res.map((r: { id: string }) => r.id)).toEqual(["web-channel-default"]);
  });

  it("one wedged channel does not stop the others", async () => {
    const { fanOutNotification } = await import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "fanout-wedged-"));
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    for (const [id, port] of [["web-channel-default", 1], ["omi-channel", 2]]) {
      writeFileSync(path.join(home, "ui-fittings", `${id}.json`), JSON.stringify({ fittingId: id, url: `http://127.0.0.1:${port}` }));
    }
    const prev = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;
    const res = await fanOutNotification(
      { title: "t", text: "x" },
      {
        fetchImpl: (async (url: string) => {
          if (url.includes(":2/")) throw new Error("connection refused");
          return { ok: true, status: 200 };
        }) as unknown as typeof fetch
      }
    );
    if (prev === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    expect(res.map((r: { id: string }) => r.id)).toEqual(["web-channel-default"]);
  });
});
