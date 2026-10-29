import { NextRequest, NextResponse } from "next/server";
import { accountExists, loginAny } from "@/lib/db/users";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { SESSION_COOKIE, SESSION_MAX_MS } from "@/lib/auth/roles";
import { clientIpFrom, secureCookie } from "@/lib/auth/proxy";
import { assertBodySize, MAX_PUBLIC_BODY_BYTES } from "@/lib/auth/bodylimit";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Corps : { username, password }. Réponse : { user } et cookie de session (HttpOnly, SameSite=Lax). */
export async function POST(req: NextRequest) {
  try {
    assertBodySize((n) => req.headers.get(n), MAX_PUBLIC_BODY_BYTES);
    const body = (await req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const ip = clientIpFrom((n) => req.headers.get(n));
    const attempted = typeof body.username === "string" ? body.username.trim().toLowerCase().slice(0, 80) : "";
    let session: Awaited<ReturnType<typeof loginAny>>;
    try {
      session = await loginAny(body.username, body.password, { ip });
    } catch (err) {
      // identifiant ou mot de passe faux, ou compte désactivé. Le nom saisi n'est journalisé QUE s'il désigne un compte
      // existant : sinon, quelqu'un qui tape son mot de passe dans la case « identifiant » l'écrirait en clair dans
      // le journal, lisible par les administrateurs.
      // Les tentatives déjà bloquées (429) ne sont PAS tracées : elles rempliraient le journal sans rien apprendre.
      if (err instanceof ApiError && err.code === "invalidCredentials") {
        audit({ action: "loginFailed", entity: "session", actor: null, username: attempted && accountExists(attempted) ? attempted : null });
      }
      throw err;
    }
    const { token, user } = session;
    audit({ action: "login", entity: "session", entityId: user.id, actor: { id: user.id, username: user.username } });
    const res = NextResponse.json({ user });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_MS / 1000,
      // « Secure » seulement derrière HTTPS : sur http://localhost, certains navigateurs refuseraient le cookie
      secure: secureCookie((n) => req.headers.get(n), req.nextUrl.protocol),
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
