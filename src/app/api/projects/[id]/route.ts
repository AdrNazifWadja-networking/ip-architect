import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteProject, getProject, updateProject } from "@/lib/db/projects";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateProjectInput } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    return NextResponse.json({ project: getProject(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdateProjectInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("project", id);
    const project = updateProject(id, body);
    audit({ action: "update", entity: "project", entityId: project.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ project });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Supprime le projet et tout son contenu. Refusé (409) pour le projet actif. */
export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const label = auditLabel("project", id);
    const tracked = trackChanges("project", id);
    deleteProject(id);
    audit({ action: "delete", entity: "project", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
