import base from "./playwright.config";

// The web-channel spec is fully self-contained: tests/e2e/web-channel-chat.spec.ts
// boots its OWN fake gateway + web-channel server on 127.0.0.1 in beforeAll, so it
// does NOT need the Next dev server that the base config starts as a global
// `webServer`. This variant drops that webServer (and the unrelated globalSetup),
// so the web-channel UI can be verified standalone — no Next app, no 0.0.0.0 bind.
// Used by the cross-model (Codex) functional pass, which runs in a network-isolated
// sandbox where binding 0.0.0.0 / reaching an external server is not permitted.
export default {
  ...base,
  globalSetup: undefined,
  webServer: undefined,
  testMatch: /web-channel-chat\.spec\.ts$/,
};
