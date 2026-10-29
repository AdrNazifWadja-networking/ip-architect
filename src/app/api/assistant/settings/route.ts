import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, trackChanges } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getAiConfig, updateAiConfig } from "@/lib/db/aisettings";
import type { UpdateAiConfigInput } from "@/lib/ai/types";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Configuration de l'assistant (administrateur). La clé d'API n'est jamais renvoyée : seulement `hasKey`. */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    return NextResponse.json({ config: getAiConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle : { enabled?, provider?, baseUrl?, model?, apiKey? } (apiKey "" = effacer). */
export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as UpdateAiConfigInput | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("assistantSettings", 0);
    const config = updateAiConfig(body);
    audit({ action: "update", entity: "settings", changes: tracked.updated(), detail: "assistant IA", fields: body }); // noms des champs seulement
    return NextResponse.json({ config });
  } catch (e) {
    return errorResponse(e);
  }
}
