import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, trackChanges } from "@/lib/audit";
import { getAppSettings, updateAppSettings, type UpdateSettingsInput } from "@/lib/db/appsettings";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ settings: getAppSettings() });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Modification partielle (administrateur) : { orgName?, auditRetentionDays?, warnPct?, critPct? }.
 * Tout est validé avant la première écriture : un seuil invalide n'enregistre rien.
 */
export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as UpdateSettingsInput | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("settings", 0);
    const settings = updateAppSettings(body);
    audit({ action: "update", entity: "settings", changes: tracked.updated(), fields: body });
    return NextResponse.json({ settings });
  } catch (e) {
    return errorResponse(e);
  }
}
