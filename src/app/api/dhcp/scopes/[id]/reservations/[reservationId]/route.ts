import { guard } from "@/lib/auth/guard";
import { audit, auditLabel, trackChanges } from "@/lib/audit";
import { NextResponse } from "next/server";
import { deleteReservation } from "@/lib/db/dhcp";
import { updateReservation } from "@/lib/db/edit";
import { errorResponse } from "@/lib/api";
import { ApiError, type UpdateDhcpReservationInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string; reservationId: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const scopeId = Number(params.id);
    const reservationId = Number(params.reservationId);
    if (!Number.isInteger(scopeId) || !Number.isInteger(reservationId)) throw new ApiError("invalidId", 400);
    const label = auditLabel("dhcpReservation", reservationId);
    const tracked = trackChanges("dhcpReservation", reservationId);
    deleteReservation(scopeId, reservationId);
    audit({ action: "delete", entity: "dhcpReservation", entityId: reservationId, detail: label, changes: tracked.removed() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Modifie l'adresse MAC, le nom d'hôte ou la description (pour changer l'IP : supprimer puis recréer). */
export async function PATCH(req: Request, { params: rawParams }: { params: Promise<{ id: string; reservationId: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const scopeId = Number(params.id);
    const reservationId = Number(params.reservationId);
    if (!Number.isInteger(scopeId) || !Number.isInteger(reservationId)) throw new ApiError("invalidId", 400);
    const body = (await req.json().catch(() => null)) as UpdateDhcpReservationInput | null;
    if (!body || typeof body !== "object") throw new ApiError("invalidBody", 400);
    const tracked = trackChanges("dhcpReservation", reservationId);
    const reservation = updateReservation(scopeId, reservationId, body);
    audit({ action: "update", entity: "dhcpReservation", entityId: reservation.id, changes: tracked.updated(), fields: body });
    return NextResponse.json({ reservation });
  } catch (e) {
    return errorResponse(e);
  }
}
