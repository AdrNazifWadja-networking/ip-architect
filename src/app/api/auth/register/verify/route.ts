import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { verifySignup } from "@/lib/db/signup";
import { SESSION_COOKIE, SESSION_MAX_MS } from "@/lib/auth/roles";
import { getLocale } from "@/lib/i18n/server";
import { clientIpFrom, secureCookie } from "@/lib/auth/proxy";
import { assertBodySize, MAX_PUBLIC_BODY_BYTES } from "@/lib/auth/bodylimit";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Vérification du code (public) : { email, code }. Dans les 2 minutes et avec le bon code : crée le compte (rôle « lecteur »)
 * et ouvre la session. Délai dépassé : 410, il faut recommencer l'inscription.
 */
export async function POST(req: NextRequest) {
  try {
    assertBodySize((n) => req.headers.get(n), MAX_PUBLIC_BODY_BYTES);
    assertSameOrigin();
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const ip = clientIpFrom((n) => req.headers.get(n));
    const { token, user, userId } = await verifySignup(body, { locale: getLocale(), ip }, getDb());
    const actor = { id: userId, username: user.username };
    audit({ action: "create", entity: "user", entityId: userId, detail: `${user.username} (${user.role}) · inscription par e-mail`, actor });
    audit({ action: "login", entity: "session", entityId: userId, actor });
    const res = NextResponse.json({ user }, { status: 201 });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_MS / 1000,
      secure: secureCookie((n) => req.headers.get(n), req.nextUrl.protocol),
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
