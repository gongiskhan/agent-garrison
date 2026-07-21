import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "slack-channel");
const SETUP = path.join(FITTING, "scripts", "setup.sh");
const ADAPTER = path.join(FITTING, "scripts", "slack-adapter.js");

function slackEnv(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SLACK_BOT_TOKEN;
  delete env.SLACK_SIGNING_SECRET;
  return { ...env, ...values };
}

describe("slack-channel optional connection setup", () => {
  it("does not block a composition when Slack credentials are absent", () => {
    const first = spawnSync("bash", [SETUP], {
      env: slackEnv(),
      encoding: "utf8"
    });
    const second = spawnSync("bash", [SETUP], {
      env: slackEnv(),
      encoding: "utf8"
    });

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("WARNING: slack-channel is not ready");
    expect(first.stdout).toContain("SLACK_BOT_TOKEN SLACK_SIGNING_SECRET");
    expect(first.stdout).toContain("Other channels remain available");
    expect(first.stdout).toContain("Slack inactive until credentials are configured");
    expect(first.stderr).toBe("");
    // Setup remains an idempotent probe: repeating it has the same outcome and
    // does not create connection state on the user's behalf.
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toBe(first.stderr);
  });

  it("reports ready when both Slack credentials are present", () => {
    const result = spawnSync("bash", [SETUP], {
      env: slackEnv({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_SIGNING_SECRET: "signing-test"
      }),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("WARNING");
    expect(result.stdout).toContain("credentials present");
    expect(result.stderr).toBe("");
  });

  it("keeps adapter startup fail-loud while Slack is unconfigured", () => {
    const result = spawnSync(process.execPath, [ADAPTER], {
      env: slackEnv(),
      encoding: "utf8",
      timeout: 2_000
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required"
    );
  });
});
