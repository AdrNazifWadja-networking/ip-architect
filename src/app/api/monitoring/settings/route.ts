import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getThresholds, setThresholds } from "@/lib/db/monitoring";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ thresholds: getThresholds() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Corps : { warnPct?, critPct? } (entiers, 1 ≤ warnPct < critPct ≤ 100). Un champ absent est inchangé. */
export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { warnPct?: unknown; critPct?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const thresholds = setThresholds(body);
    audit({ action: "update", entity: "settings", detail: `monitoring ${thresholds.warnPct}/${thresholds.critPct}` });
    return NextResponse.json({ thresholds });
  } catch (e) {
    return errorResponse(e);
  }
}
