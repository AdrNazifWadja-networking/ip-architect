import { NextResponse } from "next/server";
import { assertSameOrigin, guard, requireSessionUser } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createToken, listTokens } from "@/lib/db/tokens";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Les jetons du compte (`?all=1` : tous les comptes, administrateur). Le hash n'est jamais renvoyé, seulement le début
 * du jeton (« ipa_Ab12 »). Réservé à une session de navigateur : un jeton ne peut pas lister ni créer des jetons.
 */
export async function GET(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    const me = requireSessionUser();
    const all = new URL(req.url).searchParams.get("all") === "1";
    if (all && me.role !== "admin") throw new ApiError("forbidden", 403);
    return NextResponse.json({ tokens: listTokens(undefined, all ? {} : { userId: me.id }) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Crée un jeton `{ name, role?: "viewer"|"editor", expiresInDays? }` ; la réponse contient le jeton en clair, UNE seule fois. */
export async function POST(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    assertSameOrigin();
    const me = requireSessionUser();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const { token, row } = createToken(me, body);
    // jamais le jeton lui-même : son nom, ses droits et sa durée
    audit({ action: "create", entity: "token", entityId: row.id, detail: `${row.name} (${row.prefix}…, ${row.role}${row.expiresAt ? "" : ", no expiry"})` });
    return NextResponse.json({ token, row }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
