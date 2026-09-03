// shellBinding(): the same strict-whitelist discipline as remoteShellBinding,
// for the sibling `context.shell` shape (owned Shells-fitting sessions).

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { shellBinding } from "../packages/talk/src/threads.mjs";

let sandbox: string;
let prevHome: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "talk-shell-binding-"));
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("shellBinding", () => {
  it("returns null when there is no context.shell, or it is malformed", () => {
    expect(shellBinding({})).toBeNull();
    expect(shellBinding({ context: {} })).toBeNull();
    expect(shellBinding({ context: { shell: [] } })).toBeNull();
    expect(shellBinding({ context: { shell: "not an object" } })).toBeNull();
  });

  it("requires both node and transport", () => {
    expect(shellBinding({ context: { shell: { transport: "local" } } })).toBeNull();
    expect(shellBinding({ context: { shell: { node: "dev-madrid" } } })).toBeNull();
  });

  it("whitelists exactly the known fields, dropping anything else", () => {
    const b = shellBinding({
      context: {
        shell: {
          node: "dev-madrid",
          transport: "local",
          tmuxSession: "s1",
          cwd: "/home/u/dev/x",
          runtime: "codex",
          label: "My shell",
          sessionId: "abc123",
          shellOrigin: "https://dev-madrid.tail31efa.ts.net:8498",
          evil: "$(rm -rf /)",
          __proto__: { polluted: true }
        }
      }
    });
    expect(b).toEqual({
      node: "dev-madrid",
      transport: "local",
      tmuxSession: "s1",
      cwd: "/home/u/dev/x",
      runtime: "codex",
      label: "My shell",
      sessionId: "abc123",
      shellOrigin: "https://dev-madrid.tail31efa.ts.net:8498"
    });
    expect((b as Record<string, unknown>).evil).toBeUndefined();
    expect((b as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops a shellOrigin that does not parse as an http(s) URL", () => {
    const b = shellBinding({ context: { shell: { node: "n", transport: "t", shellOrigin: "javascript:alert(1)" } } });
    expect(b!.shellOrigin).toBeUndefined();
    const b2 = shellBinding({ context: { shell: { node: "n", transport: "t", shellOrigin: "not a url" } } });
    expect(b2!.shellOrigin).toBeUndefined();
  });

  it("caps overlong strings", () => {
    const long = "x".repeat(500);
    const b = shellBinding({ context: { shell: { node: "n", transport: long, cwd: long } } });
    expect(b!.transport.length).toBe(40);
    expect(b!.cwd!.length).toBe(400);
  });
});

// toMeta()'s inclusion of `shell`/`claudeSessionId` (toMeta itself is
// module-private) is exercised end to end by
// tests/talk-mesh-sessions.test.ts's "binds a local shell row to its owning
// thread" case: meshSessions() reads listThreads() -> toMeta() and matches on
// t.shell.transport/tmuxSession, which only works if those fields survive.
