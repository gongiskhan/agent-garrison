#!/usr/bin/env node
import { runProvider } from "../provider-common.mjs";

await runProvider({
  id: "gemini-api",
  label: "Gemini API",
  keyEnv: "GEMINI_API_KEY",
  allowModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  invoke: async () => {
    throw new Error("gemini-api live invocation is intentionally not bundled; run with GARRISON_PROVIDER_MOCK=1 or provide a site-specific provider wrapper");
  }
});
