import { describe, it, expect } from "vitest";
import { parse, stringify } from "yaml";
// @ts-expect-error Operational migration is an ESM CLI.
import { retireOmiManifest } from "../scripts/retire-omi.mjs";

describe("Omi retirement", () => {
  it("preserves all native settings and keeps wake and batch classification independent", () => {
    const native = { pendant_enabled: true, capture_policy: "wake_only", transcribe_enabled: true, wake_enabled: true, speak_enabled: true, classify_target: "wake-fast", triage_batch_cap: 7 };
    const input = stringify({ dependencies: { apm: [{ path: "../../fittings/seed/omi-channel" }, { path: "../../fittings/seed/capture-service" }] }, "x-garrison": { composition: { selections: { channels: [{ id: "omi-channel", config: { triage_enabled: true, triage_batch_cap: 20, classify_target: "batch-model", tips_enabled: false } }], connectors: [{ id: "capture-service", config: native }] } } } });
    const result = retireOmiManifest(input);
    const doc = parse(result.manifestYaml);
    const selections = doc["x-garrison"].composition.selections;
    expect(selections.channels).toEqual([]);
    expect(selections.connectors[0].config).toEqual({ ...native, triage_enabled: true, triage_classify_target: "batch-model", tips_enabled: false });
    expect(doc.dependencies.apm).toEqual([{ path: "../../fittings/seed/capture-service" }]);
    expect(retireOmiManifest(result.manifestYaml)).toEqual({ changed: false, manifestYaml: result.manifestYaml });
  });
  it("never adds Capture to a composition that did not have it", () => {
    const input = stringify({ "x-garrison": { composition: { selections: { channels: [{ id: "omi-channel" }], runtimes: [{ id: "remote-shell-runtime" }] } } } });
    const output = parse(retireOmiManifest(input).manifestYaml);
    expect(output["x-garrison"].composition.selections).toEqual({ channels: [], runtimes: [{ id: "remote-shell-runtime" }] });
  });
  it("rejects invalid YAML and preserves untouched manifests byte for byte", () => {
    expect(() => retireOmiManifest("a: [bad")).toThrow();
    expect(retireOmiManifest("# native hardware stays\nname: pendant\n")).toEqual({ changed: false, manifestYaml: "# native hardware stays\nname: pendant\n" });
  });
});
