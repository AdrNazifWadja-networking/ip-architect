import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getProbeTargets } from "@/lib/db/monitoring";
import { PingUnavailableError, pingMany } from "@/lib/monitor/ping";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export interface ProbeResponse {
  results: { address: string; hostname: string | null; alive: boolean; ms: number | null }[];
  total: number;
  truncated: boolean;
}

/**
 * Teste la joignabilité (ping) des adresses inventoriées d'un réseau du projet actif.
 * Corps : { networkId }. Seules des adresses DÉJÀ enregistrées dans l'IPAM peuvent être testées.
 */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { networkId?: unknown } | null;
    if (!body || typeof body !== "object" || !Number.isInteger(body.networkId)) throw new ApiError("invalidBody", 400);
    const { targets, total } = getProbeTargets(body.networkId as number);
    let pings;
    try {
      pings = await pingMany(targets.map((t) => t.address));
    } catch (e) {
      if (e instanceof PingUnavailableError) throw new ApiError("pingUnavailable", 501);
      throw e;
    }
    const payload: ProbeResponse = {
      results: targets.map((t, i) => ({ ...t, alive: pings[i].alive, ms: pings[i].ms })),
      total,
      truncated: total > targets.length,
    };
    return NextResponse.json(payload);
  } catch (e) {
    return errorResponse(e);
  }
}
