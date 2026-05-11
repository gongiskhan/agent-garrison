import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getScreenshotPath } from "@/lib/screen/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const path = getScreenshotPath();
  if (!existsSync(path)) {
    return NextResponse.json({ error: "no frame yet" }, { status: 404 });
  }
  try {
    const buf = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "Last-Modified": new Date(mtime).toUTCString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
