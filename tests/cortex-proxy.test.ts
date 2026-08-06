// The cortex-automations `session` view reaches a REMOTE API through a Garrison
// server route, because the Vault key must not reach the browser and the Cortex
// origin is routinely an address only this machine can resolve.
//
// That route is the whole reason this file exists. A credentialed forwarder is
// exactly the shape you do not want to get loose: whatever the key opens, the
// proxy opens. So the allowlist is asserted as a CLOSED set - the endpoints the
// view drives pass, and the things a widened or sloppy pattern would let
// through (a different API family, a traversal that normalises into one, an
// absolute URL, a method the endpoint does not have) are pinned as refusals.
import { describe, expect, it } from "vitest";
import { checkCortexRequest } from "@/lib/cortex-proxy";

const ID = "run_01HX8ZK9";

describe("the Cortex proxy allowlist admits the endpoints the session view drives", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "/api/v1/integrations"],
    ["GET", "/api/v1/integrations/google-workspace"],
    ["POST", "/api/v1/integrations/google-workspace/actions/gmail.messages.list/execute"],
    ["POST", "/api/v1/integrations/google-workspace/achieve"],
    ["GET", "/api/v1/automations"],
    ["POST", "/api/v1/automations"],
    ["POST", "/api/v1/automations/plan"],
    ["GET", "/api/v1/automations/runs"],
    [
      "GET",
      // Both the literal `runs` collection and a run id are one segment deep, so
      // the literal has to be its own rule or listing runs falls through.
      `/api/v1/automations/runs/${ID}`
    ],
    ["GET", `/api/v1/automations/runs/${ID}/logs`],
    ["POST", `/api/v1/automations/runs/${ID}/consent`],
    ["POST", `/api/v1/automations/runs/${ID}/resume`],
    ["POST", `/api/v1/automations/runs/${ID}/cancel`],
    ["POST", `/api/v1/automations/runs/${ID}/steps/step-3/feedback`],
    ["GET", "/api/v1/automations/auto_42"],
    ["PATCH", "/api/v1/automations/auto_42"],
    ["DELETE", "/api/v1/automations/auto_42"],
    ["POST", "/api/v1/automations/auto_42/runs"]
  ];

  it.each(allowed)("%s %s passes", (method, path) => {
    const check = checkCortexRequest(method, path);
    expect(check.ok, check.ok ? "" : check.reason).toBe(true);
  });

  it("normalises the method and preserves a simple query string", () => {
    const check = checkCortexRequest("get", "/api/v1/automations/runs?limit=20");
    expect(check).toEqual({ ok: true, method: "GET", path: "/api/v1/automations/runs?limit=20" });
  });
});

describe("the Cortex proxy allowlist is a closed set", () => {
  const refused: Array<[string, string, string]> = [
    // Key-reachable on the provider, deliberately NOT on this rig's surface.
    ["GET", "/api/v1/knowledge/collections", "another API family"],
    ["POST", "/api/v1/memvault/notes", "another API family"],
    // These three are shaped exactly like `GET /api/v1/automations/{id}`. A
    // bare `{id}` pattern admits all of them; only an explicit exclusion does
    // not.
    ["GET", "/api/v1/automations/approved-commands", "a sibling literal, not an id"],
    ["GET", "/api/v1/automations/catalog", "a sibling literal, not an id"],
    ["GET", "/api/v1/automations/plan", "plan is POST-only"],
    ["DELETE", "/api/v1/automations/runs", "runs is not an automation to delete"],
    // Method confusions: the path exists, the verb does not.
    ["DELETE", "/api/v1/integrations/google-workspace", "no delete on an integration"],
    ["GET", `/api/v1/automations/runs/${ID}/consent`, "consent is a POST"],
    ["POST", `/api/v1/automations/runs/${ID}/logs`, "logs is a GET"],
    ["PATCH", "/api/v1/automations/runs", "no patch on the run collection"],
    // Shape confusions: one segment too many or too few.
    ["GET", "/api/v1/automations/auto_42/runs", "runs on an automation is POST-only"],
    ["GET", "/api/v1/integrations/a/b", "two segments where one is allowed"],
    ["GET", "/api/v1", "a prefix is not an endpoint"],
    // Traversal. `[A-Za-z0-9_.~-]+` matches `..` happily, and joining it onto
    // the base URL would normalise it into a path the allowlist never approved.
    ["GET", "/api/v1/automations/../../admin", "relative segments"],
    ["GET", "/api/v1/automations/..", "relative segments"],
    ["GET", "/api/v1/automations/runs/./x", "relative segments"],
    // Encoded traversal: the segment charset excludes `%` precisely so an
    // encoded slash or dot cannot smuggle a second segment past a pattern.
    ["GET", "/api/v1/integrations/a%2Fb%2Fc", "percent escapes in a segment"],
    // Not a path at all - an absolute URL would retarget the whole hop.
    ["GET", "https://evil.example.com/api/v1/integrations", "an absolute URL"],
    ["GET", "//evil.example.com/api/v1/integrations", "a protocol-relative URL"]
  ];

  it.each(refused)("%s %s is refused (%s)", (method, path) => {
    expect(checkCortexRequest(method, path).ok).toBe(false);
  });

  it("refuses methods outside the four the proxy speaks", () => {
    for (const method of ["PUT", "HEAD", "OPTIONS", "TRACE", "CONNECT", ""]) {
      expect(checkCortexRequest(method, "/api/v1/integrations").ok).toBe(false);
    }
  });

  it("refuses a missing or non-string path", () => {
    expect(checkCortexRequest("GET", undefined).ok).toBe(false);
    expect(checkCortexRequest("GET", "").ok).toBe(false);
    expect(checkCortexRequest("GET", 42).ok).toBe(false);
    expect(checkCortexRequest("GET", { path: "/api/v1/integrations" }).ok).toBe(false);
  });

  it("refuses a query string carrying structure", () => {
    // A query is passed through verbatim, so it may not carry anything that
    // could re-shape the request on the far side.
    expect(checkCortexRequest("GET", "/api/v1/automations/runs?q=<script>").ok).toBe(false);
    expect(checkCortexRequest("GET", "/api/v1/automations/runs?path=/etc/passwd").ok).toBe(false);
  });

  it("names what it refused, so a wrong call is debuggable", () => {
    const check = checkCortexRequest("GET", "/api/v1/knowledge/search");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("/api/v1/knowledge/search");
  });
});
