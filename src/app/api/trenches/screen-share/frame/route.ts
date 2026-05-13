import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getScreenshotPath } from "@/lib/screen/capture";
import { getRemoteFrame } from "@/lib/screen/remote-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const outpost = request.nextUrl.searchParams.get("outpost");

  if (outpost) {
    const buf = await getRemoteFrame(outpost);
    if (!buf) return NextResponse.json({ error: "no frame yet" }, { status: 404 });
    return new NextResponse(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  }

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
