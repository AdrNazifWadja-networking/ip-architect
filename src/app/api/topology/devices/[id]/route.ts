import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { deleteDevice, getDevice, listClients, updateDevice } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

type Ctx = { params: Promise<{ id: string }> };

/** Un équipement et les machines vues sur ses ports : { device, clients }. */
export async function GET(_req: Request, { params: rawParams }: Ctx) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    return NextResponse.json({ device: getDevice(id), clients: listClients(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modifie { name?, kind?, address?, info?, siteId?, credentialId?, x?, y? } (x et y à null : retour au placement automatique). */
export async function PATCH(req: Request, { params: rawParams }: Ctx) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const device = updateDevice(id, await readBody(req));
    audit({ action: "update", entity: "topoDevice", entityId: id, detail: device.name });
    return NextResponse.json({ device });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: Ctx) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const name = getDevice(id).name;
    deleteDevice(id);
    audit({ action: "delete", entity: "topoDevice", entityId: id, detail: name });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
