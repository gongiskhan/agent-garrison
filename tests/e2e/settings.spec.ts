import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

const settingsFile = path.join(CLAUDE_SANDBOX, "settings.json");

function appErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e)
  );
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
}

// NOTE: the three viewport projects (desktop/tablet/mobile) run serially against
// ONE shared sandbox seeded once by global-setup, so a prior project may have
// already mutated settings.json. Assertions therefore reflect the CURRENT on-disk
// state and force real state changes rather than assuming the seed values.
test("S1 settings: autosave (no save button) persists changes + preserves bespoke keys", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // Headline: there is NO save button — changes persist automatically.
  await expect(page.getByTestId("settings-save")).toHaveCount(0);

  // documented key renders as a typed (number) control reflecting the on-disk value
  const cleanup = page.getByTestId("setting-cleanupPeriodDays");
  await expect(cleanup).toBeVisible();
  await expect(cleanup).toHaveValue(String(onDisk().cleanupPeriodDays));

  // bespoke keys (never edited here) surface in the Advanced passthrough —
  // and autoMode does NOT: the schema adopted it, so it renders as a typed
  // object-form (its seeded environment entry visible as a list row).
  await expect(page.getByTestId("unknown-advisorModel")).toBeVisible();
  await expect(page.getByTestId("unknown-autoDreamEnabled")).toBeVisible();
  await expect(page.getByTestId("unknown-autoMode")).toHaveCount(0);
  await expect(page.getByTestId("setting-autoMode.environment.0")).toHaveValue("solo dev");

  // edit a debounced (number) key and blur -> immediate autosave
  await cleanup.fill("30");
  await cleanup.blur();
  await expect(page.getByTestId("autosave-status")).toHaveText("saved");
  await expect.poll(() => onDisk().cleanupPeriodDays).toBe(30);

  // bespoke + sibling typed keys preserved by value through the merge-write
  expect(onDisk().advisorModel).toBe("opus");
  expect(onDisk().autoMode).toEqual({ environment: ["solo dev"] });

  // a discrete (boolean) control autosaves immediately, no blur. setChecked to the
  // opposite of the current state guarantees a real change event regardless of the
  // value a prior project left on disk.
  const thinking = page.getByTestId("setting-alwaysThinkingEnabled");
  const before = await thinking.isChecked();
  await thinking.setChecked(!before);
  await expect.poll(() => onDisk().alwaysThinkingEnabled).toBe(!before);

  // the number edit and bespoke keys are still intact after the second write
  expect(onDisk().cleanupPeriodDays).toBe(30);
  expect(onDisk().advisorModel).toBe("opus");

  expect(appErrors(errors)).toEqual([]);
});

test("S1b settings: full-catalog editors — search, permission rules, object-forms, enterprise, unset", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByTestId("settings-save")).toHaveCount(0);

  // ── Search filters rows + match count; non-matching groups disappear ──
  const search = page.getByTestId("settings-search");
  await search.fill("spinner");
  await expect(page.getByTestId("settings-match-count")).toHaveText(/match/);
  await expect(page.getByTestId("setting-spinnerTipsEnabled")).toBeVisible();
  await expect(page.getByTestId("setting-model")).toHaveCount(0);
  await expect(page.getByTestId("snav-auth")).toHaveCount(0);
  await search.fill("");
  await expect(page.getByTestId("setting-model")).toBeVisible();

  // ── Enterprise group: collapsed by default, honest banner, managed pill ──
  const enterprise = page.getByTestId("enterprise-group");
  await expect(enterprise).toHaveJSProperty("open", false);
  await enterprise.locator("summary").click();
  await expect(page.getByTestId("enterprise-banner")).toBeVisible();
  await expect(page.getByTestId("enterprise-banner")).toContainText("managed-settings.json");
  await expect(page.getByTestId("pill-managed-allowedMcpServers")).toBeVisible();

  // ── Hooks: the hooks key stays read-only here, CRUD links to Quarters ──
  await expect(page.getByTestId("hooks-crud-link")).toHaveAttribute("href", "/quarters/hooks");
  await expect(page.getByTestId("hooks-section")).toBeVisible();

  // ── Permission rules: the seeded rule renders structured (tool + specifier) ──
  const allowOnDisk = () => ((onDisk().permissions as Record<string, unknown>)?.allow ?? []) as string[];
  const seededIdx = allowOnDisk().indexOf("Bash(git add:*)");
  expect(seededIdx).toBeGreaterThanOrEqual(0);
  await expect(page.getByTestId(`setting-permissions.allow.${seededIdx}.tool`)).toHaveValue("Bash");
  await expect(page.getByTestId(`setting-permissions.allow.${seededIdx}.spec`)).toHaveValue("git add:*");

  // add a new rule via the tool select + specifier -> lands on disk
  const uniqueSpec = `./e2e-${testInfo.project.name}-${Date.now()}.md`;
  await page.getByTestId("setting-permissions.allow.add.tool").selectOption("Read");
  await page.getByTestId("setting-permissions.allow.add.spec").fill(uniqueSpec);
  await page.getByTestId("setting-permissions.allow.add").click();
  await expect.poll(() => allowOnDisk()).toContain(`Read(${uniqueSpec})`);
  // the seeded rule and bespoke keys survived the structured edit
  expect(allowOnDisk()).toContain("Bash(git add:*)");
  expect(onDisk().advisorModel).toBe("opus");

  // ── Object-form: flip a nested sandbox boolean (flip-relative) ──
  const sandboxEnabledBefore = ((onDisk().sandbox as Record<string, unknown>) ?? {}).enabled === true;
  await page.getByTestId("setting-sandbox.enabled").setChecked(!sandboxEnabledBefore);
  await expect
    .poll(() => ((onDisk().sandbox as Record<string, unknown>) ?? {}).enabled)
    .toBe(!sandboxEnabledBefore);

  // ── Unset round-trip: set a scalar, then remove the key entirely ──
  const language = page.getByTestId("setting-language");
  await language.scrollIntoViewIfNeeded();
  await language.fill("english");
  await language.blur();
  await expect.poll(() => onDisk().language).toBe("english");
  await page.getByTestId("setting-language.unset").click();
  await expect
    .poll(() => Object.prototype.hasOwnProperty.call(onDisk(), "language"))
    .toBe(false);

  expect(appErrors(errors)).toEqual([]);
});
