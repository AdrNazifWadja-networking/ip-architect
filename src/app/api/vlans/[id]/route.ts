import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteVlan } from "@/lib/db/ipam";
import { updateVlan } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateVlanInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const label = auditLabel("vlan", id);
    const tracked = trackChanges("vlan", id);
    deleteVlan(id);
    audit({ action: "delete", entity: "vlan", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle : seuls les champs présents changent. */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as UpdateVlanInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("vlan", id);
    const vlan = updateVlan(id, body);
    audit({ action: "update", entity: "vlan", entityId: vlan.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ vlan });
  } catch (e) {
    return errorResponse(e);
  }
}
