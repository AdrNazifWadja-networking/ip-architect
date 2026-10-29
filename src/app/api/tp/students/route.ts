import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { listStudents } from "@/lib/db/tpclasses";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Comptes qu'on peut inscrire dans une classe (étudiants actifs), pour l'enseignant. */
export async function GET() {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    return NextResponse.json({ students: listStudents() });
  } catch (e) {
    return errorResponse(e);
  }
}
