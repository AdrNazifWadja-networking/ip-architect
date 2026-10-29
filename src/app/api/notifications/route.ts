import { NextResponse } from "next/server";
import { currentUser, guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { getNotifications } from "@/lib/db/notifications";

export const dynamic = "force-dynamic";

/** Notifications du compte : contrôles de supervision en cours (critiques et avertissements) et leur état lu/non lu. */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json(getNotifications(currentUser()?.id));
  } catch (e) {
    return errorResponse(e);
  }
}
