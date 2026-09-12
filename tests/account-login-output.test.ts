import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain Node helper
import { SetupTokenOutput } from "../scripts/lib/account-login-output.mjs";

const TOKEN = `sk-ant-oat01-${"aB_9-".repeat(19)}Z`;
const INTRO = "✓ Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n";
const FOOTER = "\x1b[2EStore\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.\r\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>";
const screens: InstanceType<typeof SetupTokenOutput>[] = [];
function screen(cols = 200) {
  const output = new SetupTokenOutput({ cols });
  screens.push(output);
  return output;
}
afterEach(() => { for (const output of screens.splice(0)) output.dispose(); });

describe("setup-token terminal capture", () => {
  it("preserves cursor-rendered separators instead of appending Store to the token", async () => {
    const raw = INTRO + TOKEN + FOOTER;
    // This is the old helper's behavior, reproducing the reported failure.
    const stripped = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
    expect(stripped.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/)?.[0]).toBe(TOKEN + "Storethistokensecurely");
    const output = screen();
    await output.write(raw);
    expect(output.token()).toBe(TOKEN);
    expect(output.redactedText()).toContain("Store this token securely.");
    expect(output.redactedText()).not.toContain(TOKEN);
  });

  it.each([12, 33, TOKEN.length - 1])("waits when a PTY chunk ends at token character %i", async (split) => {
    const output = screen();
    await output.write(INTRO + TOKEN.slice(0, split));
    expect(output.token()).toBeNull();
    expect(output.redactedText()).not.toContain(TOKEN.slice(12, split) || "unprinted-secret");
    await output.write(TOKEN.slice(split));
    expect(output.token()).toBeNull();
    await output.write(FOOTER);
    expect(output.token()).toBe(TOKEN);
  });

  it("joins soft-wrapped token cells and redacts the complete credential", async () => {
    const output = screen(40);
    await output.write(INTRO + "\x1b[32m" + TOKEN + "\x1b[0m" + FOOTER);
    expect(output.token()).toBe(TOKEN);
    expect(output.redactedText()).not.toContain(TOKEN.slice(40));
  });

  it("accepts a final token without a footer only after successful CLI exit", async () => {
    const output = screen();
    await output.write(INTRO + TOKEN);
    expect(output.token()).toBeNull();
    expect(output.token({ exitedSuccessfully: true })).toBe(TOKEN);
  });

  it("handles escape sequences split across writes", async () => {
    const output = screen();
    await output.write(INTRO + TOKEN + "\x1b[");
    expect(output.token()).toBeNull();
    await output.write("2EStore\x1b[");
    await output.write("1Cthis token securely.");
    expect(output.token()).toBe(TOKEN);
  });

  it("runs the real PTY helper, captures once at completion and never publishes the token", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "garrison-login-pty-"));
    try {
      const executable = path.join(dir, "claude");
      writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(INTRO + TOKEN.slice(0, 45))});\nsetTimeout(() => { process.stdout.write(${JSON.stringify(TOKEN.slice(45) + FOOTER)}); }, 100);\n`, { mode: 0o700 });
      const child = spawn(process.execPath, [path.resolve("scripts/account-login-pty.mjs"), "--dir", dir], {
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
        stdio: "ignore"
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("helper timed out")); }, 10_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(code).toBe(0);
      expect(readFileSync(path.join(dir, "token.txt"), "utf8")).toBe(TOKEN);
      expect(statSync(path.join(dir, "token.txt")).mode & 0o777).toBe(0o600);
      const status = JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8"));
      expect(status.state).toBe("captured");
      expect(status.outputTail).toContain("Store this token securely.");
      expect(status.outputTail).not.toContain(TOKEN);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
