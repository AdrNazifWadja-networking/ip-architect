import { NextResponse } from "next/server";
import { currentUser, guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { deleteExercise, isTeacher, studentDetail, teacherDetail, updateExercise } from "@/lib/db/tp";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

function idOf(params: { id: string }): number {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

/**
 * Détail d'un exercice. Un enseignant reçoit l'énoncé, la solution de référence et les résultats ; un étudiant reçoit
 * l'énoncé (ses propres questions), ses remises et, une fois dévoilée, la solution. Jamais la bonne réponse avant.
 */
export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = idOf(params);
    const user = currentUser();
    return NextResponse.json(isTeacher(user) ? { role: "teacher", ...teacherDetail(id, user) } : { role: "student", ...studentDetail(id, user) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle. Le type d'exercice est fixe ; l'énoncé ne change plus dès qu'il y a des remises (409). */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = idOf(params);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("exercise", id);
    const exercise = updateExercise(id, body);
    audit({ action: "update", entity: "exercise", entityId: id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ exercise });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Supprime l'exercice et toutes ses remises. */
export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = idOf(params);
    const label = auditLabel("exercise", id);
    const tracked = trackChanges("exercise", id);
    deleteExercise(id);
    audit({ action: "delete", entity: "exercise", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
