import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { listDeliveries } from "@/lib/db/webhooks";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Derniers envois d'un webhook (statut, tentatives, code HTTP) ; ?limit= (50 par défaut, 200 au plus). */
export async function GET(req: NextRequest, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
    return NextResponse.json({ deliveries: listDeliveries(id, limit) });
  } catch (e) {
    return errorResponse(e);
  }
}
