import { NextResponse } from "next/server";
import { assertSameOrigin, guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { listModels } from "@/lib/ai/client";
import { cleanApiKey, cleanBaseUrl, getAiConfig, getAiSecret } from "@/lib/db/aisettings";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Teste la connexion et liste les modèles du service (administrateur). Corps facultatif { baseUrl?, apiKey? } pour tester
 * le formulaire avant de l'enregistrer ; sinon la configuration enregistrée. Ne modifie rien.
 */
export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    assertSameOrigin();
    const body = (await req.json().catch(() => ({}))) as { baseUrl?: unknown; apiKey?: unknown } | null;
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new ApiError("invalidBody", 400);
    const baseUrl = body?.baseUrl !== undefined ? cleanBaseUrl(body.baseUrl) : getAiConfig().baseUrl;
    if (!baseUrl) throw new ApiError("aiNotConfigured", 409);
    const apiKey = body?.apiKey !== undefined && body.apiKey !== "" ? cleanApiKey(body.apiKey) : getAiSecret();
    return NextResponse.json({ models: await listModels({ baseUrl, apiKey }) });
  } catch (e) {
    return errorResponse(e);
  }
}
