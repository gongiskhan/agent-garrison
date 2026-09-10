import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// The briefing's destination used to be hardcoded to Slack's report_channel —
// a key that exists in this Fitting's own prose and NOWHERE in the codebase. So
// every fire composed a briefing and dropped it: the scheduler logged exit 0,
// the gateway logged a routed turn, and nothing was ever delivered. `delivery`
// makes the destination explicit and, more importantly, makes a destination
// that cannot deliver fail LOUDLY instead of looking like a quiet morning.

const ROOT = path.resolve(__dirname, "..");
const FITTING = path.join(ROOT, "fittings/seed/morning-briefing");
const SCRIPT = path.join(FITTING, "scripts/briefing.py");

function render(
  env: Record<string, string>
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("python3", [SCRIPT, "--render-prompt", "2026-09-10"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

const JID = "351900000000@s.whatsapp.net";

describe("morning-briefing delivery destinations", () => {
  it("defaults to slack, keeping the historical prompt verbatim", () => {
    const r = render({
      GARRISON_BRIEFING_DELIVERY: "",
      GARRISON_BRIEFING_WHATSAPP_JID: "",
      MORNING_BRIEFING_DELIVERY: "",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(r.stdout).toContain("report_channel");
  });

  it("whatsapp delivery names the exact JID and forbids resolve_contact", () => {
    const r = render({
      GARRISON_BRIEFING_DELIVERY: "whatsapp",
      GARRISON_BRIEFING_WHATSAPP_JID: JID,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(JID);
    expect(r.stdout).toContain("send_text");
    // A briefing must never let the model pick a recipient by name.
    expect(r.stdout).toContain("do NOT call");
    expect(r.stdout).toContain("resolve_contact");
    expect(r.stdout).not.toContain("slack_send_message");
  });

  it("tells the model that a queued send is success, not a failure to retry", () => {
    // send_text parks an agent-triggered message for a 60s cancel window and
    // returns queued:true. Read as an error, the model retries and the
    // principal gets the same briefing twice every morning.
    const r = render({
      GARRISON_BRIEFING_DELIVERY: "whatsapp",
      GARRISON_BRIEFING_WHATSAPP_JID: JID,
    });
    expect(r.stdout).toContain("60-second cancel window");
    expect(r.stdout).toContain("do not call send_text a second");
  });

  it("stdout delivery composes without sending anywhere", () => {
    const r = render({ GARRISON_BRIEFING_DELIVERY: "stdout" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).not.toContain("slack_send_message");
    expect(r.stdout).not.toContain("send_text");
  });

  it("refuses whatsapp delivery with no JID rather than composing into the void", () => {
    const r = render({
      GARRISON_BRIEFING_DELIVERY: "whatsapp",
      GARRISON_BRIEFING_WHATSAPP_JID: "",
      MORNING_BRIEFING_WHATSAPP_JID: "",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("whatsapp_jid");
  });

  it("rejects an unknown delivery instead of silently defaulting", () => {
    const r = render({ GARRISON_BRIEFING_DELIVERY: "carrier-pigeon" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown delivery");
  });

  it("honours the runner-projected config name, not just the GARRISON_ override", () => {
    // setupConfigEnv projects composition config as <FITTING_ID>_<KEY>. Reading
    // only GARRISON_* is the exact bug that made briefing_time ignore the
    // composition for months.
    const r = render({
      GARRISON_BRIEFING_DELIVERY: "",
      MORNING_BRIEFING_DELIVERY: "whatsapp",
      MORNING_BRIEFING_WHATSAPP_JID: JID,
      GARRISON_BRIEFING_WHATSAPP_JID: "",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(JID);
  });
});

describe("morning-briefing manifest matches the delivery options", () => {
  const meta = (
    yaml.load(fs.readFileSync(path.join(FITTING, "apm.yml"), "utf8")) as {
      ["x-garrison"]: {
        config_schema: { key: string; default?: unknown }[];
        consumes: { kind: string; name: string; cardinality: string }[];
      };
    }
  )["x-garrison"];

  it("declares delivery + whatsapp_jid, defaulting to the old behaviour", () => {
    const byKey = Object.fromEntries(meta.config_schema.map((c) => [c.key, c]));
    expect(byKey.delivery?.default).toBe("slack");
    expect(byKey.whatsapp_jid).toBeDefined();
  });

  it("requires no channel, so whatsapp and stdout compositions still resolve", () => {
    // slack was cardinality `one`, which made the Fitting unselectable for any
    // composition that does not station slack-channel.
    const slack = meta.consumes.find((c) => c.kind === "channel" && c.name === "slack");
    expect(slack?.cardinality).toBe("optional-one");
    const wa = meta.consumes.find(
      (c) => c.kind === "connector" && c.name === "whatsapp-web"
    );
    expect(wa?.cardinality).toBe("optional-one");
  });
});

describe("morning-briefing composition working directory", () => {
  // The operative runs in its OWN session dir (~/.garrison/personal), not the
  // composition dir. Every "apm_modules/_local/.../connector.mjs" in this prompt
  // is relative, so without an absolute cd the session gets
  // MODULE_NOT_FOUND for Trello, for Calendar, AND for the whatsapp send — the
  // briefing loses both its inputs and its delivery, and says so politely
  // instead of failing, which is how it stayed broken while looking healthy.
  const COMP = "/Users/x/dev/agent-garrison/compositions/default-2";

  it("puts the absolute composition dir in the prompt when it is known", () => {
    const r = render({ GARRISON_COMPOSITION_DIR: COMP });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`cd to ${COMP}`);
    expect(r.stdout).toContain("MODULE_NOT_FOUND");
  });

  it("covers the delivery call too, not just the data sources", () => {
    const r = render({
      GARRISON_COMPOSITION_DIR: COMP,
      GARRISON_BRIEFING_DELIVERY: "whatsapp",
      GARRISON_BRIEFING_WHATSAPP_JID: JID,
    });
    // The cd must come before the send_text instruction it governs.
    expect(r.stdout.indexOf(`cd to ${COMP}`)).toBeLessThan(r.stdout.indexOf("send_text"));
  });

  it("invents no path when the composition dir is unknown", () => {
    const r = render({ GARRISON_COMPOSITION_DIR: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Before anything else");
    expect(r.stdout).toContain("Compose my morning briefing");
  });
});
