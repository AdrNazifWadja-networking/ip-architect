import { requireUser } from "@/lib/auth/guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { exportScopeConfig, getScope, listReservations } from "@/lib/db/dhcp";
import { ApiError, type DhcpScopeRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n/server";
import { fmtInt } from "@/lib/format";
import { formatLease } from "@/lib/dhcp/lease";
import { parseIp } from "@/lib/ip/cidr";
import { PageHeader } from "@/components/PageHeader";
import { ReservationManager } from "@/components/dhcp/ReservationManager";
import { ConfigExport } from "@/components/dhcp/ConfigExport";
import { EditScopeButton } from "@/components/dhcp/EditScopeButton";

export const dynamic = "force-dynamic";

function loadScope(id: number): DhcpScopeRow | null {
  try {
    return getScope(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="card p-4">
      <div className="label-caps">{label}</div>
      <div className={`mt-1.5 text-xl font-bold ${tone === "bad" ? "text-bad" : "text-fg"}`}>{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-caps">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[13px] text-fg2">{value}</dd>
    </div>
  );
}

export default async function DhcpDetailPage(props: { params: Promise<{ id: string }> }) {
  requireUser();
  const params = await props.params;
  const { t, locale } = getDictionary();
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();
  const scope = loadScope(id);
  if (!scope) notFound();

  const reservations = listReservations(id);
  const d = t.dhcp.detail;
  const gw = scope.gateway ? parseIp(scope.gateway)?.value : undefined;
  const gatewayInRange =
    gw !== undefined &&
    gw >= (parseIp(scope.rangeStart)?.value ?? 0n) &&
    gw <= (parseIp(scope.rangeEnd)?.value ?? 0n);

  return (
    <>
      <PageHeader
        title={scope.name}
        subtitle={scope.siteName ? `${scope.networkCidr} · ${scope.siteName}` : scope.networkCidr}
        actions={
          <div className="flex items-center gap-2">
            <EditScopeButton scope={scope} />
            <Link href="/dhcp" className="btn-ghost">
              <ArrowLeft className="h-4 w-4" />
              {d.back}
            </Link>
          </div>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={d.stats.pool} value={fmtInt(scope.poolSize, locale)} />
        <Stat label={d.stats.distributable} value={fmtInt(scope.distributable, locale)} />
        <Stat label={d.stats.reservations} value={fmtInt(scope.reservationCount, locale)} />
        <Stat label={d.stats.conflicts} value={fmtInt(scope.conflictCount, locale)} tone={scope.conflictCount > 0 ? "bad" : undefined} />
      </section>

      <section className="card mb-4 p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-6">
          <Info label={d.info.network} value={`${scope.networkCidr} (${scope.networkName})`} />
          <Info label={d.info.range} value={`${scope.rangeStart} – ${scope.rangeEnd}`} />
          <Info label={d.info.gateway} value={scope.gateway ?? d.info.none} />
          <Info label={d.info.dns} value={scope.dns.length ? scope.dns.join(", ") : d.info.none} />
          <Info label={d.info.lease} value={formatLease(scope.leaseSeconds, t.dhcp.lease)} />
          <Info label={d.info.status} value={scope.enabled ? t.dhcp.enabled : t.dhcp.disabled} />
        </dl>
      </section>

      {scope.conflictCount > 0 && (
        <p role="alert" className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {format(d.conflictNote, { n: scope.conflictCount })}
        </p>
      )}
      {gatewayInRange && scope.gateway && (
        <p role="alert" className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {format(d.gatewayInRange, { gateway: scope.gateway })}
        </p>
      )}

      <ReservationManager scope={scope} reservations={reservations} />

      <ConfigExport
        scopeName={scope.name}
        configs={{ isc: exportScopeConfig(id, "isc"), cisco: exportScopeConfig(id, "cisco") }}
      />
    </>
  );
}
