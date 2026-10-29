import { NextResponse } from "next/server";
import { assertSameOrigin, currentUser, guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { askAssistant } from "@/lib/ai/agent";
import { assistantLimiter } from "@/lib/ai/limit";
import { getAiConfig } from "@/lib/db/aisettings";
import { getLocale } from "@/lib/i18n/server";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Pose une question : corps { messages: [{ role: "user"|"assistant", content }] } (le dernier vient de l'utilisateur).
 * Lecteur et plus : l'assistant ne modifie rien. Limité par utilisateur. Le journal d'audit garde le service, le modèle et
 * les outils consultés, JAMAIS le texte de la question.
 */
export async function POST(req: Request) {
  const denied = guard("viewer");
  if (denied) return denied;
  try {
    assertSameOrigin(); // chaque question coûte du temps de calcul (ou un quota externe)
    const body = (await req.json().catch(() => null)) as { messages?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalidBody", 400);
    const wait = assistantLimiter.take(String(currentUser()?.id ?? "anon"));
    if (wait > 0) throw new ApiError("aiTooManyRequests", 429, { minutes: Math.max(1, Math.ceil(wait / 60000)) });
    const reply = await askAssistant(body.messages, getLocale());
    const cfg = getAiConfig();
    audit({
      action: "ask",
      entity: "assistant",
      detail: `${cfg.provider} · ${reply.model} · ${reply.tools.length ? reply.tools.map((x) => x.name).join(", ") : "—"}`,
    });
    return NextResponse.json(reply);
  } catch (e) {
    return errorResponse(e);
  }
}
