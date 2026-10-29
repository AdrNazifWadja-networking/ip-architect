import { NextResponse } from "next/server";
import { currentUser, guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { duplicateExercise } from "@/lib/db/tp";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Copie un exercice en brouillon (sans remises ni date limite). */
export async function POST(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const exercise = duplicateExercise(id, currentUser());
    audit({ action: "create", entity: "exercise", entityId: exercise.id, detail: `${exercise.title} (copie de #${id})` });
    return NextResponse.json({ exercise }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
