import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { cancelDiscovery, discoveryStatus, startDiscovery } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

/** Avancement de la découverte en cours ou de la dernière : { discovery }. */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  return NextResponse.json({ discovery: discoveryStatus() });
}

/** Lance une découverte en arrière-plan (202) : { seed, credentialId, depth? }. Une seule à la fois (409). */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const { status } = startDiscovery(await readBody(req));
    audit({ action: "create", entity: "topoDevice", detail: `découverte depuis ${status.seed}` });
    return NextResponse.json({ discovery: status }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Annule la découverte en cours : ce qui a déjà été trouvé est enregistré. */
export async function DELETE() {
  const denied = guard("editor");
  if (denied) return denied;
  cancelDiscovery();
  audit({ action: "delete", entity: "topoDevice", detail: "découverte annulée" });
  return NextResponse.json({ ok: true });
}
