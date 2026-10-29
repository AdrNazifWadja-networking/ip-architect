import { guard } from "@/lib/auth/guard";
import { audit, auditLabel } from "@/lib/audit";
import { NextResponse } from "next/server";
import { allocateAddress, listAddresses } from "@/lib/db/ipam";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateAddressInput } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    return NextResponse.json({ addresses: listAddresses(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Corps vide ou sans `address` : le serveur choisit la première adresse libre du réseau. */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as CreateAddressInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const address = allocateAddress(id, body);
    audit({ action: "create", entity: "address", entityId: address.id });
    return NextResponse.json({ address }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
