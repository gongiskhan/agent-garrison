import { outpostRpc } from "@/lib/outpost-rpc";

interface RemoteCaptureState {
  running: boolean;
  lastError: string | null;
  lastCaptureAt: number | null;
}

export async function startRemoteCapture(outpost: string): Promise<{ success: boolean; error?: string }> {
  try {
    await outpostRpc(outpost, "screen.start", {});
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function stopRemoteCapture(outpost: string): Promise<void> {
  await outpostRpc(outpost, "screen.stop", {}).catch(() => null);
}

export async function getRemoteCaptureState(outpost: string): Promise<RemoteCaptureState> {
  try {
    const result = await outpostRpc<RemoteCaptureState>(outpost, "screen.status", {});
    return result ?? { running: false, lastError: null, lastCaptureAt: null };
  } catch {
    return { running: false, lastError: null, lastCaptureAt: null };
  }
}

export async function getRemoteFrame(outpost: string): Promise<Buffer | null> {
  try {
    const result = await outpostRpc<{ frame: string }>(outpost, "screen.frame", {});
    if (!result?.frame) return null;
    return Buffer.from(result.frame, "base64");
  } catch {
    return null;
  }
}
