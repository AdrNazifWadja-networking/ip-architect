import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { setPositions } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

/** Positions choisies à la main : { positions: [{ id, x, y }] } ou { reset: true } pour tout remettre en automatique. */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const n = setPositions(await readBody(req));
    audit({ action: "update", entity: "topoDevice", detail: "positions" });
    return NextResponse.json({ updated: n });
  } catch (e) {
    return errorResponse(e);
  }
}
