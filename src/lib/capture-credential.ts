import { randomBytes } from "node:crypto";
import { stateEnrolled } from "./state-client";
import { scopedSecrets, writeConnectorSecrets, withCredentialLock } from "./connector-auth";

export const CAPTURE_CREDENTIAL = "CAPTURE_TOKEN";
let localProvision: Promise<string> | undefined;

// Generate once, preserve existing devices, and never rotate merely because a
// node restarts. Authorization failures propagate; they are not missing keys.
export async function ensureCaptureCredential(): Promise<string> {
  const existing = (await scopedSecrets([CAPTURE_CREDENTIAL]))[0]?.value;
  if (existing) return existing;
  if (stateEnrolled()) return withCredentialLock(CAPTURE_CREDENTIAL, async (client) => {
    const value = (await client.resolveSecrets([CAPTURE_CREDENTIAL])).values[CAPTURE_CREDENTIAL];
    if (value) return value;
    const token = randomBytes(32).toString("base64url");
    await client.putSecret(CAPTURE_CREDENTIAL, token);
    return token;
  });
  if (!localProvision) localProvision = (async () => {
    const value = (await scopedSecrets([CAPTURE_CREDENTIAL]))[0]?.value;
    if (value) return value;
    const token = randomBytes(32).toString("base64url");
    await writeConnectorSecrets({ [CAPTURE_CREDENTIAL]: token });
    return token;
  })().finally(() => { localProvision = undefined; });
  return localProvision;
}
