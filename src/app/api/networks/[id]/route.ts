import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteNetwork } from "@/lib/db/queries";
import { updateNetwork } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateNetworkInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const label = auditLabel("network", id);
    const tracked = trackChanges("network", id);
    deleteNetwork(id);
    audit({ action: "delete", entity: "network", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Modifie un réseau. Seuls les champs présents changent : `{ "name": "…" }`, `{ "vrfId": 3 }` (`null` = globale),
 * `{ "siteId": null }`, `{ "vlan": 20, "status": "maintenance", "usedIps": 12 }`… Le CIDR ne change pas.
 */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as UpdateNetworkInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("network", id);
    const network = updateNetwork(id, body);
    audit({ action: "update", entity: "network", entityId: network.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ network });
  } catch (e) {
    return errorResponse(e);
  }
}
