"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, Download } from "lucide-react";
import type { AppSettings, DatabaseInfo } from "@/lib/db/appsettings";
import { AUDIT_MAX_RETENTION_DAYS, AUDIT_MIN_RETENTION_DAYS } from "@/lib/auditTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt } from "@/lib/format";

interface Props {
  settings: AppSettings;
  database: DatabaseInfo;
}

function fileSize(bytes: number | null, fallback: string, locale: "fr" | "en"): string {
  if (bytes === null) return fallback;
  const unit = locale === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < unit.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: i === 0 ? 0 : 1 })} ${unit[i]}`;
}

export function SettingsView({ settings, database }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const s = t.settings;

  const [orgName, setOrgName] = useState(settings.orgName);
  const [warn, setWarn] = useState(String(settings.thresholds.warnPct));
  const [crit, setCrit] = useState(String(settings.thresholds.critPct));
  const [retention, setRetention] = useState(String(settings.auditRetentionDays));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgName, warnPct: num(warn), critPct: num(crit), auditRetentionDays: num(retention) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? s.saveFailed);
      setMsg({ ok: true, text: s.saved });
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : s.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  const label = "mb-1 block text-xs font-medium text-fg2";
  const hint = "mt-1 text-[11px] text-muted";

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <form onSubmit={save} className="card space-y-6 p-5 xl:col-span-2" aria-label={s.title}>
        <section className="space-y-3" aria-labelledby="set-org">
          <h2 id="set-org" className="card-title">{s.general.title}</h2>
          <div className="max-w-md">
            <label className={label} htmlFor="set-orgname">{s.general.orgName}</label>
            <input id="set-orgname" className="input" maxLength={80} value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder={s.general.orgNamePlaceholder} />
            <p className={hint}>{s.general.orgNameHint}</p>
          </div>
        </section>

        <section className="space-y-3" aria-labelledby="set-mon">
          <h2 id="set-mon" className="card-title">{s.monitoring.title}</h2>
          <p className="text-xs text-muted">{s.monitoring.hint}</p>
          <div className="grid max-w-md gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="set-warn">{s.monitoring.warn}</label>
              <input id="set-warn" className="input" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="set-crit">{s.monitoring.crit}</label>
              <input id="set-crit" className="input" inputMode="numeric" value={crit} onChange={(e) => setCrit(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="space-y-3" aria-labelledby="set-audit">
          <h2 id="set-audit" className="card-title">{s.audit.title}</h2>
          <p className="text-xs text-muted">{s.audit.hint}</p>
          <div className="max-w-xs">
            <label className={label} htmlFor="set-retention">{s.audit.retention}</label>
            <input id="set-retention" className="input" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value)} />
            <p className={hint}>{format(s.audit.retentionHint, { min: AUDIT_MIN_RETENTION_DAYS, max: AUDIT_MAX_RETENTION_DAYS })}</p>
          </div>
          <Link href="/audit-logs" className="inline-block text-sm text-brand-soft hover:underline">{s.audit.open}</Link>
        </section>

        {msg && (
          <div role={msg.ok ? "status" : "alert"} className={`rounded-md border px-3 py-2 text-sm ${msg.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-bad/40 bg-bad/10 text-bad"}`}>
            {msg.text}
          </div>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? s.saving : s.save}
        </button>
      </form>

      <section className="card space-y-4 p-5" aria-labelledby="set-db">
        <h2 id="set-db" className="card-title flex items-center gap-2">
          <Database className="h-4 w-4" />
          {s.database.title}
        </h2>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">{s.database.file}</dt>
          <dd className="break-all font-mono text-fg2">{database.file}</dd>
          <dt className="text-muted">{s.database.size}</dt>
          <dd className="text-fg2">{fileSize(database.sizeBytes, s.database.unknownSize, locale)}</dd>
          <dt className="text-muted">{s.database.sqlite}</dt>
          <dd className="text-fg2">{database.sqliteVersion}</dd>
        </dl>
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-line">
            {database.counts.map((c) => (
              <tr key={c.table}>
                <td className="py-1.5 text-muted">{(s.database.tables as Record<string, string>)[c.table] ?? c.table}</td>
                <td className="py-1.5 text-right tabular-nums text-fg2">{fmtInt(c.rows, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-2 border-t border-line pt-4">
          <h3 className="label-caps">{s.database.backupTitle}</h3>
          <a href="/api/settings/backup" className="btn-ghost">
            <Download className="h-4 w-4" />
            {s.database.backup}
          </a>
          <p className="text-xs text-muted">{s.database.backupHint}</p>
          <p className="text-xs text-warn">{s.database.backupWarn}</p>
        </div>
      </section>
    </div>
  );
}
