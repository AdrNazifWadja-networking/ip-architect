import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createBackup } from "@/lib/db/appsettings";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Télécharge une copie cohérente de la base SQLite (administrateur). Les sessions ouvertes n'y figurent pas ; les comptes
 * et les empreintes de mot de passe, si : à conserver comme un secret.
 */
export async function GET() {
  const denied = guard("admin");
  if (denied) return denied;
  try {
    const data = createBackup();
    audit({ action: "backup", entity: "database", detail: `${data.length} bytes` });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="ip-architect-sauvegarde-${stamp}.db"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
