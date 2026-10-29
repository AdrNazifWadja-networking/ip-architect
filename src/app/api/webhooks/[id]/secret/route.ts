import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { regenerateSecret } from "@/lib/db/webhooks";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Régénère le secret de signature : l'ancien cesse de fonctionner, le nouveau n'est montré qu'ici. */
export async function POST(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const secret = regenerateSecret(id);
    audit({ action: "update", entity: "webhook", entityId: id, detail: "secret" });
    return NextResponse.json({ secret });
  } catch (e) {
    return errorResponse(e);
  }
}
