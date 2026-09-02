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
        GarrisonPendant: { status: resolve({ connectionState: "disconnected", paired: false, lostFrames: 0, ambientConsent: false, uploaderState: "idle" }), ...events() }
      }
    };
  });
  await page.goto("/capture");
  await expect(page.getByTestId("capture-native")).toBeVisible();
  await expect(page.getByTestId("capture-fallback")).toHaveCount(0);
  await expect(page.getByTestId("capture-phase")).toHaveText("idle");
  await expect(page.getByRole("button", { name: "Record microphone" })).toBeVisible();
  // Narrow viewports start with the menu drawer closed (the app bar opens it);
  // a collapsed desktop rail carries no rows either.
  const expand = page.getByRole("button", { name: /^(Open menu|Expand sidebar)$/ });
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
        GarrisonPendant: { status: resolve({ connectionState: "disconnected", paired: false, lostFrames: 0, ambientConsent: false, uploaderState: "idle" }), ...events() }
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

// G7: the pendant reaches the page through GarrisonPendant alone, in the
// plugin's own vocabulary (connectionState / paired / lostFrames / uploaderState
// / sessionId), and the words the pendant is hearing come back through the
// shell's /api/voice/sessions/<id>/events relay - never from the device or the
// provider port. The stub is a connected, streaming pendant; the relay is a
// fulfilled route with one interim, one final, and the done frame.
test("capture page: a connected pendant shows its state and streams the session's words", async ({ page }) => {
  await page.route("**/api/voice/sessions/pend_abcDEF123/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"text":"buy milk","final":false}\n\ndata: {"text":"buy milk tomorrow","final":true}\n\ndata: {"done":true}\n\n'
    })
  );
  await page.addInitScript(() => {
    const status = { phase: "idle", ackedFrames: 0, broadcasting: false, microphone: "undetermined", consentSuppressed: false };
    const pendant = {
      connectionState: "connected",
      paired: true,
      lostFrames: 2,
      ambientConsent: false,
      uploaderState: "streaming",
      battery: 87,
      sessionId: "pend_abcDEF123",
      hapticSupported: true
    };
    const calls: string[] = [];
    (window as unknown as { __pendantCalls: string[] }).__pendantCalls = calls;
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
        GarrisonPush: { status: resolve({ authorization: "notDetermined", registered: false, detail: "" }), pendingRoute: resolve({ path: null }), ...events() },
        GarrisonPendant: {
          status: resolve(pendant),
          disconnect: () => {
            calls.push("disconnect");
            return Promise.resolve({ ...pendant, connectionState: "disconnected", uploaderState: "ended", sessionId: undefined });
          },
          ...events()
        }
      }
    };
  });
  await page.goto("/capture");
  const section = page.getByTestId("capture-pendant");
  await expect(section.getByTestId("capture-pendant-state")).toHaveText("connected");
  await expect(section.getByText("remembered")).toBeVisible();
  await expect(section.getByText("87%")).toBeVisible();
  await expect(section.getByText("streaming")).toBeVisible();
  await expect(section.getByText("Lost frames")).toBeVisible();
  await expect(section.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(section.getByRole("button", { name: "Forget" })).toBeVisible();

  const transcript = section.getByTestId("capture-pendant-transcript");
  await expect(transcript.locator("li")).toHaveText(["buy milk tomorrow"]);
  await expect(transcript).toContainText("done");

  await section.getByRole("button", { name: "Disconnect" }).click();
  await expect(section.getByTestId("capture-pendant-state")).toHaveText("disconnected");
  await expect(section.getByRole("button", { name: "Connect" })).toBeVisible();
  await expect(transcript).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pendantCalls: string[] }).__pendantCalls)).toEqual(["disconnect"]);
});
