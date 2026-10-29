import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getLdapPassword, getSsoConfig } from "@/lib/db/ssosettings";
import { discover, clearOidcCache } from "@/lib/auth/oidc";
import { connectLdap, LdapError } from "@/lib/ldap/client";
import { renderFilter } from "@/lib/ldap/filter";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Essai de la configuration ENREGISTRÉE : { kind: "oidc" | "ldap", username? }. Ne crée aucun compte, n'ouvre aucune session. */
export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { kind?: unknown; username?: unknown } | null;
    if (!body || (body.kind !== "oidc" && body.kind !== "ldap")) throw new ApiError("invalidBody", 400);
    const cfg = getSsoConfig();
    if (body.kind === "oidc") {
      if (!cfg.oidc.issuer) throw new ApiError("ssoNotConfigured", 409);
      clearOidcCache();
      await discover(cfg.oidc.issuer);
      return NextResponse.json({ ok: true });
    }
    if (!cfg.ldap.url || !cfg.ldap.baseDn) throw new ApiError("ssoNotConfigured", 409);
    let count: number | null = null;
    try {
      const c = await connectLdap({ url: cfg.ldap.url, startTls: cfg.ldap.startTls });
      try {
        if (cfg.ldap.bindDn && !(await c.bind(cfg.ldap.bindDn, getLdapPassword(getDb())))) throw new ApiError("ldapUnavailable", 502);
        if (typeof body.username === "string" && body.username.trim()) {
          count = (await c.search(cfg.ldap.baseDn, renderFilter(cfg.ldap.userFilter, body.username.trim().slice(0, 80)), [cfg.ldap.usernameAttr], 5)).length;
        }
      } finally {
        await c.close();
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof LdapError) throw new ApiError("ldapUnavailable", 502);
      throw e;
    }
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return errorResponse(e);
  }
}
