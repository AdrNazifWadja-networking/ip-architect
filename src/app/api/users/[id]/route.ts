import { NextResponse } from "next/server";
import { deleteUser, getUser, updateUser } from "@/lib/db/users";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { guard, requireSessionUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateUserInput } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    return NextResponse.json({ user: getUser(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modification partielle : { displayName?, role?, active?, password? } (administrateur). */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = (await req.json().catch(() => null)) as UpdateUserInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("user", id);
    const user = await updateUser(id, body, requireSessionUser().id);
    audit({ action: "update", entity: "user", entityId: user.id, changes: tracked.updated(), detail: `${user.username} (${user.role}${user.active ? "" : ", inactive"})`, fields: body });
    return NextResponse.json({ user });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("admin");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const label = auditLabel("user", id);
    const tracked = trackChanges("user", id);
    deleteUser(id, requireSessionUser().id);
    audit({ action: "delete", entity: "user", entityId: id, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
