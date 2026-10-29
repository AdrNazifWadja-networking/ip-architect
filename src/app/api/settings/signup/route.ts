import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit, trackChanges } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getSignupConfig, updateSignupConfig } from "@/lib/db/signupsettings";
import type { UpdateSignupConfigInput } from "@/lib/signupTypes";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Réglages de l'inscription et de l'envoi d'e-mails (administrateur). Le mot de passe SMTP n'est jamais renvoyé. */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    return NextResponse.json({ config: getSignupConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as UpdateSignupConfigInput | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("signupSettings", 0);
    const config = updateSignupConfig(body);
    audit({ action: "update", entity: "settings", changes: tracked.updated(), detail: "inscription par e-mail", fields: body }); // noms des champs seulement
    return NextResponse.json({ config });
  } catch (e) {
    return errorResponse(e);
  }
}
