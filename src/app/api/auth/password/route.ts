import { NextResponse } from "next/server";
import { changeOwnPassword } from "@/lib/db/users";
import { audit } from "@/lib/audit";
import { assertSameOrigin, guard, requireSessionUser, sessionToken } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Change son propre mot de passe : { currentPassword, newPassword }. Les autres sessions du compte sont fermées. */
export async function POST(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    assertSameOrigin();
    const user = requireSessionUser();
    const body = (await req.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    await changeOwnPassword(user.id, body.currentPassword, body.newPassword, sessionToken());
    audit({ action: "passwordChange", entity: "user", entityId: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
