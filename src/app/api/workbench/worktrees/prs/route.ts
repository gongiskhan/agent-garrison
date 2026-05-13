import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandHome, parseTarget, outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

interface PrEntry {
  number: number;
  url: string;
  title: string;
  state: string;
  createdAt: string;
}

async function listPRsLocal(worktreePath: string, branch: string): Promise<PrEntry[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,title,state,createdAt"],
    { cwd: expandHome(worktreePath) }
  );
  return JSON.parse(stdout.trim() || "[]") as PrEntry[];
}

async function createPRLocal(worktreePath: string, branch: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "create", "--fill", "--head", branch],
    { cwd: expandHome(worktreePath) }
  );
  const url = stdout.trim().split("\n").pop() ?? "";
  return url;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const target = parseTarget(params.get("target"));
  const worktreePath = params.get("worktreePath");
  const branch = params.get("branch");

  if (!worktreePath || !branch) {
    return NextResponse.json({ error: "worktreePath and branch are required" }, { status: 400 });
  }

  try {
    if (target.kind === "local") {
      const prs = await listPRsLocal(worktreePath, branch);
      return NextResponse.json({ prs });
    }

    const result = (await outpostRpc<{ exit_code: number; stdout: string; stderr: string }>(
      target.name,
      "exec.run",
      {
        command: "sh",
        args: ["-c", `cd ${shellQuote(expandHome(worktreePath))} && gh pr list --head ${shellQuote(branch)} --state all --json number,url,title,state,createdAt`],
        timeout_ms: 15000,
      }
    ));
    if (result.exit_code !== 0) {
      const stderr = Buffer.from(result.stderr, "base64").toString();
      throw new Error(stderr || `gh exited ${result.exit_code}`);
    }
    const stdout = Buffer.from(result.stdout, "base64").toString();
    const prs = JSON.parse(stdout.trim() || "[]") as PrEntry[];
    return NextResponse.json({ prs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    target?: string;
    worktreePath?: string;
    branch?: string;
  };
  const target = parseTarget(body.target ?? null);
  const { worktreePath, branch } = body;

  if (!worktreePath || !branch) {
    return NextResponse.json({ error: "worktreePath and branch are required" }, { status: 400 });
  }

  try {
    if (target.kind === "local") {
      const url = await createPRLocal(worktreePath, branch);
      return NextResponse.json({ url });
    }

    const result = (await outpostRpc<{ exit_code: number; stdout: string; stderr: string }>(
      target.name,
      "exec.run",
      {
        command: "sh",
        args: ["-c", `cd ${shellQuote(expandHome(worktreePath))} && gh pr create --fill --head ${shellQuote(branch)}`],
        timeout_ms: 30000,
      }
    ));
    if (result.exit_code !== 0) {
      const stderr = Buffer.from(result.stderr, "base64").toString();
      throw new Error(stderr || `gh exited ${result.exit_code}`);
    }
    const stdout = Buffer.from(result.stdout, "base64").toString();
    const url = stdout.trim().split("\n").pop() ?? "";
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
