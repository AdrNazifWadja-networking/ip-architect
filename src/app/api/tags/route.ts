import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createTag, listTags } from "@/lib/db/meta";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Étiquettes du projet actif, avec le nombre de réseaux et d'adresses qui les portent. */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ tags: listTags() });
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
    const tag = createTag(body);
    audit({ action: "create", entity: "tag", entityId: tag.id });
    return NextResponse.json({ tag }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
