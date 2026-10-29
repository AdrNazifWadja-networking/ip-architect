import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { deleteTag, updateTag } from "@/lib/db/meta";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

function idOf(params: { id: string }): number {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = idOf(params);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("tag", id);
    const tag = updateTag(id, body);
    audit({ action: "update", entity: "tag", entityId: id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ tag });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = idOf(params);
    const label = auditLabel("tag", id);
    const tracked = trackChanges("tag", id);
    deleteTag(id);
    audit({ action: "delete", entity: "tag", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
