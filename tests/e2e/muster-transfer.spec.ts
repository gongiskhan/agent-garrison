import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// Muster > Import / Export — composition transfer through the real UI.
//
// The fixture composition deliberately carries BOTH authored files (a prompt, a
// routing policy, a doc) and things that must never leave the machine (a .env
// holding a credential, a local.yml holding another machine's home path). The
// export assertions are therefore about the real boundary, not a mock: the
// downloaded document must contain the authored content and none of the secret.
//
// COMPOSITIONS_DIR is cwd-relative and shared with the dev server, so the
// fixture is written into the repo's compositions/ and removed afterAll — along
// with whatever the import test creates.

const FIXTURE_ID = "transfer-e2e-fixture";
const IMPORT_ID = "transfer-e2e-imported";
const COMPOSITIONS = path.join(process.cwd(), "compositions");
const FIXTURE_DIR = path.join(COMPOSITIONS, FIXTURE_ID);

const SECRET_VALUE = "sk-transfer-e2e-must-not-travel";
const FOREIGN_HOME = "/home/someone-else/dev";

function writeFixture(): void {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_DIR, ".garrison", "prompts"), { recursive: true });
  const manifest = {
    name: FIXTURE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: FIXTURE_ID,
        name: "Transfer E2E Fixture",
        selections: {},
        duties: [
          {
            id: "develop",
            title: "Develop",
            description: "develop a change end to end",
            levels: [{ description: "standard", cell: { target: "cc-sonnet", effort: "medium" } }]
          }
        ],
        selected_duties: ["develop"],
        targets: [{ id: "cc-sonnet", runtime: "claude-code", model: "sonnet" }],
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md"
        }
      }
    }
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, "apm.yml"), yaml.dump(manifest), "utf8");

  // Authored — travels.
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".garrison", "prompts", "orchestrator.md"),
    "authored orchestrator prompt\n"
  );
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".garrison", "routing.json"),
    `${JSON.stringify({ policyVersion: 2, primaryRuntime: "codex-runtime" }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(FIXTURE_DIR, "profile.md"), "fixture composition profile\n");

  // Must never travel.
  fs.writeFileSync(path.join(FIXTURE_DIR, ".env"), `ANTHROPIC_API_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(FIXTURE_DIR, "local.yml"), `global_config:\n  projects_root: ${FOREIGN_HOME}\n`);
  fs.writeFileSync(path.join(FIXTURE_DIR, "apm.lock.yaml"), "resolved: true\n");
}

test.beforeEach(() => writeFixture());
test.afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(COMPOSITIONS, IMPORT_ID), { recursive: true, force: true });
});

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// Generous timeouts on the first paint only: run alone, this spec is the first
// to touch /muster, so the dev server compiles the route and the Muster + export
// APIs cold. Every later assertion uses the default.
async function openTransfer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`/muster?composition=${FIXTURE_ID}&section=transfer`);
  await expect(page.getByTestId("transfer-panel")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("export-stats")).toBeVisible({ timeout: 60000 });
}

test("(a) ?section=transfer deep-links the tab and the export summarises the bundle", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await openTransfer(page);
  await expect(page.getByTestId("section-nav-transfer")).toHaveAttribute("aria-selected", "true");

  // The authored files are listed as travelling...
  const included = page.getByTestId("export-files");
  await expect(included).toContainText(".garrison/prompts/orchestrator.md");
  await expect(included).toContainText(".garrison/routing.json");
  await expect(included).toContainText("profile.md");
  await expect(included).not.toContainText("local.yml");
  await expect(included).not.toContainText(".env");
  await expect(included).not.toContainText("apm.lock.yaml");

  // ...and the panel says out loud what does not, so the recipient knows what
  // they still have to supply. No secret VALUE appears anywhere in the bay.
  const exportBay = page.getByTestId("transfer-export");
  await expect(exportBay).toContainText("Never in a bundle");
  await expect(exportBay).toContainText("local.yml");
  await expect(exportBay).not.toContainText(SECRET_VALUE);

  // The download must be a RELATIVE url: the browser is almost never on the
  // Garrison box, so an absolute machine-local href is unreachable remotely.
  const href = await page.getByTestId("export-download").getAttribute("href");
  expect(href).toBe(`/api/compositions/${FIXTURE_ID}/export?download=1`);
  await expect(page.getByTestId("export-download")).toHaveAttribute(
    "download",
    `${FIXTURE_ID}.garrison.json`
  );

  expect(appErrors(errors)).toEqual([]);
});

