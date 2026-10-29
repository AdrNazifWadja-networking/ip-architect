import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { deleteSchedule, getSchedule, setSchedule } from "@/lib/db/scans";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

/** Scan programmé du réseau : { schedule } ou { schedule: null }. */
export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    return NextResponse.json({ schedule: getSchedule(parseId(params.id)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Crée ou modifie { everyHours?: 1|6|12|24|168, enabled?, alert?, icmp?, ports?, resolve? }. */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const schedule = setSchedule(id, body);
    audit({ action: "update", entity: "scan", entityId: id, detail: "programmation" });
    return NextResponse.json({ schedule });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    deleteSchedule(id);
    audit({ action: "delete", entity: "scan", entityId: id, detail: "programmation" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
