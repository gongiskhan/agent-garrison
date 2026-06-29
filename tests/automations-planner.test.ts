import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, parsePlan, planFromBrief } from "../fittings/seed/automations/lib/planner.mjs";

// E4 — the planner turns a brief into a validated Automation, routing the model
// call through the Model Router (here the model is mocked via an injected invoke;
// the live Router path is exercised in the Z1 e2e).

const CATALOG = [
  { service: "google", auth: "oauth2", actions: [{ name: "gmail.send", mutates: true }, { name: "drive.list" }] }
];

describe("automation planner (E4)", () => {
  it("builds a prompt naming the step types, the connector catalog, and the brief", () => {
    const p = buildPlannerPrompt({ brief: "Email the latest doc as PDF", catalog: CATALOG, automationName: "Doc emailer" });
    expect(p).toContain("gmail.send*"); // mutating action flagged
    expect(p).toContain("drive.list");
    expect(p).toContain("Email the latest doc as PDF");
    for (const t of ["browser", "verify", "navigate", "wait", "local_command", "api_call", "connector", "sub_automation"]) {
      expect(p).toContain(t);
    }
  });

  it("parses a fenced ```json plan and a bare JSON plan", () => {
    const fenced = parsePlan('here:\n```json\n{"name":"X","steps":[{"type":"wait","durationMs":1}]}\n```\n');
    expect(fenced.steps).toHaveLength(1);
    const bare = parsePlan('{"name":"Y","steps":[{"type":"navigate","url":"https://x"}]}');
    expect(bare.name).toBe("Y");
  });

  it("rejects a reply that is not valid JSON or has no steps", () => {
    expect(() => parsePlan("no json here")).toThrow();
    expect(() => parsePlan('{"name":"x"}')).toThrow(/steps/);
  });

  it("planFromBrief returns a validated, normalized Automation via the injected model", async () => {
    const invoke = async (prompt: string) => {
      expect(prompt).toContain("gmail.send"); // catalog reached the model
      return JSON.stringify({
        name: "Export & email",
        description: "open the doc, download PDF, email it",
        inputs: [{ name: "recipient_email", required: true }],
        steps: [
          { id: "step-1", type: "navigate", url: "https://docs.google.com" },
          { id: "step-2", type: "browser", description: "open the most recently edited document" },
          { id: "step-3", type: "connector", connector: "google", action: "gmail.send", args: { to: "{{input.recipient_email}}" } },
          { id: "step-4", type: "verify", expectedOutcome: "the email shows as sent" }
        ]
      });
    };
    const auto = await planFromBrief({ brief: "Open latest Google Doc, download PDF, email it", catalog: CATALOG, automationName: "Export & email", invoke, now: "2026-06-26T00:00:00.000Z" });
    expect(auto.name).toBe("Export & email");
    expect(auto.steps.map((s: any) => s.type)).toEqual(["navigate", "browser", "connector", "verify"]);
    expect(auto.id).toBeTruthy();
    expect(auto.createdAt).toBe("2026-06-26T00:00:00.000Z");
  });

  it("rejects a plan that uses a non-existent step type (e.g. dropped ekoa_action)", async () => {
    const invoke = async () => JSON.stringify({ name: "bad", steps: [{ type: "ekoa_action" }] });
    await expect(planFromBrief({ brief: "x", invoke })).rejects.toThrow(/unknown type/);
  });
});
