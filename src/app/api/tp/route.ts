import { NextResponse } from "next/server";
import { currentUser, guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createExercise, listExercises } from "@/lib/db/tp";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Exercices : un enseignant voit tous (brouillons compris), un étudiant seulement les publiés, avec ses propres tentatives. */
export async function GET() {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    return NextResponse.json({ exercises: listExercises(currentUser()) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Crée un exercice `{ title, kind: "vlsm"|"subnet", config, description?, maxAttempts?, dueAt?, published?, showSolution? }`. */
export async function POST(req: Request) {
  const denied = guard("editor");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const exercise = createExercise(body, currentUser());
    audit({ action: "create", entity: "exercise", entityId: exercise.id, detail: `${exercise.title} (${exercise.kind})` });
    return NextResponse.json({ exercise }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
