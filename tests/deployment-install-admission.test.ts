import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

it.each(["redeploy", "reload"])("a held deployment lease prevents %s from touching dependencies or build artifacts", (verb) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "deploy-admission-"));
  const bin = path.join(home, "bin"); mkdirSync(bin);
  const log = path.join(home, "calls"); writeFileSync(log, "");
  const shim = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim("git", "printf '%s\\n' 0123456789012345678901234567890123456789");
  shim("bash", `if [ "$3" = env ]; then printf 'GARRISON_APP_PORT=28777\\nGARRISON_HOME=%s\\n' "$ADMISSION_HOME"; else echo build >> "$ADMISSION_LOG"; exit 90; fi`);
  shim("npm", `echo install >> "$ADMISSION_LOG"; exit 90`);
  shim("node", `case "$2" in check) exit 0 ;; acquire) echo held-lease >> "$ADMISSION_LOG"; exit 75 ;; *) echo unexpected-node >> "$ADMISSION_LOG"; exit 90 ;; esac`);
  try {
    const result = spawnSync("/bin/bash", [path.resolve(`scripts/garrison-${verb}.sh`), "default"], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GARRISON_CONVERSATION_ID: "", ADMISSION_HOME: home, ADMISSION_LOG: log } });
    expect(result.status, result.stderr).toBe(75);
    expect(readFileSync(log, "utf8")).toBe("held-lease\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
