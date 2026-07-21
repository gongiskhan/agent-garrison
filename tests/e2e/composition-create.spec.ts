import { test, expect } from "@playwright/test";

// These assertions intercept client API requests. A previously installed PWA
// worker can otherwise own them before Playwright routing sees them.
test.use({ serviceWorkers: "block" });

const NAME = `Composition Create ${process.pid}`;
const ID = `composition-create-${process.pid}`;

test("New composition clones the active composition before requesting a full switch", async ({ page }) => {
  const calls: string[] = [];
  await page.route(/\/api\/compositions$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    calls.push("create");
    const body = route.request().postDataJSON() as { name?: string; sourceId?: string };
    expect(body.name).toBe(NAME);
    expect(body.sourceId).toEqual(expect.any(String));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ composition: { id: ID } })
    });
  });
  await page.route("**/api/composition/switch", async (route) => {
    calls.push("switch");
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ target: ID });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, id: ID })
    });
  });

  await page.goto("/muster");
  await expect(page.getByTestId("new-composition")).toBeVisible();
  await page.getByTestId("new-composition").click();
  await expect(page.getByTestId("new-composition-dialog")).toBeVisible();
  await page.getByTestId("new-composition-name").fill(NAME);
  const remounted = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.getByTestId("new-composition-submit").click();
  await remounted;

  await expect(page.getByTestId("new-composition-dialog")).toHaveCount(0);
  expect(calls).toEqual(["create", "switch"]);
});

test("the global composition selector remounts only after a successful full switch", async ({ page }) => {
  let received: { method: string; body: unknown } | null = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/composition/switch", async (route) => {
    received = {
      method: route.request().method(),
      body: route.request().postDataJSON()
    };
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/muster?composition=default");
  const switcher = page.locator("#composition-switcher");
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  // The selector mounts after AppShell's composition and runner-state refresh.
  // Mobile also collapses only after hydration, so wait for that stable rail
  // before opening it rather than sampling the transient server-rendered nav.
  if ((page.viewportSize()?.width ?? Infinity) < 720) {
    await expect(expandSidebar).toBeVisible();
    await expandSidebar.click();
  } else {
    await expect(switcher.or(expandSidebar)).toBeVisible();
    if (await expandSidebar.isVisible()) {
      await expandSidebar.click();
    }
  }
  await expect(switcher).toBeVisible();
  const current = await switcher.inputValue();
  const choices = await switcher.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value)
  );
  const target = choices.find((value) => value && value !== current);
  expect(target).toBeTruthy();

  await switcher.selectOption(target!);
  await expect.poll(() => received).not.toBeNull();
  expect(received).toEqual({ method: "POST", body: { target } });
  await expect(page).toHaveURL(/composition=default/);

  const remounted = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  release();
  await remounted;
  await expect(page).toHaveURL(/\/muster$/);
});
