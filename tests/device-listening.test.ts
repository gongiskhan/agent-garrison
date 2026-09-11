import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceListening, migrateListeningStore } from "../fittings/seed/capture-service/lib/device-listening.mjs";
import { CompanionNotifier } from "../fittings/seed/capture-service/lib/notify.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "listening-test-")); roots.push(root);
  let clock = Date.parse("2026-09-11T12:00:00Z");
  const pushes: any[] = [], events: any[] = [], lines: string[] = [];
  const state = new DeviceListening({ store: { root }, now: () => clock,
    notifier: { sendListeningPush: async (push: any) => pushes.push(push) },
    log: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) } });
  const device = "phone-device-0001";
  state.register(device, "phone"); state.register(device, "pendant");
  state.subscribe((event: any) => events.push(event));
  const message = (type: string, fields = {}, source = "phone") => state.message(device, { type: `listening.${type}`, device_id: device, source, ...fields });
  const start = () => { message("intent", { intent: "listening" }); message("transition", { actual: "listening", reason: "user_start" }); };
  return { root, device, state, pushes, events, lines, message, start, advance: (ms: number) => { clock += ms; }, row: (source = "phone") => state.get(device, source) };
}
describe("device listening watchdog", () => {
  it("stalls at 20 seconds, reminds at ten minutes, never a third", async () => {
    const f = fixture(); f.start(); f.advance(19999); await f.state.tick(); expect(f.pushes).toHaveLength(0);
    f.advance(1); await f.state.tick(); expect(f.row()).toMatchObject({ actual: "stalled", reason: "watchdog_stalled", stall_pushes_sent: 1 });
    expect(f.pushes[0]).toMatchObject({ title: "Zeca stopped listening", body: "The phone microphone stopped sending audio. Tap to resume.", path: "/capture?source=phone" });
    f.advance(599999); await f.state.tick(); expect(f.pushes).toHaveLength(1);
    f.advance(1); await f.state.tick(); expect(f.pushes).toHaveLength(2);
    f.advance(3600000); await f.state.tick(); expect(f.pushes).toHaveLength(2);
    expect(f.lines.some(s => s.includes("listening iPhone/phone listening -> stalled (watchdog_stalled)"))).toBe(true);
  });
  it.each(["heartbeat", "frame", "transition"])("recovers via %s and permits a new episode", async via => {
    const f = fixture(); f.start(); f.advance(20000); await f.state.tick(); const episode = f.row().stall_episode_id;
    if (via === "heartbeat") f.message("heartbeat");
    else if (via === "frame") f.state.activity(f.device, "phone");
    else f.message("transition", { actual: "listening", reason: "resume_retry" });
    expect(f.row()).toMatchObject({ actual: "listening", reason: "watchdog_recovered", stall_episode_id: null, stall_pushes_sent: 0 });
    f.advance(20000); await f.state.tick(); expect(f.row().stall_episode_id).not.toBe(episode); expect(f.pushes).toHaveLength(2);
  });
  it("heartbeats with no frames keep listening; user off never pushes or recovers", async () => {
    const f = fixture(); f.start();
    for (let i = 0; i < 150; i++) { f.advance(5000); f.message("heartbeat"); await f.state.tick(); }
    expect(f.row().actual).toBe("listening"); expect(f.pushes).toHaveLength(0);
    f.message("intent", { intent: "off" }); f.advance(1200000); f.message("heartbeat"); await f.state.tick();
    expect(f.row().actual).toBe("off"); expect(f.pushes).toHaveLength(0);
  });
  it("switches sources atomically and rejects foreign intent", () => {
    const f = fixture(); f.start();
    f.message("intent", { intent: "listening" }, "pendant");
    expect(f.row()).toMatchObject({ intent: "off", actual: "off", reason: "source_switch" });
    expect(f.row("pendant").intent).toBe("listening");
    expect(() => f.state.message("another-device", { type: "listening.intent", device_id: f.device, source: "phone", intent: "listening" })).toThrow("does not own");
    expect(f.row().intent).toBe("off");
  });
  it("uses identical watchdog logic and correct copy for pendant", async () => {
    const f = fixture(); f.message("intent", { intent: "listening" }, "pendant"); f.advance(20000); await f.state.tick();
    expect(f.pushes[0]).toMatchObject({ title: "Zeca lost the pendant", body: "No audio from the pendant for 20 seconds. Tap to reconnect.", path: "/capture?source=pendant" });
  });
  it("preserves intent and episode dedupe across restart", async () => {
    const f = fixture(); f.start(); f.advance(20000); await f.state.tick();
    const restarted = new DeviceListening({ store: { root: f.root }, now: () => Date.parse(f.row().actual_changed_at), notifier: { sendListeningPush: async () => { throw Error("duplicate"); } } });
    await restarted.tick(); expect(restarted.get(f.device, "phone")).toEqual(f.row());
  });
  it("migrates without dropping records and refuses corrupt or future state", () => {
    const f = fixture(); const file = path.join(f.root, "migration.json");
    writeFileSync(file, JSON.stringify({ version: 0, records: { preserved: { intent: "listening" } } }));
    expect(migrateListeningStore(file).records.preserved.intent).toBe("listening");
    writeFileSync(file, "{"); expect(() => migrateListeningStore(file)).toThrow();
    writeFileSync(file, JSON.stringify({ version: 99 })); expect(() => migrateListeningStore(file)).toThrow();
  });
  it("deduplicates real sender dry-run payloads per ordinal", async () => {
    const f = fixture(); const lines: string[] = [];
    const notifier = new CompanionNotifier({ store: { root: f.root }, cfg: { listeningPushDryRun: true }, counters: { bump() {} }, log: { log: (s: string) => lines.push(s) } });
    const payload = { title: "Zeca stopped listening", body: "The phone microphone stopped sending audio. Tap to resume.", path: "/capture?source=phone", idempotencyKey: "episode/1" };
    await notifier.sendListeningPush(payload); await notifier.sendListeningPush(payload);
    await notifier.sendListeningPush({ ...payload, idempotencyKey: "episode/2" });
    expect(lines).toHaveLength(2); expect(lines[0]).toContain(payload.body);
  });
});
