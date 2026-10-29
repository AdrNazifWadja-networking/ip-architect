import { NextResponse } from "next/server";
import { assertSameOrigin, guard } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { deliverMail } from "@/lib/mail/send";
import { testMail } from "@/lib/mail/templates";
import { getLocale } from "@/lib/i18n/server";
import { normalizeEmail } from "@/lib/signupTypes";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Envoie un message de test avec les réglages ENREGISTRÉS : { to } (administrateur). Ne modifie rien. */
export async function POST(req: Request) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    assertSameOrigin();
    const body = (await req.json().catch(() => null)) as { to?: unknown } | null;
    const to = normalizeEmail(body?.to);
    if (!to) throw new ApiError("emailInvalid", 422);
    await deliverMail(getDb(), { to, ...testMail(getLocale()) });
    return NextResponse.json({ ok: true, to });
  } catch (e) {
    return errorResponse(e);
  }
}
