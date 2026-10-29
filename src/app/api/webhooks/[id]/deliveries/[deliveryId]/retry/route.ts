import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { retryDelivery } from "@/lib/db/webhooks";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Remet un envoi (échoué ou non) en file : il repart au prochain passage (moins de 5 secondes). */
export async function POST(_req: Request, { params: rawParams }: { params: Promise<{ id: string; deliveryId: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    const deliveryId = Number(params.deliveryId);
    if (!Number.isInteger(id) || !Number.isInteger(deliveryId)) throw new ApiError("invalidId", 400);
    const delivery = retryDelivery(id, deliveryId);
    audit({ action: "update", entity: "webhook", entityId: id, detail: "retry" });
    return NextResponse.json({ delivery });
  } catch (e) {
    return errorResponse(e);
  }
}
