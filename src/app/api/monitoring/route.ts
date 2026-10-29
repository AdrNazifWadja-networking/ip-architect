import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getMonitoring } from "@/lib/db/monitoring";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Résultat de la supervision du projet actif (calculé à chaque appel). */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ monitoring: getMonitoring() });
  } catch (e) {
    return errorResponse(e);
  }
}
