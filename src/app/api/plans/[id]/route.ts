import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deletePlan, getPlan, updatePlan } from "@/lib/db/planning";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdatePlanInput } from "@/lib/types";

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
    return NextResponse.json({ plan: getPlan(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle. Un plan appliqué n'accepte que { name, description } (409 sinon). */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdatePlanInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("plan", id);
    const plan = updatePlan(id, body);
    audit({ action: "update", entity: "plan", entityId: plan.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ plan });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Supprime le plan ; les réseaux qu'il a créés sont conservés. */
export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const label = auditLabel("plan", id);
    const tracked = trackChanges("plan", id);
    deletePlan(id);
    audit({ action: "delete", entity: "plan", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
