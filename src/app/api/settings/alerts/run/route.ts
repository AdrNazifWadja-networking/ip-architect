import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getAlertConfig, runAlerts } from "@/lib/db/alerts";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Lance un passage tout de suite (administrateur) : envoie les nouveaux problèmes aux destinataires. */
export async function POST() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    if (!getAlertConfig().enabled) throw new ApiError("alertsDisabled", 409);
    const result = await runAlerts(undefined, {}, { force: true });
    audit({ action: "update", entity: "settings", detail: "alertes par e-mail : passage manuel" });
    return NextResponse.json({ result, config: getAlertConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}
