import base from "./playwright.config";

// The web-channel specs (tests/e2e/web-channel-chat.spec.ts and
// web-channel-session-parity.spec.ts) drive the Conversations engine where it is
// hosted: the Garrison shell at /talk. Each spec boots its OWN Next dev server
// through tests/e2e/fixtures/talk-app.ts - scratch GARRISON_HOME, free loopback
// port, GARRISON_GATEWAY_URL pointed at the spec's fake gateway - because the
// parity spec must kill and respawn that server mid-test, which a config-level
// `webServer` cannot do. So this variant drops the base config's webServer (and
// the unrelated globalSetup) and only matches the two specs.
//
// The spec-owned servers build into .next-e2e, the dist dir the base config's
// webServer also uses (a second `next dev` on the live server's .next/ corrupts
// its route manifests, and Next appends any OTHER distDir to tsconfig.json's
// `include`). Never run this config and the base config at the same time.
export default {
  ...base,
  globalSetup: undefined,
  webServer: undefined,
  testMatch: /web-channel-(chat|session-parity)\.spec\.ts$/,
};
