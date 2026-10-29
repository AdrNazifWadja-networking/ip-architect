import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createVrf, listVrfs } from "@/lib/db/vrf";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateVrfInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ vrfs: listVrfs({ q: req.nextUrl.searchParams.get("q") ?? undefined }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateVrfInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const vrf = createVrf(body);
    audit({ action: "create", entity: "vrf", entityId: vrf.id });
    audit({ action: "create", entity: "vrf", entityId: vrf.id });
    return NextResponse.json({ vrf }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
