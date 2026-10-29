import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { createDevice } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

/** Ajoute un équipement à la main : { name, kind?, address?, info?, siteId?, credentialId? }. */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const device = createDevice(await readBody(req));
    audit({ action: "create", entity: "topoDevice", entityId: device.id, detail: device.name });
    return NextResponse.json({ device }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
