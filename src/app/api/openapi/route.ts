import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { buildOpenApi } from "@/lib/docs/openapi";
import { getLocale } from "@/lib/i18n/server";
import { isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Contrat OpenAPI 3.0 (JSON), importable dans Swagger UI, Postman, Insomnia ou un générateur de client. `?lang=fr|en`. */
export async function GET(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  const url = new URL(req.url);
  const asked = url.searchParams.get("lang");
  const locale = isLocale(asked) ? asked : getLocale();
  return NextResponse.json(buildOpenApi(locale, url.origin));
}
