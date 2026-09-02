import { test, expect } from "@playwright/test";

// The capture page is the iOS app's surface. In a browser there is no native
// bridge, so the page shows one line and the sidebar carries no Capture entry;
// with `window.Capacitor` present (stubbed here the way the app injects it) the
// native panel renders and the menu gains the entry. Both halves guard the same
// gate: a browser that showed the controls would promise a microphone it cannot
// reach, and an app that hid them would have no way to record.

test("capture page: browser sees the fallback and no menu entry", async ({ page }) => {
  await page.goto("/capture");
  await expect(page.getByRole("heading", { name: "Capture", level: 1 })).toBeVisible();
  await expect(page.getByTestId("capture-fallback")).toBeVisible();
  await expect(page.getByTestId("capture-native")).toHaveCount(0);
  await expect(page.locator('a[href="/capture"]')).toHaveCount(0);
});

test("capture page: with the native bridge the controls render and the menu lists Capture", async ({ page }) => {
  await page.addInitScript(() => {
    const status = {
      phase: "idle",
      ackedFrames: 0,
      broadcasting: false,
      microphone: "undetermined",
      consentSuppressed: false
    };
    const resolve = (value: unknown) => () => Promise.resolve(value);
    const events = () => ({ addListener: () => Promise.resolve({ remove: () => Promise.resolve() }) });
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        GarrisonNode: {
          current: resolve({ name: "sim", shellOrigin: location.origin, captureBaseURL: location.origin, hasToken: true }),
          list: resolve({ nodes: [] }),
          info: resolve({ appVersion: "1.0", build: "0", platform: "ios", bundleId: "test" }),
          ...events()
        },
        GarrisonCapture: { status: resolve(status), ...events() },
        GarrisonPush: {
          status: resolve({ authorization: "notDetermined", registered: false, detail: "" }),
          pendingRoute: resolve({}),
          ...events()
        },
        GarrisonPendant: { status: resolve({ state: "idle" }), ...events() }
      }
    };
  });
  await page.goto("/capture");
  await expect(page.getByTestId("capture-native")).toBeVisible();
  await expect(page.getByTestId("capture-fallback")).toHaveCount(0);
  await expect(page.getByTestId("capture-phase")).toHaveText("idle");
  await expect(page.getByRole("button", { name: "Record microphone" })).toBeVisible();
  // Narrow viewports start on the collapsed rail, which carries no rows.
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  if (await expand.count()) await expand.click();
  await expect(page.locator('a[href="/capture"]')).not.toHaveCount(0);
});

// G5: the record button lives in the conversation composer only inside the app.
// The stubbed GarrisonCapture records what `start` was called with, so the test
// proves the conversation id travels with the recording request.
test("conversation composer: the record button appears with the native bridge and passes the conversation id", async ({ page, request }) => {
  const id = `e2e-rec-${Date.now().toString(36)}`;
  const created = await request.post("/api/threads", { data: { id, title: "Record test", source: "e2e" } });
  expect(created.ok()).toBeTruthy();

  await page.goto(`/talk/${id}`);
  await expect(page.locator(".cc-composer")).toBeVisible();
  await expect(page.getByTestId("wc-rec-btn")).toHaveCount(0);

  await page.addInitScript(() => {
    const status = { phase: "idle", ackedFrames: 0, broadcasting: false, microphone: "undetermined", consentSuppressed: false };
    const calls: unknown[] = [];
    (window as unknown as { __captureCalls: unknown[] }).__captureCalls = calls;
    const resolve = (value: unknown) => () => Promise.resolve(value);
    const events = () => ({ addListener: () => Promise.resolve({ remove: () => Promise.resolve() }) });
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        GarrisonNode: {
          current: resolve({ name: "sim", shellOrigin: location.origin, captureBaseURL: location.origin, hasToken: true }),
          list: resolve({ nodes: [] }),
          info: resolve({ appVersion: "1.0", build: "0", platform: "ios", bundleId: "test" }),
          ...events()
        },
        GarrisonCapture: {
          status: resolve(status),
          start: (args: unknown) => {
            calls.push(args);
            return Promise.resolve({ ...status, broadcasting: true });
          },
          stop: () => Promise.resolve(status),
          ...events()
        },
        GarrisonPush: { status: resolve({ authorization: "notDetermined", registered: false, detail: "" }), pendingRoute: resolve({ path: null }), ...events() },
        GarrisonPendant: { status: resolve({ state: "idle", supported: false }), ...events() }
      }
    };
  });
  await page.goto(`/talk/${id}`);
  const button = page.getByTestId("wc-rec-btn");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-label", "Record screen");
  await button.click();
  await expect(button).toHaveAttribute("aria-label", "Stop recording");
  const calls = await page.evaluate(() => (window as unknown as { __captureCalls: unknown[] }).__captureCalls);
  expect(calls).toEqual([{ kind: "screen_audio", conversationId: id }]);
});
