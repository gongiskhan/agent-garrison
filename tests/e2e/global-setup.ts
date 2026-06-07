import { seedSandbox } from "./sandbox";

// Reset + seed the config-plane sandbox before the e2e run.
export default async function globalSetup(): Promise<void> {
  seedSandbox();
}
