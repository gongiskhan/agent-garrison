# Spike 0.2 — `tailscale status --json` shape on this machine

**Date:** 2026-05-16
**Conclusion:** `tailscale status --json` is available and well-formed. The preferred MagicDNS hostname for URL construction is `Self.DNSName` (trailing dot stripped) or `CertDomains[0]`. The current resolver in `src/lib/tailscale.ts:11-37` shells out to `tailscale ip --4`; switching to `status --json` is a strict upgrade because it yields the canonical DNS-resolvable name rather than the bare IPv4.

**Action this phase:** none — `src/lib/tailscale.ts` is NOT modified in Phase 0. Recorded so Phase 2 (or a later follow-up) can swap the resolver implementation with confidence.

## Outputs captured

`tailscale ip --4`:

```
100.108.210.116
```

`tailscale status --json` (relevant fields):

```json
{
  "Self": {
    "HostName": "Goncalo's MacBook Pro",
    "DNSName": "goncalos-macbook-pro.tail31efa.ts.net.",
    "TailscaleIPs": ["100.108.210.116", "fd7a:115c:a1e0::f933:d274"],
    "Online": true,
    "InNetworkMap": true
  },
  "MagicDNSSuffix": "tail31efa.ts.net",
  "CurrentTailnet": {
    "Name": "goncalo.p.gomes@gmail.com",
    "MagicDNSSuffix": "tail31efa.ts.net",
    "MagicDNSEnabled": true
  },
  "CertDomains": ["goncalos-macbook-pro.tail31efa.ts.net"]
}
```

## Recommended parse for a future resolver upgrade

Pseudocode:

```ts
const status = JSON.parse(await execa("tailscale", ["status", "--json"]).stdout);
// Prefer the cert-domain form (always URL-safe; identical to DNSName minus trailing dot).
const hostname = status?.CertDomains?.[0]
  ?? status?.Self?.DNSName?.replace(/\.$/, "")
  ?? status?.Self?.TailscaleIPs?.[0]
  ?? null;
if (!hostname) {
  // No tailscale → fall back to localhost (already implemented).
}
```

## Notes

- `Self.HostName` is the raw macOS host name with apostrophes and spaces (`"Goncalo's MacBook Pro"`) — DO NOT use it for URLs.
- The tailnet's `MagicDNSSuffix` (`tail31efa.ts.net`) is present and `MagicDNSEnabled: true`.
- The client/server version drift warning (`client 1.92.3 != server 1.96.5`) appears on stderr — non-fatal; the JSON parse on stdout is clean.
- `Self.InMagicSock` and `Self.InEngine` were `false` in this snapshot but `InNetworkMap` is `true` and `Online: true`, which is what matters for URL reachability across the tailnet.
- No HTTPS URL work follows from this — the locked decision is `http://` for v1 (recorded in DECISIONS.md by Phase 2.7).
