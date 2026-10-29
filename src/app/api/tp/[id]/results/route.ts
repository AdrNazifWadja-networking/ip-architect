import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getExercise, listResults } from "@/lib/db/tp";
import { csvFilename } from "@/lib/db/csvio";
import { toCsv, type Delimiter } from "@/lib/csv/csv";
import { getDictionary } from "@/lib/i18n/server";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

const DELIMITERS: Record<string, Delimiter> = { semicolon: ";", comma: ",", tab: "\t" };

/** Résultats par étudiant (tentatives, meilleure note, dernière note) ; `?format=csv` pour un tableur (notes sur 100). */
export async function GET(req: NextRequest, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const ex = getExercise(id);
    const results = listResults(id);
    const sp = req.nextUrl.searchParams;
    if (sp.get("format") !== "csv") return NextResponse.json({ results });
    const d = sp.get("delimiter") ?? "semicolon";
    if (!(d in DELIMITERS)) throw new ApiError("invalidBody", 400);
    const c = getDictionary().t.tp.results.columns;
    const csv = toCsv(
      [c.student, c.attempts, c.best, c.last, c.lastAt],
      results.map((r) => [r.username, r.attempts, r.best, r.last, r.lastAt]),
      DELIMITERS[d],
    );
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(ex.title, "notes")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
