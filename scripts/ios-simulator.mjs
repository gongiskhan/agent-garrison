#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Hosted runners do not always contain a pre-created iPhone simulator.
const list = kind => JSON.parse(execFileSync("xcrun", ["simctl", "list", kind, "-j"], { encoding: "utf8" }));
const preferred = process.env.GARRISON_SIMULATOR_VERSION;
const runtime = () => list("runtimes").runtimes.filter(r => r.isAvailable && r.identifier.includes(".iOS-") && (!preferred || r.version === preferred)).at(-1);
let selected = runtime();
if (!selected) {
  console.error("Installing the iOS simulator runtime for the selected Xcode");
  execFileSync("xcodebuild", ["-downloadPlatform", "iOS", ...(preferred ? ["-buildVersion", preferred] : [])], { stdio: ["ignore", "inherit", "inherit"] });
  selected = runtime();
}
if (!selected) throw new Error("No available iOS simulator runtime");
const devices = (list("devices").devices[selected.identifier] ?? []).filter(d => d.isAvailable && d.name.includes("iPhone"));
let device = devices.find(d => d.name === "iPhone 17 Pro") ?? devices[0];
if (!device) {
  const type = list("devicetypes").devicetypes.find(d => d.name === "iPhone 17 Pro");
  if (!type) throw new Error("The selected Xcode has no iPhone 17 Pro device type");
  const id = execFileSync("xcrun", ["simctl", "create", "iPhone 17 Pro", type.identifier, selected.identifier], { encoding: "utf8" }).trim();
  device = { udid: id };
}
console.error(`Using iOS simulator ${device.udid} (${selected.version})`);
console.log(device.udid);
