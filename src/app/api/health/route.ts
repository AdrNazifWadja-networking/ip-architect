import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Sonde de santé utilisée par la barre de statut en bas de l'interface. */
export async function GET() {
  const t0 = performance.now();
  let database = false;
  try {
    getDb().prepare("SELECT 1").get();
    database = true;
  } catch {
    database = false;
  }
  return NextResponse.json({
    api: true,
    database,
    responseMs: Math.round(performance.now() - t0),
  });
}
