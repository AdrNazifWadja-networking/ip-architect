import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { createLink } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

/** Ajoute un lien à la main : { aDevice, bDevice, aPort?, bPort?, speedMbps? }. */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const link = createLink(await readBody(req));
    audit({ action: "create", entity: "topoLink", entityId: link.id, detail: `${link.aDevice} ↔ ${link.bDevice}` });
    return NextResponse.json({ link }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
