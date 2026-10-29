import { NextResponse } from "next/server";
import { currentUser, guard } from "@/lib/auth/guard";
import { submitAnswers } from "@/lib/db/tp";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Remise d'un étudiant `{ answers }` -> note, commentaire par élément, tentatives restantes. Ce n'est pas une modification
 * des données d'adressage : la remise est elle-même la trace (date, compte, réponses, note) et n'est pas répétée dans le
 * journal d'audit.
 */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as { answers?: unknown } | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    return NextResponse.json(submitAnswers(id, currentUser(), body.answers), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
