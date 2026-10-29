import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getDelivery, queueTest } from "@/lib/db/webhooks";
import { deliverDue } from "@/lib/webhooks/dispatcher";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Envoie tout de suite un événement « webhook.test » (une seule tentative) et renvoie le résultat. */
export async function POST(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const db = getDb();
    const deliveryId = queueTest(id, db);
    await deliverDue(db, {}, deliveryId);
    // un test n'est pas réessayé : s'il échoue, on le marque abandonné pour ne pas le renvoyer plus tard
    db.prepare("UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL WHERE id = ? AND status = 'pending'").run(deliveryId);
    audit({ action: "update", entity: "webhook", entityId: id, detail: "test" });
    return NextResponse.json({ delivery: getDelivery(deliveryId, db) });
  } catch (e) {
    return errorResponse(e);
  }
}
