import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextResponse } from "next/server";
import { applyPlan } from "@/lib/db/planning";
import { errorResponse } from "@/lib/api";
import { ApiError, type ApplyPlanInput } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Crée les réseaux du plan (tout ou rien). Corps facultatif : { status } (défaut : inactive). */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const text = await req.text();
    let body: ApplyPlanInput = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text) as ApplyPlanInput;
      } catch {
        throw new ApiError("invalidBody", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    }
    const plan = applyPlan(id, body);
    audit({ action: "apply", entity: "plan", entityId: plan.id });
    return NextResponse.json({ plan });
  } catch (e) {
    return errorResponse(e);
  }
}
