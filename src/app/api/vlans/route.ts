import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createVlan, listVlans } from "@/lib/db/ipam";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateVlanInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    const sp = req.nextUrl.searchParams;
    const site = sp.get("site");
    const vlans = listVlans({
      q: sp.get("q") ?? undefined,
      siteId: site ? Number(site) : undefined,
    });
    return NextResponse.json({ vlans });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateVlanInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const vlan = createVlan(body);
    audit({ action: "create", entity: "vlan", entityId: vlan.id });
    return NextResponse.json({ vlan }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
