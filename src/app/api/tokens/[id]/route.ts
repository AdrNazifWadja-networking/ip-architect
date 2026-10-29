import { NextResponse } from "next/server";
import { assertSameOrigin, guard, requireSessionUser } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { revokeToken } from "@/lib/db/tokens";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Révoque un jeton (le sien, ou n'importe lequel pour un administrateur). La ligne est conservée, le jeton est refusé aussitôt. */
export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    assertSameOrigin();
    const me = requireSessionUser();
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const row = revokeToken(id, me);
    audit({ action: "delete", entity: "token", entityId: id, detail: `${row.name} (${row.prefix}…, ${row.username})` });
    return NextResponse.json({ token: row });
  } catch (e) {
    return errorResponse(e);
  }
}
