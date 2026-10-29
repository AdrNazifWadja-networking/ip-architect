import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { bulkDeleteNetworks, bulkUpdateNetworks, cleanIds, type BulkChanges } from "@/lib/db/bulk";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Modifie plusieurs réseaux d'un coup, tout ou rien : { ids: [1, 2], changes: { status, siteId, vlan, vrfId,
 * addTags, removeTags, customFields } }. Une entrée du journal d'audit par réseau modifié.
 */
export async function PATCH(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { ids?: unknown; changes?: BulkChanges } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const ids = cleanIds(body.ids);
    const tracked = ids.map((id) => [id, trackChanges("network", id)] as const);
    bulkUpdateNetworks(ids, body.changes as BulkChanges);
    for (const [id, t] of tracked) {
      audit({ action: "update", entity: "network", entityId: id, changes: t.updated(), fields: body.changes });
    }
    return NextResponse.json({ updated: ids.length });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Supprime plusieurs réseaux d'un coup (et leurs adresses), tout ou rien : { ids: [1, 2] }. */
export async function DELETE(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const ids = cleanIds(body.ids);
    const tracked = ids.map((id) => [id, auditLabel("network", id), trackChanges("network", id)] as const);
    bulkDeleteNetworks(ids);
    for (const [id, label, t] of tracked) {
      audit({ action: "delete", entity: "network", entityId: id, detail: label, changes: t.removed() });
    }
    return NextResponse.json({ deleted: ids.length });
  } catch (e) {
    return errorResponse(e);
  }
}
