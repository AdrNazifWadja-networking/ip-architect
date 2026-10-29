"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, AlertTriangle, CheckCircle2, Info, ShieldAlert, TrendingUp } from "lucide-react";
import type { MonitoringData, FindingSeverity } from "@/lib/db/monitoring";
import type { ProbeResponse } from "@/app/api/monitoring/probe/route";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt, fmtPct } from "@/lib/format";

export interface ProbeNetwork {
  id: number;
  cidr: string;
  name: string;
  inventoried: number;
}

interface Props {
  data: MonitoringData;
  probeNetworks: ProbeNetwork[];
  /** Nombre de réseaux supervisés non affichés dans le tableau d'occupation. */
  capacityHidden: number;
}

const SEVERITY_STYLE: Record<FindingSeverity, { icon: typeof Info; text: string; bg: string }> = {
  critical: { icon: ShieldAlert, text: "text-bad", bg: "bg-bad/10" },
  warning: { icon: AlertTriangle, text: "text-warn", bg: "bg-warn/10" },
  info: { icon: Info, text: "text-brand-soft", bg: "bg-brand/10" },
};

const LEVEL_BAR: Record<"ok" | "warning" | "critical", string> = { ok: "bg-ok", warning: "bg-warn", critical: "bg-bad" };
const LEVEL_TEXT: Record<"ok" | "warning" | "critical", string> = { ok: "text-ok", warning: "text-warn", critical: "text-bad" };

