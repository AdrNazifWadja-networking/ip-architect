import { NextResponse } from "next/server";
import { ApiError } from "./types";
import { BulkError } from "./db/bulk";
import { format } from "./i18n";
import { getDictionary } from "./i18n/server";

/** Convertit une exception en réponse JSON, avec le message dans la langue de l'utilisateur. */
export function errorResponse(e: unknown): NextResponse {
  const { t } = getDictionary();

  if (e instanceof BulkError) {
    const c = e.cause;
    const reason = format(t.errors[c.code], c.params);
    return NextResponse.json({ error: format(t.errors.bulkItemFailed, { cidr: e.cidr, reason }), code: c.code, cidr: e.cidr }, { status: c.status });
  }
  if (e instanceof ApiError) {
    return NextResponse.json({ error: format(t.errors[e.code], e.params), code: e.code }, { status: e.status });
  }
  console.error(e);
  return NextResponse.json({ error: t.errors.internal, code: "internal" }, { status: 500 });
}
