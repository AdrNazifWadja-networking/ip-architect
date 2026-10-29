import { guard } from "@/lib/auth/guard";
import { NextRequest, NextResponse } from "next/server";
import { getReport, isReportKind } from "@/lib/db/reports";
import { csvCell } from "@/lib/reportFormat";
import { csvFilename } from "@/lib/db/csvio";
import { toCsv, type Delimiter } from "@/lib/csv/csv";
import { errorResponse } from "@/lib/api";
import { getDictionary } from "@/lib/i18n/server";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

const DELIMITERS: Record<string, Delimiter> = { semicolon: ";", comma: ",", tab: "\t" };

/**
 * GET /api/reports/:kind            -> JSON { report }
 * GET /api/reports/:kind?format=csv -> CSV du tableau principal (UTF-8 avec BOM, en-têtes dans la langue de l'utilisateur)
 *   ?delimiter=semicolon|comma|tab (défaut : semicolon, le séparateur attendu par Excel en français)
 */
export async function GET(req: NextRequest, { params: rawParams }: { params: Promise<{ kind: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    if (!isReportKind(params.kind)) throw new ApiError("invalidReport", 404);
    const report = getReport(params.kind);
    if (req.nextUrl.searchParams.get("format") !== "csv") return NextResponse.json({ report });

    const d = req.nextUrl.searchParams.get("delimiter") ?? "semicolon";
    if (!(d in DELIMITERS)) throw new ApiError("invalidBody", 400);
    const { t } = getDictionary();
    const table = report.tables[0];
    const header = table.columns.map((c) => (t.reports.columns as Record<string, string>)[c.key] ?? c.key);
    const rows = table.rows.map((row) => row.map((_, i) => csvCell(table, i, row, t)));
    if (table.footer) {
      rows.push(table.footer.map((cell, i) => (i === 0 ? t.reports.total : csvCell(table, i, table.footer!, t))));
    }
    return new NextResponse(toCsv(header, rows, DELIMITERS[d]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(report.project, `rapport-${report.kind}`)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
