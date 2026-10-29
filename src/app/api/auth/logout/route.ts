import { NextResponse } from "next/server";
import { logout } from "@/lib/db/users";
import { currentUser, sessionToken } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/** Ferme la session en cours (sans effet si aucune) et efface le cookie. */
export async function POST() {
  try {
    const who = currentUser();
    logout(sessionToken());
    if (who) audit({ action: "logout", entity: "session", entityId: who.id, actor: { id: who.id, username: who.username } });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
