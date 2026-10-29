import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createSite, listSitesDetailed } from "@/lib/db/sites";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateSiteInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ sites: listSitesDetailed({ q: req.nextUrl.searchParams.get("q") ?? undefined }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateSiteInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const site = createSite(body);
    audit({ action: "create", entity: "site", entityId: site.id });
    audit({ action: "create", entity: "site", entityId: site.id });
    return NextResponse.json({ site }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
