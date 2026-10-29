import { assertSameOrigin, currentUser, guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextResponse } from "next/server";
import { activateProject } from "@/lib/db/projects";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    assertSameOrigin(); // la garde ne le fait pas au niveau lecteur
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const project = activateProject(id, undefined, currentUser());
    audit({ action: "activate", entity: "project", entityId: project.id });
    return NextResponse.json({ project });
  } catch (e) {
    return errorResponse(e);
  }
}
