import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { cancelScan, getScanReport, startScan } from "@/lib/db/scans";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
  return id;
}

/** Scan en cours (avancement) ou dernier scan terminé, comparé à l'inventaire d'aujourd'hui : { scan, rows, counts }. */
export async function GET(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    return NextResponse.json(getScanReport(parseId(params.id)));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Lance un scan en arrière-plan (202). Corps facultatif : { icmp?, ports?, resolve? }. Un seul scan à la fois (409). */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    const raw = await req.text();
    let body: unknown = undefined;
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ApiError("invalidBody", 400);
      }
    }
    const { scan } = startScan(id, body);
    audit({ action: "create", entity: "scan", entityId: id });
    return NextResponse.json({ scan }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Annule le scan en cours : le résultat partiel est enregistré. */
export async function DELETE(_req: Request, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = parseId(params.id);
    cancelScan(id);
    audit({ action: "delete", entity: "scan", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
