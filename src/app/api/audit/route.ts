import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { listAudit, listAuditForExport } from "@/lib/db/audit";
import { auditCsv } from "@/lib/auditCsv";
import { csvFilename } from "@/lib/db/csvio";
import { getActiveProject } from "@/lib/db/queries";
import { getDictionary } from "@/lib/i18n/server";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import type { Delimiter } from "@/lib/csv/csv";
import { auditFiltersFrom } from "@/lib/auditFilters";

export const dynamic = "force-dynamic";

const DELIMITERS: Record<string, Delimiter> = { semicolon: ";", comma: ",", tab: "\t" };

/**
 * Journal d'audit (administrateur) : JSON paginé, ou `?format=csv` (toutes les lignes filtrées, 50 000 au plus).
 * Filtres : q, user, action, entity, from, to (AAAA-MM-JJ, UTC), page.
 */
export async function GET(req: NextRequest) {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const sp = req.nextUrl.searchParams;
    const filters = auditFiltersFrom((k) => sp.get(k));
    if (sp.get("format") !== "csv") return NextResponse.json({ audit: listAudit(filters) });

    const d = sp.get("delimiter") ?? "semicolon";
    if (!(d in DELIMITERS)) throw new ApiError("invalidBody", 400);
    const { t } = getDictionary();
    const { rows } = listAuditForExport(filters);
    return new NextResponse(auditCsv(rows, t, DELIMITERS[d]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(getActiveProject().name, "journal-audit")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
