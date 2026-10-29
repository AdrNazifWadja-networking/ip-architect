import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { createNetwork, listNetworks } from "@/lib/db/queries";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateNetworkInput, type NetworkStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/** ?vrf=none -> réseaux sans VRF ; ?vrf=3 -> VRF n° 3 ; absent ou invalide -> pas de filtre. */
function parseVrfParam(raw: string | null): number | "none" | undefined {
  if (raw === "none") return "none";
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    const sp = req.nextUrl.searchParams;
    const version = sp.get("version");
    const networks = listNetworks({
      q: sp.get("q") ?? undefined,
      status: (sp.get("status") as NetworkStatus | null) ?? undefined,
      version: version === "4" ? 4 : version === "6" ? 6 : undefined,
      vrf: parseVrfParam(sp.get("vrf")),
      tag: sp.get("tag") ?? undefined,
    });
    return NextResponse.json({ networks });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateNetworkInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const network = createNetwork(body);
    audit({ action: "create", entity: "network", entityId: network.id });
    return NextResponse.json({ network }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
