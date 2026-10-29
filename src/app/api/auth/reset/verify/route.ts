import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { completeReset } from "@/lib/db/passwordreset";
import { getLocale } from "@/lib/i18n/server";
import { clientIpFrom } from "@/lib/auth/proxy";
import { assertBodySize, MAX_PUBLIC_BODY_BYTES } from "@/lib/auth/bodylimit";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fin de la réinitialisation (public) : { email, code, newPassword }. Change le mot de passe, ferme les sessions du compte ;
 * ne connecte pas (la personne se connecte ensuite avec son nouveau mot de passe).
 */
export async function POST(req: NextRequest) {
  try {
    assertBodySize((n) => req.headers.get(n), MAX_PUBLIC_BODY_BYTES);
    assertSameOrigin();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const ip = clientIpFrom((n) => req.headers.get(n));
    const r = await completeReset(body, { locale: getLocale(), ip }, getDb());
    // jamais le code ni le mot de passe : seulement le fait, et le compte concerné
    audit({ action: "passwordChange", entity: "user", entityId: r.userId, detail: `${r.username} (e-mail)`, actor: { id: r.userId, username: r.username } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
