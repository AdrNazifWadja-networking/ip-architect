import { guard } from "@/lib/auth/guard";
import { NextRequest, NextResponse } from "next/server";
import { exportScopeConfig } from "@/lib/db/dhcp";
import { DHCP_CONFIG_FORMATS, type DhcpConfigFormat } from "@/lib/dhcp/config";
import { errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/dhcp/scopes/3/config?format=isc|cisco -> configuration en texte brut. */
export async function GET(req: NextRequest, { params: rawParams }: { params: Promise<{ id: string }> }) {
  const denied = guard("viewer");
  if (denied) return denied;
  const params = await rawParams;
  try {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw new ApiError("invalidId", 400);
    const format = (req.nextUrl.searchParams.get("format") ?? "isc") as DhcpConfigFormat;
    if (!DHCP_CONFIG_FORMATS.includes(format)) throw new ApiError("invalidFormat", 400);
    const text = exportScopeConfig(id, format);
    return new NextResponse(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return errorResponse(e);
  }
}
