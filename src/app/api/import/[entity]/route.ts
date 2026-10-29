import { guard } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { importCsv, isCsvEntity } from "@/lib/db/csvio";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api";
import { getDictionary } from "@/lib/i18n/server";
import { format } from "@/lib/i18n";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Body {
  csv?: unknown;
  /** Absent ou true = simulation (rien n'est écrit). false = import réel. */
  dryRun?: unknown;
  onExisting?: unknown;
}

/**
 * Importe un fichier CSV dans le projet actif.
 * Corps JSON : { csv: "<contenu>", dryRun?: boolean, onExisting?: "skip" | "error" }
 * Réponse 200 : { result } même quand des lignes sont en erreur (result.errors, result.committed = false).
 * Tout ou rien : s'il y a une erreur ou en simulation, rien n'est écrit.
 */
export async function POST(req: Request, { params: rawParams }: { params: Promise<{ entity: string }> }) {
  const denied = guard("editor");
  if (denied) return denied;
  const params = await rawParams;
  try {
    if (!isCsvEntity(params.entity)) throw new ApiError("csvUnknownEntity", 404);
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body || typeof body !== "object" || typeof body.csv !== "string") throw new ApiError("invalidBody", 400);
    if (body.onExisting !== undefined && body.onExisting !== "skip" && body.onExisting !== "error") {
      throw new ApiError("invalidBody", 400);
    }
    const result = importCsv(params.entity, body.csv, {
      dryRun: body.dryRun !== false,
      onExisting: body.onExisting === "error" ? "error" : "skip",
    });
    if (result.committed) {
      audit({ action: "import", entity: "csv", detail: `${params.entity} · ${result.created} created, ${result.skipped} skipped` });
    }
    const { t } = getDictionary();
    result.errors = result.errors.map((e) => ({ ...e, message: format(t.errors[e.code], e.params) }));
    return NextResponse.json({ result });
  } catch (e) {
    return errorResponse(e);
  }
}
