import { guard } from "@/lib/auth/guard";
import { NextRequest, NextResponse } from "next/server";
import { exportCsv, isCsvEntity } from "@/lib/db/csvio";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";
import type { Delimiter } from "@/lib/csv/csv";

export const dynamic = "force-dynamic";

const DELIMITERS: Record<string, Delimiter> = { semicolon: ";", comma: ",", tab: "\t" };

/**
 * Télécharge un fichier CSV (UTF-8 avec BOM : Excel affiche correctement les accents).
 * ?delimiter=semicolon|comma|tab (défaut : semicolon, le séparateur attendu par Excel en français)
 * ?template=1 : en-tête + une ligne d'exemple, pour préparer un import.
 */
export async function GET(req: NextRequest, { params: rawParams }: { params: Promise<{ entity: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    if (!isCsvEntity(params.entity)) throw new ApiError("csvUnknownEntity", 404);
    const d = req.nextUrl.searchParams.get("delimiter") ?? "semicolon";
    if (!(d in DELIMITERS)) throw new ApiError("invalidBody", 400);
    const out = exportCsv(params.entity, {
      delimiter: DELIMITERS[d],
      template: req.nextUrl.searchParams.get("template") === "1",
    });
    return new NextResponse(out.content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
