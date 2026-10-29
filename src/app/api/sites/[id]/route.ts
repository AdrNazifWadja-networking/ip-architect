import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteSite, getSite, updateSite } from "@/lib/db/sites";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateSiteInput } from "@/lib/types";

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
    return NextResponse.json({ site: getSite(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle : seuls les champs présents changent (null efface l'adresse ou la description). */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdateSiteInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("site", id);
    const site = updateSite(id, body);
    audit({ action: "update", entity: "site", entityId: site.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ site });
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
    const label = auditLabel("site", id);
    const tracked = trackChanges("site", id);
    deleteSite(id);
    audit({ action: "delete", entity: "site", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
