import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { releaseAddress } from "@/lib/db/ipam";
import { updateAddress } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateAddressInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string; addressId: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const networkId = Number(params.id);
    const addressId = Number(params.addressId);
    if (!Number.isInteger(networkId) || !Number.isInteger(addressId)) throw new ApiError("invalidId", 400);
    const label = auditLabel("address", addressId);
    const tracked = trackChanges("address", addressId);
    releaseAddress(networkId, addressId);
    audit({ action: "delete", entity: "address", entityId: addressId, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modifie le type (utilisée / réservée), le nom d'hôte ou la description d'une adresse inventoriée. */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string; addressId: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const networkId = Number(params.id);
    const addressId = Number(params.addressId);
    if (!Number.isInteger(networkId) || !Number.isInteger(addressId)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as UpdateAddressInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("address", addressId);
    const address = updateAddress(networkId, addressId, body);
    audit({ action: "update", entity: "address", entityId: address.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ address });
  } catch (e) {
    return errorResponse(e);
  }
}
