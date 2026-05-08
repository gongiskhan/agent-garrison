import type { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { getCompositionDirectory } from "@/lib/compositions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KillRequest {
  execution_id: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let body: KillRequest;
  try {
    body = (await request.json()) as KillRequest;
  } catch {
    return Response.json(
      { error: "invalid JSON body" },
      { status: 400 }
    );
  }

  const executionId = body.execution_id;
  if (!executionId) {
    return Response.json(
      { error: "execution_id is required" },
      { status: 400 }
    );
  }

  const compositionDir = getCompositionDirectory(params.id);
  const cli = path.join(
    compositionDir,
    "apm_modules",
    "_local",
    "coding-subagent",
    "scripts",
    "coding-subagent.mjs"
  );

  return new Promise<Response>((resolve) => {
    const child = spawn("node", [cli, "kill", "--execution-id", executionId], {
      cwd: compositionDir,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(
          Response.json(
            {
              error: stderr.trim() || `kill exited with code ${code}`,
              stdout: stdout.trim()
            },
            { status: 500 }
          )
        );
        return;
      }
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : { ok: true };
        resolve(Response.json(parsed));
      } catch {
        resolve(Response.json({ ok: true, raw: stdout.trim() }));
      }
    });

    child.on("error", (error) => {
      resolve(
        Response.json(
          { error: error.message },
          { status: 500 }
        )
      );
    });
  });
}
