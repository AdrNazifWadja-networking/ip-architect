import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createScope, listScopes } from "@/lib/db/dhcp";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateDhcpScopeInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ scopes: listScopes({ q: req.nextUrl.searchParams.get("q") ?? undefined }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateDhcpScopeInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const scope = createScope(body);
    audit({ action: "create", entity: "dhcpScope", entityId: scope.id });
    audit({ action: "create", entity: "dhcpScope", entityId: scope.id });
    return NextResponse.json({ scope }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
