import path from "node:path";
import { describe, expect, it } from "vitest";
import { faculties, facultyRoleCopy } from "@/lib/faculties";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");

async function seedFaculty(id: string): Promise<string> {
  const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(
    path.join(SEED_DIR, id, "apm.yml")
  );
  return parseGarrisonMetadata(manifest!["x-garrison"]).faculty;
}

describe("faculty definitions", () => {
  it("renders the 9 role Faculties in order (modes added 2026-06-22)", () => {
    expect(faculties.map((faculty) => faculty.id)).toEqual([
      "orchestrator",
      "channels",
      "gateway",
      "runtimes",
      "memory",
      "observability",
      "sessions",
      "surfaces",
      "modes"
    ]);
  });

  it("assigns each faculty a unique sequential order 1..9", () => {
    expect(faculties.map((f) => f.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps Tasks out of the selectable Faculty set", () => {
    expect(faculties.map((faculty) => faculty.id)).not.toContain("tasks");
  });

  it("drops the config-projection faculties (now platform primitives in Quarters)", () => {
    const ids = faculties.map((f) => f.id);
    for (const gone of ["skills", "heartbeat", "scheduler", "classifier", "soul"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("memory is a multi role that accepts the cli shape (trello-data-source rejoined it)", () => {
    const memory = faculties.find((f) => f.id === "memory");
    expect(memory?.cardinality).toBe("multi");
    expect(memory?.shapes).toContain("cli");
  });

  it("runtimes is a multi role that accepts the script shape", () => {
    const runtimes = faculties.find((f) => f.id === "runtimes");
    expect(runtimes?.cardinality).toBe("multi");
    expect(runtimes?.shapes).toContain("script");
  });

  it("surfaces is a multi role that accepts the plugin shape", () => {
    const surfaces = faculties.find((f) => f.id === "surfaces");
    expect(surfaces?.cardinality).toBe("multi");
    expect(surfaces?.shapes).toContain("plugin");
  });
});

describe("essential tier (HV wave)", () => {
  it("tags exactly orchestrator/memory/channels/gateway as essential", () => {
    const essential = faculties.filter((f) => f.essential).map((f) => f.id).sort();
    expect(essential).toEqual(["channels", "gateway", "memory", "orchestrator"]);
  });

  it("leaves the alternative-engine / auxiliary roles optional", () => {
    for (const id of ["runtimes", "observability", "sessions", "surfaces"]) {
      expect(faculties.find((f) => f.id === id)?.essential ?? false, id).toBe(false);
    }
  });

  it("gives every faculty a non-empty description (notes) and role copy — one source of truth", () => {
    for (const f of faculties) {
      expect(f.notes.length, f.id).toBeGreaterThan(0);
      expect(facultyRoleCopy[f.id], f.id).toBeTruthy();
      expect(facultyRoleCopy[f.id].role.length, f.id).toBeGreaterThan(0);
      expect(facultyRoleCopy[f.id].fit.length, f.id).toBeGreaterThan(0);
    }
  });
});

describe("sessions split (2026-06-18)", () => {
  it("moves the runtime engines out of sessions into runtimes", async () => {
    for (const id of ["agent-sdk-runtime", "codex-runtime", "gemini-runtime"]) {
      expect(await seedFaculty(id), id).toBe("runtimes");
    }
  });

  it("moves the auxiliary own-port viewers out of sessions into surfaces", async () => {
    for (const id of ["screen-share-default", "browser-default", "outpost-tailscale-host"]) {
      expect(await seedFaculty(id), id).toBe("surfaces");
    }
  });

  it("keeps dev-env + artifact-store in sessions", async () => {
    expect(await seedFaculty("dev-env")).toBe("sessions");
    expect(await seedFaculty("artifact-store")).toBe("sessions");
  });

  it("folds the legacy screen-share/browser/outposts aliases into surfaces", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const legacy of ["screen-share", "browser", "outposts"]) {
        const md = parseGarrisonMetadata({
          faculty: legacy,
          cardinality_hint: "single",
          component_shape: "plugin",
          platforms: ["claude-code"],
          own_port: true,
          verify: { command: "echo ok", expect: "ok" }
        });
        expect(md.faculty, legacy).toBe("surfaces");
      }
    } finally {
      console.warn = warn;
    }
  });
});
