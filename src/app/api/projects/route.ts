import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/db/projects";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateProjectInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ projects: listProjects() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateProjectInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const project = createProject(body);
    audit({ action: "create", entity: "project", entityId: project.id });
    return NextResponse.json({ project }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
