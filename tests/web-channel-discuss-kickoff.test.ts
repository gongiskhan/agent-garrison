// The Discuss kickoff is a ONE-SHOT, and three separate pieces of code have to
// agree on that for it to stay one.
//
// 2026-08-06 they stopped agreeing and Discuss became unusable: the Operative
// answered the same opening prompt five times in ninety seconds, each re-send
// landing about a second after the previous reply finished. No single file was
// wrong on its own, which is why this pins the CHAIN rather than one string:
//
//   1. ClaudeChat auto-sends `initialMessage` behind `kickedRef`, which is a
//      per-MOUNT guard - a fresh mount gets a fresh ref, and it will send again.
//   2. The web channel gives ClaudeChat a `key` containing `historyRev`, so it
//      deliberately RE-MOUNTS whenever the transcript grows server-side.
//   3. historyRev advances as soon as the kickoff's own turn lands.
//
// So (1) + (2) + (3) means the host MUST retire the kickoff after handing it
// over. main.tsx self-mounts (top-level createRoot), so the retire is asserted
// on the source, the same way tests/kanban-panic-ui.test.ts pins Watch.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const MAIN = readFileSync(path.join(REPO, "fittings/seed/web-channel-default/ui/main.tsx"), "utf8");
const CHAT = readFileSync(path.join(REPO, "packages/claude-chat/src/ClaudeChat.tsx"), "utf8");

describe("Discuss kickoff is sent exactly once", () => {
  it("ClaudeChat's auto-send guard is per-mount, so a re-mount would send again", () => {
    expect(CHAT).toContain("const kickedRef = useRef(false);");
    expect(CHAT).toContain("if (kickedRef.current) return;");
    expect(CHAT).toContain("send(msg, { hideUser: initialMessageHidden });");
  });

  it("the web channel re-mounts ClaudeChat whenever the transcript grows", () => {
    expect(MAIN).toContain("key={`${activeId}:${historyRev}`}");
    expect(MAIN).toContain("setHistoryRev((r) => r + 1);");
  });

  it("so the host retires the kickoff once it has been handed over", () => {
    expect(MAIN).toContain("if (kickoff) setKickoffFor(null);");
    // Guarded on the kickoff itself, not on a turn-completion callback: the
    // re-mount can happen before any onTurnComplete fires.
    expect(MAIN).toMatch(/useEffect\(\(\) => \{\s*if \(kickoff\) setKickoffFor\(null\);\s*\}, \[kickoff\]\);/);
  });

  it("and only arms it for a thread with no transcript or durable input evidence", () => {
    expect(MAIN).toContain("setKickoffFor(opts?.kickoff && shouldArmDiscussKickoff(t) ? id : null);");
    expect(MAIN).toContain("if (!thread) return false;");
    expect(MAIN).toMatch(/const t = await apiGetThread\(id, controller\.signal\);[\s\S]*?if \(!t\) \{[\s\S]*?setKickoffFor\(null\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?setActiveId\(id\);/);
    expect(MAIN).toContain("(thread.pendingInputs?.length ?? 0) === 0");
    expect(MAIN).toContain("(thread.inputReceipts?.length ?? 0) === 0");
  });

  it("keeps the host-provided kickoff visible live and after hydration", () => {
    expect(MAIN).not.toContain("initialMessageHidden={Boolean(kickoff)}");
    expect(MAIN).not.toMatch(/h\[0\]\s*=\s*\{[^}]*hideUser:\s*true/);
  });
});
