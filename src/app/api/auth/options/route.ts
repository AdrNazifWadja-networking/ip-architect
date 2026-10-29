import { NextResponse } from "next/server";
import { getLoginOptions } from "@/lib/db/ssosettings";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Publique : quels modes de connexion proposer ({ oidc: { label } | null, ldap }). Aucune donnée sensible. */
export async function GET() {
  try {
    return NextResponse.json(getLoginOptions());
  } catch (e) {
    return errorResponse(e);
  }
}
