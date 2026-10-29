import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, trackChanges } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getAlertConfig, updateAlertConfig } from "@/lib/db/alerts";
import type { UpdateAlertConfigInput } from "@/lib/alertTypes";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Réglages des alertes par e-mail (administrateur). */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    return NextResponse.json({ config: getAlertConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as UpdateAlertConfigInput | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("alertSettings", 0);
    const config = updateAlertConfig(body);
    audit({ action: "update", entity: "settings", changes: tracked.updated(), detail: "alertes par e-mail", fields: body });
    return NextResponse.json({ config });
  } catch (e) {
    return errorResponse(e);
  }
}
