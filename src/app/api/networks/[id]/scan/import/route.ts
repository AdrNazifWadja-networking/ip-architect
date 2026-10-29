import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { importScanHosts } from "@/lib/db/scans";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Importe dans l'IPAM des hôtes découverts : { addresses: string[] } (256 au plus), tout ou rien. */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as { addresses?: unknown } | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const r = importScanHosts(id, body.addresses);
    for (const addressId of r.created) audit({ action: "create", entity: "address", entityId: addressId, detail: "scan" });
    return NextResponse.json({ imported: r.imported, skipped: r.skipped });
  } catch (e) {
    return errorResponse(e);
  }
}
