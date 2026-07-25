import { NextResponse } from "next/server";
import { readMachineLogin, readMachineLogins } from "@/lib/machine-login";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RUNTIME-ACCOUNTS UX: identity + login status of the box's own native login per
// platform (what the "Machine login" runtime mode launches under). Display-only —
// the readers never touch token values, only non-secret presence/profile fields.
// `machineLogin` is the anthropic reader kept for the compact picker's simple case.
export async function GET() {
  try {
    const [machineLogin, machineLogins] = await Promise.all([readMachineLogin(), readMachineLogins()]);
    return NextResponse.json({ machineLogin, machineLogins });
  } catch (error) {
    return jsonError(error, 400);
  }
}
