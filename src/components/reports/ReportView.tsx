"use client";

import Link from "next/link";
import { Download, Printer } from "lucide-react";
import { REPORT_KINDS, type Report } from "@/lib/reportTypes";
import { displayCell } from "@/lib/reportFormat";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n";

interface Props {
  report: Report;
}

/** Colonnes alignées à droite : les nombres. */
const NUMERIC = new Set(["int", "pct"]);

export function ReportView({ report }: Props) {
  const { t, locale } = useI18n();
  const r = t.reports;
  const kindLabel = r.kinds[report.kind];
  // date du rapport en UTC : le serveur et le navigateur affichent la même chose
  const when = new Date(report.generatedAt).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  const hasPct = report.tables.some((tb) => tb.columns.some((c) => c.key === "occupancy"));

  return (
    <div className="space-y-6">
      <nav aria-label={r.tabsLabel} className="no-print flex flex-wrap items-center gap-2">
        {REPORT_KINDS.map((k) => (
          <Link
            key={k}
            href={`/rapports?type=${k}`}
            aria-current={k === report.kind ? "page" : undefined}
            className={
              k === report.kind
                ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2"
            }
          >
            {r.kinds[k]}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <a
            href={`/api/reports/${report.kind}?format=csv`}
            aria-label={format(r.exportLabel, { name: kindLabel })}
            className="btn-ghost h-8 px-3 text-xs"
          >
            <Download className="h-4 w-4" />
            {r.exportCsv}
          </a>
          <button type="button" onClick={() => window.print()} className="btn-primary h-8 px-3 text-xs">
            <Printer className="h-4 w-4" />
            {r.print}
          </button>
        </div>
      </nav>

      <div>
        <h2 className="text-lg font-semibold text-fg">{kindLabel}</h2>
        <p className="text-sm text-muted">{r.descriptions[report.kind]}</p>
        <p className="mt-1 text-xs text-muted">
          {report.organization ? `${report.organization} · ` : ""}{format(r.project, { name: report.project })} · {format(r.generated, { date: when })}
        </p>
      </div>

      {report.tables.map((table) => (
        <section key={table.id} className="card overflow-x-auto" aria-labelledby={`rt-${table.id}`}>
          <div className="border-b border-line px-5 py-4">
            <h3 id={`rt-${table.id}`} className="card-title">
              {(r.tables as Record<string, string>)[table.id] ?? table.id}
            </h3>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                {table.columns.map((c) => (
                  <th key={c.key} className={`px-4 py-3 font-medium ${NUMERIC.has(c.type) ? "text-right" : ""}`}>
                    {(r.columns as Record<string, string>)[c.key] ?? c.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {table.rows.length === 0 && (
                <tr>
                  <td colSpan={table.columns.length} className="px-4 py-10 text-center text-muted">
                    {r.empty}
                  </td>
                </tr>
              )}
              {table.rows.map((row, ri) => (
                <tr key={ri}>
                  {table.columns.map((c, ci) => {
                    const empty = row[ci] === null || row[ci] === "";
                    return (
                      <td
                        key={c.key}
                        className={`px-4 py-2.5 ${NUMERIC.has(c.type) ? "text-right tabular-nums" : ""} ${empty ? "text-muted" : "text-fg2"} ${ci === 0 ? "font-medium text-fg" : ""}`}
                      >
                        {displayCell(table, ci, row, t, locale)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {table.footer && table.rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line font-semibold text-fg">
                  {table.columns.map((c, ci) => (
                    <td key={c.key} className={`px-4 py-2.5 ${NUMERIC.has(c.type) ? "text-right tabular-nums" : ""}`}>
                      {ci === 0 ? r.total : table.footer![ci] === null ? "" : displayCell(table, ci, table.footer!, t, locale)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </section>
      ))}
      {hasPct && <p className="text-xs text-muted">{r.ipv4Note}</p>}
    </div>
  );
}
