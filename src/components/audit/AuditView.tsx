"use client";

import Link from "next/link";
import { Download } from "lucide-react";
import { AUDIT_ACTIONS, AUDIT_ENTITIES, type AuditFilters, type AuditPage } from "@/lib/auditTypes";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt } from "@/lib/format";
import { changeValueText, type ChangeSet } from "@/lib/changeTypes";

interface Props {
  data: AuditPage;
  filters: AuditFilters;
  users: string[];
  retentionDays: number;
}

const ACTION_TONE: Record<string, string> = {
  delete: "bg-bad/15 text-bad",
  loginFailed: "bg-bad/15 text-bad",
  create: "bg-ok/15 text-ok",
  login: "bg-brand/10 text-brand-soft",
  logout: "bg-brand/10 text-brand-soft",
};

export function AuditView({ data, filters, users, retentionDays }: Props) {
  const { t, locale } = useI18n();
  const a = t.audit;
  const f = a.filters;

  /** Paramètres de l'URL pour les filtres actifs (sans la page), réutilisés par la pagination et l'export. */
  const query = (extra: Record<string, string> = {}) => {
    const sp = new URLSearchParams();
    for (const k of ["q", "user", "action", "entity", "from", "to"] as const) {
      const v = filters[k];
      if (v) sp.set(k, v);
    }
    for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  // date en UTC : le serveur et le navigateur affichent la même chose (pas d'écart d'hydratation)
  const when = (iso: string) =>
    new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const label = "mb-1 block text-xs font-medium text-fg2";
  const fieldLabels = a.fields as Record<string, string>;
  const shown = (v: Parameters<typeof changeValueText>[0]) => (v === null || v === "" ? <span className="italic text-muted">{a.changesUi.empty}</span> : changeValueText(v));
  const changesTable = (c: ChangeSet) => (
    <table className="mt-2 w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 pr-3 font-medium">{a.changesUi.field}</th>
          <th className="py-1 pr-3 font-medium">{a.changesUi.before}</th>
          <th className="py-1 font-medium">{a.changesUi.after}</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(c).map(([k, [from, to]]) => (
          <tr key={k} className="border-t border-line align-top">
            <td className="py-1 pr-3 text-fg2">{fieldLabels[k] ?? k}</td>
            <td className="break-all py-1 pr-3 font-mono text-bad">{shown(from)}</td>
            <td className="break-all py-1 font-mono text-ok">{shown(to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-4">
      <form method="get" action="/audit-logs" className="card grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6" aria-label={f.label}>
        <div className="xl:col-span-2">
          <label className={label} htmlFor="au-q">{f.q}</label>
          <input id="au-q" name="q" className="input" defaultValue={filters.q ?? ""} placeholder={f.qPlaceholder} />
        </div>
        <div>
          <label className={label} htmlFor="au-user">{f.user}</label>
          <select id="au-user" name="user" className="input" defaultValue={filters.user ?? ""}>
            <option value="">{f.allUsers}</option>
            {users.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="au-action">{f.action}</label>
          <select id="au-action" name="action" className="input" defaultValue={filters.action ?? ""}>
            <option value="">{f.allActions}</option>
            {AUDIT_ACTIONS.map((x) => (
              <option key={x} value={x}>{a.actions[x]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="au-entity">{f.entity}</label>
          <select id="au-entity" name="entity" className="input" defaultValue={filters.entity ?? ""}>
            <option value="">{f.allEntities}</option>
            {AUDIT_ENTITIES.map((x) => (
              <option key={x} value={x}>{a.entities[x]}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label} htmlFor="au-from">{f.from}</label>
            <input id="au-from" name="from" type="date" className="input px-2" defaultValue={filters.from ?? ""} />
          </div>
          <div>
            <label className={label} htmlFor="au-to">{f.to}</label>
            <input id="au-to" name="to" type="date" className="input px-2" defaultValue={filters.to ?? ""} />
          </div>
        </div>
        <div className="flex items-end gap-2 md:col-span-3 xl:col-span-6">
          <button type="submit" className="btn-primary">{f.apply}</button>
          <Link href="/audit-logs" className="btn-ghost">{f.reset}</Link>
          <a href={`/api/audit${query({ format: "csv" })}`} className="btn-ghost ml-auto">
            <Download className="h-4 w-4" />
            {a.exportCsv}
          </a>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{a.columns.at}</th>
              <th className="px-4 py-3 font-medium">{a.columns.user}</th>
              <th className="px-4 py-3 font-medium">{a.columns.action}</th>
              <th className="px-4 py-3 font-medium">{a.columns.entity}</th>
              <th className="px-4 py-3 font-medium">{a.columns.detail}</th>
              <th className="px-4 py-3 font-medium">{a.columns.project}</th>
              <th className="px-4 py-3 font-medium">{a.columns.ip}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted">{a.empty}</td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="hover:bg-panel2/60">
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">{when(r.at)}</td>
                <td className="px-4 py-2.5 text-fg">{r.username ?? a.noUser}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${ACTION_TONE[r.action] ?? "bg-panel2 text-fg2"}`}>{a.actions[r.action]}</span>
                </td>
                <td className="px-4 py-2.5 text-fg2">{a.entities[r.entity]}</td>
                <td className="max-w-md break-words px-4 py-2.5 text-fg2">
                  {r.detail ?? a.noUser}
                  {r.via && (
                    <span title={format(a.via, { prefix: r.via.replace(/^token:/, "") })} className="ml-2 rounded bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {a.changesUi.apiBadge}
                    </span>
                  )}
                  {r.changes && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-brand-soft">{format(a.changesUi.show, { n: Object.keys(r.changes).length })}</summary>
                      {changesTable(r.changes)}
                    </details>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{r.projectName ?? a.noUser}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">{r.ip ?? a.noUser}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>{format(a.total, { n: fmtInt(data.total, locale) })}</span>
        <span className="ml-auto">{format(a.pageOf, { page: data.page, pages: data.pages })}</span>
        {data.page > 1 ? (
          <Link className="btn-ghost h-8 px-3 text-xs" href={`/audit-logs${query({ page: String(data.page - 1) })}`}>{a.previous}</Link>
        ) : null}
        {data.page < data.pages ? (
          <Link className="btn-ghost h-8 px-3 text-xs" href={`/audit-logs${query({ page: String(data.page + 1) })}`}>{a.next}</Link>
        ) : null}
      </div>
      <p className="text-xs text-muted">{format(a.note, { days: retentionDays })}</p>
    </div>
  );
}
