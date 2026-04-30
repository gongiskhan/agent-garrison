import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYamlFile, writeYamlFile } from "@/lib/yaml";

describe("YAML helpers", () => {
  it("round-trips x-garrison without dropping unknown keys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-yaml-"));
    const file = path.join(dir, "apm.yml");
    await writeYamlFile(file, {
      name: "demo",
      version: "0.1.0",
      "x-garrison": {
        composition: {
          id: "demo"
        },
        future_key: {
          preserved: true
        }
      }
    });

    const parsed = await readYamlFile<Record<string, unknown>>(file);
    expect(parsed?.["x-garrison"]).toMatchObject({
      composition: { id: "demo" },
      future_key: { preserved: true }
    });
  });
});
