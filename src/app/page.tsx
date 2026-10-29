import { requireUser } from "@/lib/auth/guard";
import Link from "next/link";
import { CalendarDays, Database, Gauge, Layers, Plus, AlertTriangle } from "lucide-react";
import { getDashboard } from "@/lib/db/queries";
import type { Delta, NetworkStatus } from "@/lib/types";
import { format } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n/server";
import { fmtInt, fmtPct, fmtSigned } from "@/lib/format";
import type { Tone } from "@/components/ThemeProvider";
import { DemoNotice } from "@/components/demo/DemoNotice";
import { PageHeader } from "@/components/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { Donut } from "@/components/dashboard/Donut";
import { UsageChart } from "@/components/dashboard/UsageChart";
import { TopSites } from "@/components/dashboard/TopSites";
import { RecentAlerts } from "@/components/dashboard/RecentAlerts";

export const dynamic = "force-dynamic";

/** Ton sémantique -> classe de fond (suit automatiquement le thème clair/sombre). */
const SWATCH: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-neutral",
  ipv4: "bg-ipv4",
  ipv6: "bg-ipv6",
};

const STATUS_TONE: Record<NetworkStatus, Tone> = {
  active: "ok",
  inactive: "neutral",
  maintenance: "warn",
  error: "bad",
};

function LegendRow({ tone, label, value, badge }: { tone: Tone; label: string; value: string; badge?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="flex items-center gap-2 text-fg2">
        <span className={`h-2.5 w-2.5 rounded-sm ${SWATCH[tone]}`} />
        {label}
        {badge && <span className="rounded bg-ok/10 px-1.5 py-0.5 text-[10px] font-semibold text-ok">{badge}</span>}
      </span>
      <span className="font-semibold text-fg">{value}</span>
    </li>
  );
}

