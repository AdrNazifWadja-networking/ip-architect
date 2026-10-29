import type { NextRequest } from "next/server";
import { trustProxy } from "./proxy";

export const SSO_BIND_COOKIE = "ipa_sso_bind";

/** Origine publique de la requête (derrière un proxy : en-têtes X-Forwarded-*). */
export function requestOrigin(req: NextRequest): string {
  // X-Forwarded-* : seulement derrière un proxy de confiance (sinon le client choisirait l'adresse de retour)
  const trusted = trustProxy();
  const proto = (trusted ? req.headers.get("x-forwarded-proto")?.split(",")[0].trim() : null) || req.nextUrl.protocol.replace(":", "");
  const host = (trusted ? req.headers.get("x-forwarded-host")?.split(",")[0].trim() : null) || req.headers.get("host") || req.nextUrl.host;
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
