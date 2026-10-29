import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createField, listFields } from "@/lib/db/meta";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import { META_ENTITIES, type MetaEntity } from "@/lib/metaTypes";

export const dynamic = "force-dynamic";

/** Champs personnalisés du projet actif ; ?entity=network|address pour n'en garder qu'un type. */
export async function GET(req: NextRequest) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    const raw = req.nextUrl.searchParams.get("entity");
    const entity = META_ENTITIES.includes(raw as MetaEntity) ? (raw as MetaEntity) : undefined;
    return NextResponse.json({ fields: listFields(entity) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const field = createField(body);
    audit({ action: "create", entity: "customField", entityId: field.id });
    return NextResponse.json({ field }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
