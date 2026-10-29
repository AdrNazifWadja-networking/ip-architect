import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { startOidc } from "@/lib/auth/oidc";
import { SSO_BIND_COOKIE, requestOrigin } from "@/lib/auth/ssoCookie";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Publique : redirige vers le fournisseur d'identité. Une panne renvoie à la page de connexion avec un code d'erreur. */
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  try {
    const { url, bind } = await startOidc(getDb(), origin);
    const res = NextResponse.redirect(url);
    res.cookies.set(SSO_BIND_COOKIE, bind, { httpOnly: true, sameSite: "lax", path: "/api/auth/oidc", maxAge: 600, secure: origin.startsWith("https") });
    return res;
  } catch (e) {
    return NextResponse.redirect(`${origin}/login?sso=${e instanceof ApiError && e.code === "ssoDisabled" ? "ssoDisabled" : "ssoProvider"}`);
  }
}
