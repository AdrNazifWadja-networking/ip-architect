import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { startReset } from "@/lib/db/passwordreset";
import { getLocale } from "@/lib/i18n/server";
import { clientIpFrom } from "@/lib/auth/proxy";
import { assertBodySize, MAX_PUBLIC_BODY_BYTES } from "@/lib/auth/bodylimit";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Mot de passe oublié (public) : { email }. Répond toujours la même chose (adresse connue ou non) et sans attendre l'envoi
 * du mail. N'écrit rien dans le journal d'audit : une demande en attente n'est pas une modification des données.
 */
export async function POST(req: NextRequest) {
  try {
    assertBodySize((n) => req.headers.get(n), MAX_PUBLIC_BODY_BYTES);
    assertSameOrigin();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const ip = clientIpFrom((n) => req.headers.get(n));
    const { expiresInMs } = startReset(body, { locale: getLocale(), ip }, getDb());
    return NextResponse.json({ expiresInMs });
  } catch (e) {
    return errorResponse(e);
  }
}
