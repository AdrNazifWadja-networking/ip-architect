import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { setIgnored } from "@/lib/db/scans";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Ignore (ou ne plus ignorer) des adresses du réseau : { addresses: string[], ignored: boolean }. Un hôte ignoré ne déclenche plus d'alerte. */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as { addresses?: unknown; ignored?: unknown } | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const r = setIgnored(id, body.addresses, body.ignored);
    audit({ action: "update", entity: "scan", entityId: id, detail: body.ignored ? "hôtes ignorés" : "hôtes non ignorés" });
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
