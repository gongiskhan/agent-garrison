import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");
const NAMES = ["gary", "joe", "james"];
const CHANNEL_DEFAULTS: Record<string, string> = { "dev-env": "joe", slack: "gary", web: "gary" };

describe("mode-resolver (s1d)", () => {
  it("parseLeadingMode matches a name at the start (punctuation / space / greeting / bare)", async () => {
    const { parseLeadingMode } = await import(join(LIB, "mode-resolver.mjs"));
    expect(parseLeadingMode("Joe, fix the build", NAMES)).toBe("joe");
    expect(parseLeadingMode("joe: do x", NAMES)).toBe("joe");
    expect(parseLeadingMode("Joe fix the build", NAMES)).toBe("joe");
    expect(parseLeadingMode("hey James, thoughts?", NAMES)).toBe("james");
    expect(parseLeadingMode("James", NAMES)).toBe("james");
  });

  it("parseLeadingMode does NOT match mid-sentence names or possessives", async () => {
    const { parseLeadingMode } = await import(join(LIB, "mode-resolver.mjs"));
    expect(parseLeadingMode("tell Joe about it", NAMES)).toBeNull();
    expect(parseLeadingMode("Gary's birthday is tomorrow", NAMES)).toBeNull();
    expect(parseLeadingMode("Garyfication of the codebase", NAMES)).toBeNull();
    expect(parseLeadingMode("what should I do?", NAMES)).toBeNull();
    expect(parseLeadingMode("", NAMES)).toBeNull();
  });

  it("explicit name switches — trigger=explicit_name (modes FINDING 4)", async () => {
    const { resolveMode } = await import(join(LIB, "mode-resolver.mjs"));
    const r = resolveMode({
      message: "Joe, fix the build",
      channel: "web",
      currentMode: "gary",
      channelDefaults: CHANNEL_DEFAULTS,
      defaultMode: "gary",
      names: NAMES
    });
    expect(r.mode).toBe("joe");
    expect(r.trigger).toBe("explicit_name");
    expect(r.switched).toBe(true);
    expect(r.priorMode).toBe("gary");
  });

  it("is sticky across two un-named messages (modes FINDING 5)", async () => {
    const { resolveMode } = await import(join(LIB, "mode-resolver.mjs"));
    const first = resolveMode({ message: "and then?", channel: "web", currentMode: "joe", channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES });
    expect(first.mode).toBe("joe");
    expect(first.trigger).toBe("sticky");
    expect(first.switched).toBe(false);
    const second = resolveMode({ message: "what about tests?", channel: "web", currentMode: first.mode, channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES });
    expect(second.mode).toBe("joe");
    expect(second.switched).toBe(false);
  });

  it("channel default at session start — dev-env→joe, slack→gary, unknown→default (modes FINDING 6)", async () => {
    const { resolveMode } = await import(join(LIB, "mode-resolver.mjs"));
    const dev = resolveMode({ message: "let's go", channel: "dev-env", currentMode: null, channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES });
    expect(dev.mode).toBe("joe");
    expect(dev.trigger).toBe("channel_default");
    expect(dev.switched).toBe(true);
    expect(dev.priorMode).toBeNull();
    expect(resolveMode({ message: "hi", channel: "slack", currentMode: null, channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES }).mode).toBe("gary");
    expect(resolveMode({ message: "hi", channel: "sms", currentMode: null, channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES }).mode).toBe("gary");
  });

  it("never resolves an invalid mode: a stale defaultMode / currentMode falls back to a real mode (s1d cross-model gate)", async () => {
    const { resolveMode } = await import(join(LIB, "mode-resolver.mjs"));
    // stale modes.json defaultMode + unknown channel → must NOT return the bogus
    // default (it would map to a non-existent soul and then stick); fall back to names[0].
    const r = resolveMode({ message: "hi", channel: "sms", currentMode: null, channelDefaults: CHANNEL_DEFAULTS, defaultMode: "ghost", names: NAMES });
    expect(NAMES).toContain(r.mode);
    expect(r.mode).toBe("gary"); // names[0]
    // a stale currentMode (no longer an installed mode) must not stick — re-resolve
    const stale = resolveMode({ message: "and then?", channel: "slack", currentMode: "retired-face", channelDefaults: CHANNEL_DEFAULTS, defaultMode: "gary", names: NAMES });
    expect(NAMES).toContain(stale.mode);
    expect(stale.trigger).toBe("channel_default");
    expect(stale.mode).toBe("gary");
  });

  it("buildSwitchEntry has all structured fields + appendSwitchLog appends JSONL (modes FINDING 9)", async () => {
    const { buildSwitchEntry, appendSwitchLog } = await import(join(LIB, "mode-resolver.mjs"));
    const entry = buildSwitchEntry({
      channel: "dev-env",
      priorMode: "gary",
      mode: "joe",
      trigger: "explicit_name",
      nowIso: "2026-06-22T12:00:00Z",
      signals: { origin: "channel" }
    });
    expect(entry).toMatchObject({
      timestamp: "2026-06-22T12:00:00Z",
      channel: "dev-env",
      prior_mode: "gary",
      chosen_mode: "joe",
      trigger: "explicit_name",
      corrected_from: null
    });
    expect(entry.signals.origin).toBe("channel");

    const dir = mkdtempSync(join(tmpdir(), "garrison-switchlog-"));
    const file = join(dir, ".garrison", "switch-log.jsonl");
    await appendSwitchLog(file, entry);
    await appendSwitchLog(file, { ...entry, chosen_mode: "james", trigger: "channel_default" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).chosen_mode).toBe("joe");
    expect(JSON.parse(lines[1]).chosen_mode).toBe("james");
  });
});
