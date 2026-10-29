import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { deleteClass, updateClass } from "@/lib/db/tpclasses";
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
    const tracked = trackChanges("tpClass", id);
    const r = updateClass(id, body);
    audit({ action: "update", entity: "tpClass", entityId: id, changes: tracked.updated(), fields: body });
    return NextResponse.json(r);
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
    const label = auditLabel("tpClass", id);
    const tracked = trackChanges("tpClass", id);
    deleteClass(id);
    audit({ action: "delete", entity: "tpClass", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