export default function DashboardPage() {
  requireUser();
  const { t, locale } = getDictionary();
  const d = getDashboard();
  const { kpis, addressUsage: au, versionSplit: vs } = d;
  const k = t.dashboard.kpi;

  const delta = (v: Delta | null, unit: "%" | " pts") =>
    v ? { text: `${fmtSigned(v.value, locale)}${unit}`, good: v.inverse ? v.value <= 0 : v.value >= 0 } : null;

  return (
    <>
      <PageHeader
        title={t.dashboard.title}
        subtitle={t.dashboard.subtitle}
        actions={
          <>
            <span className="hidden items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-fg2 sm:flex">
              <CalendarDays className="h-3.5 w-3.5 text-muted" />
              {t.dashboard.period}
            </span>
            <Link href="/reseaux?nouveau=1" className="btn-primary">
              <Plus className="h-4 w-4" />
              {t.dashboard.newButton}
            </Link>
          </>
        }
      />
      <DemoNotice />

      {/* KPIs */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiCard
          label={k.ipv4Networks}
          value={fmtInt(kpis.ipv4Networks, locale)}
          sub={k.subnets}
          tint="bg-ipv6/15 text-ipv6"
          icon={<span className="text-[11px] font-bold">IPv4</span>}
        />
        <KpiCard
          label={k.ipv6Networks}
          value={fmtInt(kpis.ipv6Networks, locale)}
          sub={k.prefixes}
          delta={delta(kpis.ipv6Delta, "%")}
          tint="bg-ipv6/15 text-ipv6"
          icon={<span className="text-[11px] font-bold">IPv6</span>}
        />
        <KpiCard
          label={k.usedIps}
          value={fmtInt(kpis.usedIps, locale)}
          sub={format(k.ofAvailable, { n: fmtInt(kpis.capacity, locale) })}
          tint="bg-ok/15 text-ok"
          icon={<Database className="h-5 w-5" />}
        />
        <KpiCard
          label={k.usageRate}
          value={fmtPct(kpis.usageRate, locale)}
          sub={k.ipOccupancy}
          delta={delta(kpis.usageDelta, " pts")}
          tint="bg-warn/15 text-warn"
          icon={<Gauge className="h-5 w-5" />}
        />
        <KpiCard
          label={k.vlans}
          value={fmtInt(kpis.vlans, locale)}
          sub={k.virtualNetworks}
          delta={delta(kpis.vlanDelta, "%")}
          tint="bg-brand/20 text-brand-soft"
          icon={<Layers className="h-5 w-5" />}
        />
        <KpiCard
          label={k.activeAlerts}
          value={fmtInt(kpis.alerts, locale)}
          sub={k.toHandle}
          delta={delta(kpis.alertDelta, "%")}
          tint="bg-bad/15 text-bad"
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </section>

      {/* Ligne 2 */}
      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card p-5">
          <h2 className="card-title">{t.dashboard.addressUsage.title}</h2>
          <div className="mt-5 flex flex-wrap items-center gap-6">
            <Donut
              segments={[
                { name: t.dashboard.addressUsage.used, value: au.used, tone: "ok" },
                { name: t.dashboard.addressUsage.reserved, value: au.reserved, tone: "warn" },
                { name: t.dashboard.addressUsage.available, value: au.available, tone: "neutral" },
              ]}
              centerTop={fmtPct(au.pct, locale)}
              centerBottom={t.dashboard.addressUsage.usedCenter}
            />
            <ul className="min-w-[180px] flex-1 divide-y divide-line">
              <LegendRow tone="ok" label={t.dashboard.addressUsage.used} value={fmtInt(au.used, locale)} />
              <LegendRow tone="neutral" label={t.dashboard.addressUsage.available} value={fmtInt(au.available, locale)} />
              <LegendRow tone="warn" label={t.dashboard.addressUsage.reserved} value={fmtInt(au.reserved, locale)} />
            </ul>
          </div>
          <div className="mt-5 border-t border-line pt-3 text-[13px] text-muted">
            {t.dashboard.addressUsage.total}
            <span className="ml-1 text-fg2">{format(t.dashboard.addressUsage.totalValue, { n: fmtInt(au.total, locale) })}</span>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="card-title">{t.dashboard.versionSplit.title}</h2>
          <div className="mt-5 flex flex-wrap items-center gap-6">
            <Donut
              segments={[
                { name: "IPv4", value: vs.ipv4, tone: "ipv4" },
                { name: "IPv6", value: vs.ipv6, tone: "ipv6" },
              ]}
              centerTop={fmtInt(vs.total, locale)}
              centerBottom={t.dashboard.versionSplit.usedIps}
              thickness={22}
            />
            <ul className="min-w-[160px] flex-1 divide-y divide-line">
              <LegendRow tone="ipv4" label="IPv4" badge={fmtPct(vs.ipv4Pct, locale)} value={fmtInt(vs.ipv4, locale)} />
              <LegendRow tone="ipv6" label="IPv6" badge={fmtPct(vs.ipv6Pct, locale)} value={fmtInt(vs.ipv6, locale)} />
            </ul>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="card-title">{t.dashboard.topSites.title}</h2>
          <div className="mt-5">
            <TopSites sites={d.topSites} locale={locale} emptyText={t.dashboard.topSites.empty} />
          </div>
        </div>
      </section>

      {/* Ligne 3 */}
      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.7fr_1fr_1.45fr]">
        <div className="card p-5">
          <h2 className="card-title mb-4">{t.dashboard.evolution.title}</h2>
          <UsageChart data={d.history} />
        </div>

        <div className="card p-5">
          <h2 className="card-title">{t.dashboard.byStatus.title}</h2>
          <div className="mt-5 flex flex-wrap items-center gap-5">
            <Donut
              segments={d.statusSplit.map((s) => ({
                name: t.statusPlural[s.status],
                value: s.count,
                tone: STATUS_TONE[s.status],
              }))}
              centerTop={fmtInt(d.statusTotal, locale)}
              centerBottom={t.dashboard.byStatus.total}
              size={150}
            />
            <ul className="min-w-[170px] flex-1 divide-y divide-line">
              {d.statusSplit.map((s) => (
                <LegendRow
                  key={s.status}
                  tone={STATUS_TONE[s.status]}
                  label={t.statusPlural[s.status]}
                  value={`${fmtInt(s.count, locale)} (${fmtPct(s.pct, locale)})`}
                />
              ))}
            </ul>
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="card-title">{t.dashboard.recentAlerts.title}</h2>
          </div>
          <RecentAlerts alerts={d.alerts} t={t} />
        </div>
      </section>
    </>
  );
}
