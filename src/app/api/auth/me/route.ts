import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { currentUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** État de la connexion : { authEnabled, user } (user = null si non connecté ou si l'application est ouverte). */
export async function GET() {
  try {
    return NextResponse.json({ authEnabled: authEnabled(getDb()), user: currentUser() });
  } catch (e) {
    return errorResponse(e);
  }
}
