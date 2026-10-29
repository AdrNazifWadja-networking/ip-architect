import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { deleteCredential, updateCredential } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

type Ctx = { params: Promise<{ id: string }> };

/** Modifie { name?, port?, community? } (communauté absente ou vide : inchangée). */
export async function PATCH(req: Request, { params: rawParams }: Ctx) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const credential = updateCredential(id, await readBody(req));
    audit({ action: "update", entity: "snmpCredential", entityId: id, detail: credential.name });
    return NextResponse.json({ credential });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: Ctx) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    deleteCredential(id);
    audit({ action: "delete", entity: "snmpCredential", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
