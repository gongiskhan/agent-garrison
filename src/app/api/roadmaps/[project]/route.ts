import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import {
  applyOp,
  emptyRoadmapDoc,
  mutateRoadmap,
  projectRoadmap,
  readRoadmapDoc,
  roadmapPathForProject,
  writeRoadmapDoc,
  ROADMAP_FILENAME,
  RoadmapMalformedError,
  RoadmapNotFoundError,
  RoadmapRequestError,
  type RoadmapOp
} from "@/lib/roadmaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ project: string }> | { project: string };
}

async function resolveProject(context: Context): Promise<string> {
  const params = await context.params;
  return params.project;
}

// A bad project name is the caller's fault (404), a broken roadmap.json is the
// file's (422 - the view tells the user to fix it by hand), anything else is
// ours (500). Collapsing these into one status would leave "I typo'd the
// project" and "your file is corrupt" indistinguishable in the UI.
function statusFor(error: unknown): number {
  if (error instanceof RoadmapNotFoundError) return 404;
  if (error instanceof RoadmapMalformedError) return 422;
  if (error instanceof RoadmapRequestError) return 400;
  return 500;
}

// GET - the roadmap, or `exists: false` so the view can offer to create one.
export async function GET(_request: Request, context: Context) {
  try {
    const project = await resolveProject(context);
    const file = roadmapPathForProject(project);
    const doc = await readRoadmapDoc(file);
    return NextResponse.json({
      project,
      path: file,
      exists: doc !== null,
      roadmap: doc ? projectRoadmap(doc) : null
    });
  } catch (error) {
    return jsonError(error, statusFor(error));
  }
}

// POST - create an empty roadmap.json. Never overwrites: an existing file is a
// 409, because the only way to reach this route with one already there is a
// stale tab.
export async function POST(request: Request, context: Context) {
  try {
    const project = await resolveProject(context);
    const file = roadmapPathForProject(project);
    const existing = await readRoadmapDoc(file);
    if (existing) {
      return jsonError(`${project} already has a ${ROADMAP_FILENAME}`, 409);
    }
    const payload = (await request.json().catch(() => ({}))) as { title?: unknown };
    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : `Roadmap ${project}`;
    const doc = emptyRoadmapDoc(title);
    await writeRoadmapDoc(file, doc);
    return NextResponse.json({ project, path: file, exists: true, roadmap: projectRoadmap(doc) });
  } catch (error) {
    return jsonError(error, statusFor(error));
  }
}

// PATCH - apply ONE operation and return the whole roadmap back.
//
// Operations rather than a whole-document PUT: agents edit this file from other
// sessions, and a PUT would silently revert whatever they wrote between the
// view's last read and the user's click.
export async function PATCH(request: Request, context: Context) {
  try {
    const project = await resolveProject(context);
    const file = roadmapPathForProject(project);
    const operation = (await request.json().catch(() => null)) as RoadmapOp | null;
    if (!operation || typeof operation.op !== "string") {
      return jsonError("body must be a roadmap operation ({op: ...})", 400);
    }
    const { doc } = await mutateRoadmap(file, (current) => applyOp(current, operation));
    return NextResponse.json({ project, path: file, exists: true, roadmap: projectRoadmap(doc) });
  } catch (error) {
    return jsonError(error, statusFor(error));
  }
}
