import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, trackChanges } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getSsoConfig, updateSsoConfig } from "@/lib/db/ssosettings";
import type { UpdateSsoInput } from "@/lib/ssoTypes";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Réglages de la connexion unique et de l'annuaire (administrateur). Les secrets ne sont jamais renvoyés. */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    return NextResponse.json({ config: getSsoConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as UpdateSsoInput | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("ssoSettings", 0);
    const config = updateSsoConfig(body);
    audit({ action: "update", entity: "settings", changes: tracked.updated(), detail: "connexion unique", fields: { ...(body.oidc ? { oidc: 1 } : {}), ...(body.ldap ? { ldap: 1 } : {}) } });
    return NextResponse.json({ config });
  } catch (e) {
    return errorResponse(e);
  }
}
