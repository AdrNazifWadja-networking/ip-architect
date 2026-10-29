import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { isSimMode, simulate } from "@/lib/db/simulator";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Simulation en lecture seule (rien n'est écrit). Modes et corps :
 *  - split : { cidr | networkId, newPrefix }
 *  - merge : { cidrs?: string[], networkIds?: number[] }
 *  - free  : { parent, vrfId?, prefix? }
 *  - fit   : { cidr, vrfId? }
 */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ mode: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    if (!isSimMode(params.mode)) throw new ApiError("simInvalid", 404);
    const body = (await req.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    return NextResponse.json({ result: simulate(params.mode, body) });
  } catch (e) {
    return errorResponse(e);
  }
}