test("(b) the downloaded bundle carries the authored files and no secret", async ({ page }) => {
  await openTransfer(page);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click()
  ]);
  expect(download.suggestedFilename()).toBe(`${FIXTURE_ID}.garrison.json`);
  const text = fs.readFileSync(await download.path(), "utf8");
  const bundle = JSON.parse(text);

  expect(bundle.kind).toBe("garrison.composition.bundle");
  expect(bundle.composition).toMatchObject({ id: FIXTURE_ID, name: "Transfer E2E Fixture" });
  const paths = (bundle.files as Array<{ path: string }>).map((f) => f.path).sort();
  expect(paths).toEqual([
    ".garrison/prompts/orchestrator.md",
    ".garrison/routing.json",
    "profile.md"
  ]);
  // The whole serialized document, not just the file list: whatever route a
  // secret might have taken, its value is not in here.
  expect(text).not.toContain(SECRET_VALUE);
  expect(text).not.toContain(FOREIGN_HOME);
  // The bundle carries its own manifest of what it deliberately left behind.
  expect((bundle.excluded as string[]).join(" ")).toContain("apm.lock.yaml");
  expect((bundle.excluded as string[]).join(" ")).toContain("local.yml");
});

test("(c) a bundle round-trips back in as a new composition", async ({ page }) => {
  await openTransfer(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click()
  ]);
  const text = fs.readFileSync(await download.path(), "utf8");

  await page.getByTestId("import-paste-toggle").click();
  await page.getByTestId("import-paste").fill(text);
  await page.getByTestId("import-paste-read").click();
  await expect(page.getByTestId("import-stats")).toBeVisible();

  // The fixture id is taken (it is the composition we exported), so the server
  // offers a free one — and the offered id must be immediately usable, not
  // reported as taken by the previous id's verdict.
  const idField = page.getByTestId("import-id");
  await expect(idField).toHaveValue(`${FIXTURE_ID}-2`);
  await expect(page.getByTestId("import-id-note")).not.toContainText("checking");
  await expect(page.getByTestId("import-id-note")).not.toContainText("is taken");
  await expect(page.getByTestId("import-submit")).toBeEnabled();

  // Typing a taken id blocks the import - and stays blocked while the debounced
  // availability check is still in flight, rather than briefly allowing a submit
  // that the server would only reject with a 409.
  await idField.fill(FIXTURE_ID);
  await expect(page.getByTestId("import-submit")).toBeDisabled();
  await expect(page.getByTestId("import-id-note")).toContainText("is taken");
  await expect(page.getByTestId("import-submit")).toBeDisabled();

  await idField.fill(IMPORT_ID);
  await page.getByTestId("import-name").fill("Transfer E2E Imported");
  await expect(page.getByTestId("import-id-note")).not.toContainText("checking");
  await expect(page.getByTestId("import-submit")).toBeEnabled();
  await page.getByTestId("import-submit").click();

  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("import-done")).toContainText("Transfer E2E Imported");

  // On disk: the authored files landed, the excluded ones did not.
  const importedDir = path.join(COMPOSITIONS, IMPORT_ID);
  expect(fs.readFileSync(path.join(importedDir, ".garrison", "prompts", "orchestrator.md"), "utf8")).toBe(
    "authored orchestrator prompt\n"
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(importedDir, ".garrison", "routing.json"), "utf8"))
  ).toMatchObject({ primaryRuntime: "codex-runtime" });
  expect(fs.existsSync(path.join(importedDir, ".env"))).toBe(false);
  expect(fs.existsSync(path.join(importedDir, "local.yml"))).toBe(false);
  expect(fs.existsSync(path.join(importedDir, "apm.lock.yaml"))).toBe(false);

  const raw = yaml.load(fs.readFileSync(path.join(importedDir, "apm.yml"), "utf8")) as {
    "x-garrison": { composition: { id: string; name: string; selected_duties: string[] } };
  };
  expect(raw["x-garrison"].composition).toMatchObject({
    id: IMPORT_ID,
    name: "Transfer E2E Imported"
  });
  expect(raw["x-garrison"].composition.selected_duties).toEqual(["develop"]);
});

test("(d) a document that is not a bundle is refused with a readable reason", async ({ page }) => {
  await openTransfer(page);
  await page.getByTestId("import-paste-toggle").click();
  await page.getByTestId("import-paste").fill('{"hello":"world"}');
  await page.getByTestId("import-paste-read").click();

  await expect(page.getByTestId("import-error")).toBeVisible();
  await expect(page.getByTestId("import-error")).toContainText("not a Garrison composition bundle");
  // Still on the drop step - a bad paste never advances to a preview.
  await expect(page.getByTestId("import-stats")).toHaveCount(0);
});

test("(e) no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTransfer(page);
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
