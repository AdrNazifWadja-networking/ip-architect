import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { getTopology } from "@/lib/db/topology";

export const dynamic = "force-dynamic";

/** Équipements et liens du projet : { devices, links }. */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json(getTopology());
  } catch (e) {
    return errorResponse(e);
  }
}
