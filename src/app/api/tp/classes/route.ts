import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createClass, listClasses } from "@/lib/db/tpclasses";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Classes du mode TP (enseignant). */
export async function GET() {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    return NextResponse.json({ classes: listClasses() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const r = createClass(body);
    audit({ action: "create", entity: "tpClass", entityId: r.class.id });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
