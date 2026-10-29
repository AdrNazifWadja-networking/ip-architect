import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteVrf, getVrf } from "@/lib/db/vrf";
import { updateVrf } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateVrfInput } from "@/lib/types";

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
    return NextResponse.json({ vrf: getVrf(parseId(params.id)) });
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
    const label = auditLabel("vrf", id);
    const tracked = trackChanges("vrf", id);
    deleteVrf(id);
    audit({ action: "delete", entity: "vrf", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle : nom, RD, route targets, description. `"rd": null` passe la VRF en VRF-Lite. */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdateVrfInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("vrf", id);
    const vrf = updateVrf(id, body);
    audit({ action: "update", entity: "vrf", entityId: vrf.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ vrf });
  } catch (e) {
    return errorResponse(e);
  }
}
