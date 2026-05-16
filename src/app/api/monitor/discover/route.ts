import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface MonitorStatusFile {
  fittingId?: string;
  port?: number;
  url?: string;
  pid?: number;
  startedAt?: string;
}

const STATUS_FILE = path.join(os.homedir(), ".garrison", "ui-fittings", "monitor.json");

export async function GET() {
  let status: MonitorStatusFile;
  try {
    const raw = await readFile(STATUS_FILE, "utf8");
    status = JSON.parse(raw) as MonitorStatusFile;
  } catch {
    return NextResponse.json({ available: false, url: null, reason: "no-status-file" });
  }

  if (!status?.url) {
    return NextResponse.json({ available: false, url: null, reason: "no-url-in-status-file" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${status.url}/health`, {
      signal: controller.signal,
      cache: "no-store"
    });
    clearTimeout(timer);
    if (!response.ok) {
      return NextResponse.json({
        available: false,
        url: status.url,
        reason: `health-status-${response.status}`
      });
    }
    const body = (await response.json()) as { ok?: boolean };
    if (body?.ok === true) {
      return NextResponse.json({ available: true, url: status.url });
    }
    return NextResponse.json({ available: false, url: status.url, reason: "health-not-ok" });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : "fetch-failed";
    return NextResponse.json({ available: false, url: status.url ?? null, reason: message });
  }
}