export function MonitoringView({ data, probeNetworks, capacityHidden }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const m = t.monitoring;

  /* ---- seuils ---- */
  const [warn, setWarn] = useState(String(data.thresholds.warnPct));
  const [crit, setCrit] = useState(String(data.thresholds.critPct));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saveThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/monitoring/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warnPct: Number(warn), critPct: Number(crit) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? m.thresholds.saveFailed);
      setSaveMsg({ ok: true, text: m.thresholds.saved });
      router.refresh();
    } catch (err) {
      setSaveMsg({ ok: false, text: err instanceof Error ? err.message : m.thresholds.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  /* ---- sonde ---- */
  const [networkId, setNetworkId] = useState(probeNetworks[0] ? String(probeNetworks[0].id) : "");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    setProbe(null);
    try {
      const res = await fetch("/api/monitoring/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: Number(networkId) }),
      });
      const body = (await res.json().catch(() => ({}))) as ProbeResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? m.probe.failed);
      setProbe(body);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : m.probe.failed);
    } finally {
      setProbing(false);
    }
  };

  /* ---- prévision ---- */
  const f = data.forecast;
  const slope = f ? Math.abs(f.slopePerDay).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 2 }) : "";

  const statusStyle =
    data.status === "critical"
      ? "border-bad/40 bg-bad/10 text-bad"
      : data.status === "warning"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-ok/40 bg-ok/10 text-ok";
  const StatusIcon = data.status === "ok" ? CheckCircle2 : data.status === "warning" ? AlertTriangle : ShieldAlert;

  return (
    <div className="space-y-6">
      {/* ------------------------------ Synthèse ------------------------------ */}
      <section className="grid gap-4 lg:grid-cols-4" aria-label={m.title}>
        <div className={`flex items-center gap-3 rounded-lg border px-5 py-4 ${statusStyle}`} role="status">
          <StatusIcon className="h-7 w-7 shrink-0" />
          <span className="text-base font-semibold">{m.status[data.status]}</span>
        </div>
        {(["critical", "warning", "info"] as const).map((s) => {
          const st = SEVERITY_STYLE[s];
          const Icon = st.icon;
          return (
            <div key={s} className="card flex items-center gap-3 px-5 py-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full ${st.bg}`}>
                <Icon className={`h-5 w-5 ${st.text}`} />
              </div>
              <div>
                <div className="text-2xl font-bold text-fg" data-testid={`count-${s}`}>
                  {data.counts[s]}
                </div>
                <div className="label-caps">{m.counts[s]}</div>
              </div>
            </div>
          );
        })}
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ------------------------------ Contrôles ------------------------------ */}
        <section className="card xl:col-span-2" aria-labelledby="findings-title">
          <div className="border-b border-line px-5 py-4">
            <h2 id="findings-title" className="card-title">
              {m.findings.title}
            </h2>
          </div>
          {data.findings.length === 0 ? (
            <p className="flex items-center gap-2 px-5 py-8 text-sm text-ok">
              <CheckCircle2 className="h-4 w-4" />
              {m.findings.none}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {data.findings.map((fd, i) => {
                const st = SEVERITY_STYLE[fd.severity];
                const Icon = st.icon;
                return (
                  <li key={i} className="flex items-start gap-3 px-5 py-3">
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${st.bg}`} title={m.counts[fd.severity]}>
                      <Icon className={`h-3.5 w-3.5 ${st.text}`} />
                      <span className="sr-only">{m.counts[fd.severity]}</span>
                    </span>
                    <span className="flex-1 text-sm text-fg">{format(m.findings[fd.kind], fd.params)}</span>
                    <Link href={fd.href} className="shrink-0 text-xs font-medium text-brand-soft hover:underline">
                      {m.findings.fix}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          {/* ------------------------------ Seuils ------------------------------ */}
          <section className="card" aria-labelledby="thr-title">
            <div className="border-b border-line px-5 py-4">
              <h2 id="thr-title" className="card-title">
                {m.thresholds.title}
              </h2>
              <p className="mt-1 text-xs text-muted">{m.thresholds.hint}</p>
            </div>
            <form onSubmit={saveThresholds} className="space-y-3 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label-caps mb-1.5 block" htmlFor="thr-warn">
                    {m.thresholds.warn}
                  </label>
                  <input id="thr-warn" type="number" inputMode="numeric" min={1} max={99} value={warn} onChange={(e) => setWarn(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="label-caps mb-1.5 block" htmlFor="thr-crit">
                    {m.thresholds.crit}
                  </label>
                  <input id="thr-crit" type="number" inputMode="numeric" min={2} max={100} value={crit} onChange={(e) => setCrit(e.target.value)} className="input" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? m.thresholds.saving : m.thresholds.save}
                </button>
                {saveMsg && (
                  <span role={saveMsg.ok ? "status" : "alert"} className={`text-xs ${saveMsg.ok ? "text-ok" : "text-bad"}`}>
                    {saveMsg.text}
                  </span>
                )}
              </div>
            </form>
          </section>

          {/* ------------------------------ Prévision ------------------------------ */}
          <section className="card" aria-labelledby="fc-title">
            <div className="border-b border-line px-5 py-4">
              <h2 id="fc-title" className="card-title flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted" />
                {m.forecast.title}
              </h2>
            </div>
            <div className="space-y-1 px-5 py-4 text-sm">
              {!f ? (
                <p className="text-muted">{m.forecast.insufficient}</p>
              ) : (
                <>
                  <p className="font-semibold text-fg">{format(m.forecast.current, { pct: fmtPct(f.currentPct, locale) })}</p>
                  <p className={f.daysToFull !== null && f.daysToFull <= 90 ? "text-warn" : "text-fg2"}>
                    {f.daysToFull === 0
                      ? m.forecast.full
                      : f.trend === "rising"
                        ? f.daysToFull === null
                          ? format(m.forecast.risingFar, { slope })
                          : format(m.forecast.rising, { slope, days: fmtInt(f.daysToFull, locale) })
                        : f.trend === "falling"
                          ? format(m.forecast.falling, { slope })
                          : m.forecast.flat}
                  </p>
                  <p className="text-xs text-muted">{format(m.forecast.basis, { n: f.points })}</p>
                </>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ------------------------------ Occupation ------------------------------ */}
      <section className="card" aria-labelledby="cap-title">
        <div className="border-b border-line px-5 py-4">
          <h2 id="cap-title" className="card-title">
            {m.capacity.title}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">{m.capacity.network}</th>
                <th className="px-5 py-3 font-medium">{m.capacity.site}</th>
                <th className="w-64 px-5 py-3 font-medium">{m.capacity.occupancy}</th>
                <th className="px-5 py-3 font-medium">{m.capacity.level}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.capacity.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-muted">
                    {m.capacity.empty}
                  </td>
                </tr>
              )}
              {data.capacity.map((c) => (
                <tr key={c.id} className="hover:bg-panel2/60">
                  <td className="px-5 py-3">
                    <Link href={`/ipam/${c.id}`} className="font-mono text-fg hover:underline">
                      {c.cidr}
                    </Link>
                    <div className="text-xs text-muted">{c.name}</div>
                  </td>
                  <td className="px-5 py-3 text-fg2">{c.siteName ?? "—"}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-2 flex-1 overflow-hidden rounded-full bg-panel2"
                        role="progressbar"
                        aria-valuenow={Math.round(c.occupancyPct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${c.cidr} ${fmtPct(c.occupancyPct, locale)}`}
                      >
                        <div className={`h-full rounded-full ${LEVEL_BAR[c.level]}`} style={{ width: `${Math.max(c.occupancyPct, c.occupancyPct > 0 ? 2 : 0)}%` }} />
                      </div>
                      <span className="w-14 text-right text-fg2">{fmtPct(c.occupancyPct, locale)}</span>
                    </div>
                  </td>
                  <td className={`px-5 py-3 font-medium ${LEVEL_TEXT[c.level]}`}>{m.capacity.levels[c.level]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {capacityHidden > 0 && (
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            {format(m.capacity.more, { n: capacityHidden })}{" "}
            <Link href="/reseaux" className="text-brand-soft hover:underline">
              {t.nav.items.networks}
            </Link>
          </p>
        )}
      </section>

      {/* ------------------------------ Sonde ------------------------------ */}
      <section className="card" aria-labelledby="probe-title">
        <div className="border-b border-line px-5 py-4">
          <h2 id="probe-title" className="card-title flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted" />
            {m.probe.title}
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-muted">{m.probe.intro}</p>
        </div>
        {probeNetworks.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">{m.probe.noNetwork}</p>
        ) : (
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[260px] flex-1 sm:max-w-md">
                <label className="label-caps mb-1.5 block" htmlFor="probe-network">
                  {m.probe.network}
                </label>
                <select id="probe-network" value={networkId} onChange={(e) => setNetworkId(e.target.value)} className="input">
                  {probeNetworks.map((n) => (
                    <option key={n.id} value={n.id}>
                      {format(m.probe.option, { cidr: n.cidr, name: n.name, n: n.inventoried })}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary" onClick={() => void runProbe()} disabled={probing || !networkId}>
                {probing ? m.probe.running : m.probe.run}
              </button>
            </div>

            {probeError && (
              <div role="alert" className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
                {probeError}
              </div>
            )}

            {probe && (
              <div className="mt-4" aria-live="polite">
                <p className="mb-2 text-sm font-semibold text-fg">
                  {format(m.probe.summary, { up: probe.results.filter((r) => r.alive).length, n: probe.results.length })}
                </p>
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                        <th className="px-4 py-2 font-medium">{m.probe.address}</th>
                        <th className="px-4 py-2 font-medium">{m.probe.hostname}</th>
                        <th className="px-4 py-2 font-medium">{m.probe.state}</th>
                        <th className="px-4 py-2 font-medium">{m.probe.latency}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {probe.results.map((r) => (
                        <tr key={r.address}>
                          <td className="px-4 py-2 font-mono text-fg">{r.address}</td>
                          <td className="px-4 py-2 text-fg2">{r.hostname ?? "—"}</td>
                          <td className={`px-4 py-2 font-medium ${r.alive ? "text-ok" : "text-bad"}`}>{r.alive ? m.probe.up : m.probe.down}</td>
                          <td className="px-4 py-2 text-muted">{r.ms === null ? "—" : format(m.probe.ms, { n: r.ms.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 1 }) })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {probe.truncated && <p className="mt-2 text-xs text-muted">{format(m.probe.truncated, { n: probe.results.length, total: probe.total })}</p>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
