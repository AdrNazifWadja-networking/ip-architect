import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countUsers, createUser, listUsers } from "@/lib/db/users";
import { audit } from "@/lib/audit";
import { assertSameOrigin, currentUser } from "@/lib/auth/guard";
import { atLeast } from "@/lib/auth/roles";
import { assertSetupCode, clearSetupCode } from "@/lib/auth/setup";
import { errorResponse } from "@/lib/api";
import { ApiError, type CreateUserInput } from "@/lib/types";

export const dynamic = "force-dynamic";

// access: custom — règle dans chaque gestionnaire (le tout premier compte se crée sans connexion)
export async function GET() {
  try {
    const user = currentUser();
    // application ouverte (aucun compte) : liste vide ; sinon administrateur seulement
    if (countUsers(getDb()) > 0 && !(user && atLeast(user.role, "admin"))) throw new ApiError(user ? "forbidden" : "authRequired", user ? 403 : 401);
    return NextResponse.json({ users: listUsers() });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Création d'un compte : { username, displayName, password, role? }.
 * Administrateur uniquement, SAUF pour le tout premier compte (application encore ouverte) : il devient administrateur
 * et la connexion est alors exigée pour tous.
 */
export async function POST(req: Request) {
  try {
    const db = getDb();
    const bootstrap = countUsers(db) === 0;
    if (!bootstrap) {
      const user = currentUser();
      if (!user) throw new ApiError("authRequired", 401);
      if (!atLeast(user.role, "admin")) throw new ApiError("forbidden", 403);
      assertSameOrigin();
    }
    const body = (await req.json().catch(() => null)) as (CreateUserInput & { setupCode?: unknown }) | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    if (bootstrap) assertSetupCode(body.setupCode, db); // production : le premier compte exige le code affiché dans la console
    const created = await createUser(body, db, { bootstrap });
    if (bootstrap) clearSetupCode(db);
    // premier compte : l'acteur est le compte tout juste créé (l'application était ouverte, personne n'était connecté)
    audit({
      action: "create",
      entity: "user",
      entityId: created.id,
      detail: `${created.username} (${created.role})`,
      ...(bootstrap ? { actor: { id: created.id, username: created.username } } : {}),
    });
    return NextResponse.json({ user: created }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
