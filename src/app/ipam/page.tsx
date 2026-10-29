import { requireUser } from "@/lib/auth/guard";
import Link from "next/link";
import { Search } from "lucide-react";
import { listNetworks } from "@/lib/db/queries";
import { countInventoried } from "@/lib/db/ipam";
import { format } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n/server";
import { fmtInt, fmtPct } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default async function IpamPage(props: { searchParams: Promise<{ q?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t, locale } = getDictionary();
  const q = searchParams.q?.trim() ?? "";
  const networks = listNetworks({ q });
  const inventoried = countInventoried();
  const col = t.ipam.columns;

  return (
    <>
      <PageHeader title={t.ipam.title} subtitle={t.ipam.subtitle} />

      {/* Formulaire GET classique : fonctionne sans JavaScript */}
      <form action="/ipam" method="get" className="relative mb-4 max-w-sm" role="search">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          name="q"
          defaultValue={q}
          placeholder={t.ipam.searchPlaceholder}
          aria-label={t.ipam.searchLabel}
          className="input pl-9"
        />
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.network}</th>
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.site}</th>
              <th className="px-4 py-3 font-medium">{col.usage}</th>
              <th className="px-4 py-3 font-medium">{col.inventoried}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {networks.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted">
                  {t.ipam.empty}
                </td>
              </tr>
            )}
            {networks.map((n) => {
              const bar = n.usagePct >= 85 ? "bg-bad" : n.usagePct >= 65 ? "bg-warn" : "bg-ok";
              return (
                <tr key={n.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          n.version === 4 ? "bg-ipv4/20 text-ipv4" : "bg-ipv6/20 text-ipv6"
                        }`}
                      >
                        v{n.version}
                      </span>
                      <Link href={`/ipam/${n.id}`} className="font-mono text-[13px] text-fg hover:text-brand-soft">
                        {n.cidr}
                      </Link>
                      {n.vrfName && (
                        <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-soft">{n.vrfName}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-fg2">{n.name}</td>
                  <td className="px-4 py-3 text-muted">{n.siteName ?? "—"}</td>
                  <td className="px-4 py-3">
                    {n.version === 4 ? (
                      <div className="w-44">
                        <div className="mb-1 flex justify-between text-xs text-muted">
                          <span>
                            {fmtInt(n.usedIps + n.reservedIps, locale)} / {fmtInt(n.capacity, locale)}
                          </span>
                          <span className="text-fg2">
                            {fmtPct(n.capacity > 0 ? Math.min(100, ((n.usedIps + n.reservedIps) / n.capacity) * 100) : 0, locale, 0)}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-line">
                          <div
                            className={`h-full rounded-full ${bar}`}
                            style={{ width: `${n.capacity > 0 ? Math.min(100, ((n.usedIps + n.reservedIps) / n.capacity) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">{fmtInt(n.usedIps + n.reservedIps, locale)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg2">{fmtInt(inventoried.get(n.id) ?? 0, locale)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/ipam/${n.id}`}
                      aria-label={format(t.ipam.manageLabel, { cidr: n.cidr })}
                      className="btn-ghost h-8 px-3 text-xs"
                    >
                      {t.ipam.manage}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">{format(t.ipam.shown, { n: networks.length })}</p>
    </>
  );
}
