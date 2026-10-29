import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { exportVrfConfig } from "@/lib/db/vrf";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/vrfs/3/config -> configuration Cisco IOS-XE en texte brut. */
export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    return new NextResponse(exportVrfConfig(id), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return errorResponse(e);
  }
}
