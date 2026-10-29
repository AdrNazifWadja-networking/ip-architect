import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { loginOidc } from "@/lib/db/sso";
import { audit } from "@/lib/audit";
import { SESSION_COOKIE, SESSION_MAX_MS } from "@/lib/auth/roles";
import { SSO_BIND_COOKIE, requestOrigin } from "@/lib/auth/ssoCookie";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Publique : retour du fournisseur (?code&state). Le serveur contrôle state, cookie de liaison, PKCE, signature et nonce. */
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  const fail = (code: string) => {
    const res = NextResponse.redirect(`${origin}/login?sso=${code}`);
    res.cookies.set(SSO_BIND_COOKIE, "", { path: "/api/auth/oidc", maxAge: 0 });
    return res;
  };
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return fail("ssoDenied");
  try {
    const { token, user, created } = await loginOidc(getDb(), { code: q.get("code"), state: q.get("state"), bind: req.cookies.get(SSO_BIND_COOKIE)?.value, requestOrigin: origin });
    audit({ action: "login", entity: "session", entityId: user.id, actor: { id: user.id, username: user.username }, detail: created ? "SSO (compte créé)" : "SSO" });
    const res = NextResponse.redirect(`${origin}/`);
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_MS / 1000, secure: origin.startsWith("https") });
    res.cookies.set(SSO_BIND_COOKIE, "", { path: "/api/auth/oidc", maxAge: 0 });
    return res;
  } catch (e) {
    if (e instanceof ApiError) {
      audit({ action: "loginFailed", entity: "session", actor: null, username: null, detail: `SSO : ${e.code}` });
      return fail(e.code.startsWith("sso") ? e.code : "ssoProvider");
    }
    console.error(e);
    return fail("ssoProvider");
  }
}
