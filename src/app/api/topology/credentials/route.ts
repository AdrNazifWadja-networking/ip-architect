import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { createCredential, listCredentials } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
};
const readBody = async (req: Request): Promise<unknown> => req.json().catch(() => { throw new ApiError("invalidBody", 400); });

/** Identifiants SNMP du projet : { credentials: [{ id, name, port }] }. La communauté n'est jamais renvoyée. */
export async function GET() {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    return NextResponse.json({ credentials: listCredentials() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Crée { name, community, port? }. */
export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const credential = createCredential(await readBody(req));
    audit({ action: "create", entity: "snmpCredential", entityId: credential.id, detail: credential.name });
    return NextResponse.json({ credential }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
