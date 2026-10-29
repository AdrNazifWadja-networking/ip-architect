import { currentUser, guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { leaveDemo } from "@/lib/db/demo";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateProjectInput } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Quitte les données de démonstration : crée { name, description? } (le premier vrai projet), l'active, puis supprime le projet
 * de démonstration et tout son contenu. Réponse : { project, removed }.
 */
export async function POST(req: NextRequest) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as CreateProjectInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const { project, removed } = leaveDemo(body, undefined, currentUser());
    audit({ action: "create", entity: "project", entityId: project.id });
    audit({ action: "delete", entity: "project", entityId: removed.id, detail: removed.name });
    return NextResponse.json({ project, removed });
  } catch (e) {
    return errorResponse(e);
  }
}
