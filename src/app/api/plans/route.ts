import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextResponse } from "next/server";
import { createPlan, listPlans } from "@/lib/db/planning";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreatePlanInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ plans: listPlans() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Corps : { name, parentCidr, vrfId?, description?, items?: [{ name, hosts? | prefix?, siteId?, vlan? }] } */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreatePlanInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const plan = createPlan(body);
    audit({ action: "create", entity: "plan", entityId: plan.id });
    audit({ action: "create", entity: "plan", entityId: plan.id });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
