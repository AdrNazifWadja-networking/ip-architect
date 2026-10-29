import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createWebhook, listWebhooks } from "@/lib/db/webhooks";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Webhooks du projet actif (sans leur secret). */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    return NextResponse.json({ webhooks: listWebhooks() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Crée un webhook { name, url, events?, active? } ; le secret de signature n'est renvoyé qu'ici (et à la régénération). */
export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const r = createWebhook(body);
    audit({ action: "create", entity: "webhook", entityId: r.webhook.id });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
