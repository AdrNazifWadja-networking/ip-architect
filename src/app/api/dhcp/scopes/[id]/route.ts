import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteScope, getScope } from "@/lib/db/dhcp";
import { updateScope } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateDhcpScopeInput } from "@/lib/types";

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
    return NextResponse.json({ scope: getScope(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const label = auditLabel("dhcpScope", id);
    const tracked = trackChanges("dhcpScope", id);
    deleteScope(id);
    audit({ action: "delete", entity: "dhcpScope", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle d'une plage (le réseau ne change pas). Les mêmes contrôles qu'à la création s'appliquent. */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdateDhcpScopeInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("dhcpScope", id);
    const scope = updateScope(id, body);
    audit({ action: "update", entity: "dhcpScope", entityId: scope.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ scope });
  } catch (e) {
    return errorResponse(e);
  }
}
