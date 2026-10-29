import { NextResponse } from "next/server";
import { assertSameOrigin, currentUser, guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { markRead } from "@/lib/db/notifications";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Marque des notifications comme lues pour le compte courant : { ids: string[] } ou { all: true }.
 * Réservé au compte lui-même (lecteur et plus) : ce n'est pas une modification des données d'adressage, donc non journalisé.
 */
export async function POST(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    assertSameOrigin();
    const body = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    return NextResponse.json(markRead(currentUser()?.id, body.all === true ? "all" : body.ids));
  } catch (e) {
    return errorResponse(e);
  }
}
