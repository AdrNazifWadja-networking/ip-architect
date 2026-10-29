import { requireUser } from "@/lib/auth/guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { exportVrfConfig, getVrf } from "@/lib/db/vrf";
import { listNetworks } from "@/lib/db/queries";
import { ApiError, type VrfRow } from "@/lib/types";
import { getDictionary } from "@/lib/i18n/server";
import { fmtInt, fmtPct } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { VrfConfig } from "@/components/vrf/VrfConfig";
import { EditVrfButton } from "@/components/vrf/EditVrfButton";

export const dynamic = "force-dynamic";

function loadVrf(id: number): VrfRow | null {
  try {
    return getVrf(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="label-caps">{label}</div>
      <div className="mt-1.5 text-xl font-bold text-fg">{value}</div>
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

export default async function VrfDetailPage(props: { params: Promise<{ id: string }> }) {
  requireUser();
  const params = await props.params;
  const { t, locale } = getDictionary();
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();
  const vrf = loadVrf(id);
  if (!vrf) notFound();

  const networks = listNetworks({ vrf: id });
  const d = t.vrf.detail;
  const list = (items: string[]) => (items.length ? items.join(", ") : d.info.none);

  return (
    <>
      <PageHeader
        title={vrf.name}
        subtitle={vrf.rd ?? t.vrf.noRd}
        actions={
          <div className="flex items-center gap-2">
            <EditVrfButton vrf={vrf} />
            <Link href="/vrf" className="btn-ghost">
              <ArrowLeft className="h-4 w-4" />
              {d.back}
            </Link>
          </div>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={d.stats.networks} value={fmtInt(vrf.networkCount, locale)} />
        <Stat label={d.stats.usage} value={vrf.ipv4UsagePct === null ? t.vrf.noUsage : fmtPct(vrf.ipv4UsagePct, locale, 0)} />
        <Stat label={d.stats.imports} value={fmtInt(vrf.rtImport.length, locale)} />
        <Stat label={d.stats.exports} value={fmtInt(vrf.rtExport.length, locale)} />
      </section>

      <section className="card mb-4 p-5">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 lg:grid-cols-4">
          <Info label={d.info.rd} value={vrf.rd ?? t.vrf.noRd} />
          <Info label={d.info.rtImport} value={list(vrf.rtImport)} />
          <Info label={d.info.rtExport} value={list(vrf.rtExport)} />
          <Info label={d.info.description} value={vrf.description ?? d.info.none} />
        </dl>
      </section>

      <section className="card mb-4 overflow-x-auto">
        <h2 className="px-5 pt-5 text-sm font-semibold text-fg">{d.networks.title}</h2>
        <table className="mt-3 w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-y border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-5 py-2.5 font-medium">{d.networks.network}</th>
              <th className="px-4 py-2.5 font-medium">{d.networks.name}</th>
              <th className="px-4 py-2.5 font-medium">{d.networks.site}</th>
              <th className="px-4 py-2.5 font-medium">{d.networks.usage}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {networks.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-muted">
                  {d.networks.empty}
                </td>
              </tr>
            )}
            {networks.map((n) => (
              <tr key={n.id} className="hover:bg-panel2/60">
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        n.version === 4 ? "bg-ipv4/20 text-ipv4" : "bg-ipv6/20 text-ipv6"
                      }`}
                    >
                      v{n.version}
                    </span>
                    <Link
                      href={`/ipam/${n.id}`}
                      title={d.networks.openIpam}
                      className="font-mono text-[13px] text-fg hover:text-brand-soft hover:underline"
                    >
                      {n.cidr}
                    </Link>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-fg2">{n.name}</td>
                <td className="px-4 py-2.5 text-muted">{n.siteName ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">
                  {n.version === 4 ? fmtPct(n.usagePct, locale, 0) : fmtInt(n.usedIps, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <VrfConfig vrfName={vrf.name} config={exportVrfConfig(id)} />
    </>
  );
}
