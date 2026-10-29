"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Download } from "lucide-react";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { TpStudentDetail, TpTeacherDetail } from "@/lib/tp/types";
import { TpForm } from "./TpForm";
import { TpStudentPanel } from "./TpStudentPanel";
import { statusOf } from "./TpListView";

interface Props {
  teacher: TpTeacherDetail;
  /** L'exercice vu comme un étudiant (aperçu). */
  preview: TpStudentDetail;
  classes: { id: number; name: string }[];
}

export function TpTeacherView({ teacher, preview, classes }: Props) {
  const router = useRouter();
  const [dupBusy, setDupBusy] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  const { t, locale } = useI18n();
  const k = t.tp;
  const ex = teacher.exercise;
  const vlsm = teacher.statement.vlsm;
  const closed = ex.dueAt !== null && Date.now() > Date.parse(ex.dueAt);
  const st = statusOf({ published: ex.published, closed });
  const when = (iso: string) => new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  const c = k.results.columns;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3 text-sm text-fg2">
        <Link href="/tp" className="text-brand-soft hover:underline">← {k.title}</Link>
        <span className="rounded bg-panel2 px-2 py-0.5 text-xs font-medium text-fg">{k.status[st]}</span>
        <span>{k.form.maxAttempts} : {ex.maxAttempts}</span>
        {ex.dueAt && <span>{format(k.student.dueOn, { date: when(ex.dueAt) })}</span>}
        <span>{k.form.class} : {ex.className ?? k.form.classAll}</span>
        <button
          type="button"
          disabled={dupBusy}
          className="btn-ghost"
          onClick={async () => {
            setDupBusy(true);
            setDupError(null);
            try {
              const res = await fetch(`/api/tp/${ex.id}/duplicate`, { method: "POST" });
              const data = (await res.json().catch(() => ({}))) as { error?: string; exercise?: { id: number } };
              if (!res.ok || !data.exercise) throw new Error(data.error ?? k.teacher.duplicateFailed);
              router.push(`/tp/${data.exercise.id}`);
            } catch (e) {
              setDupError(e instanceof Error ? e.message : k.teacher.duplicateFailed);
              setDupBusy(false);
            }
          }}
        >
          <Copy className="h-4 w-4" />
          {k.teacher.duplicate}
        </button>
      </div>
      {dupError && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{dupError}</div>
      )}

      {vlsm && (
        <section aria-labelledby="tp-sol" className="space-y-2">
          <h2 id="tp-sol" className="card-title">{k.teacher.solution}</h2>
          <p className="font-mono text-sm text-fg">{format(k.student.parent, { parent: vlsm.parent })}</p>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-panel2 text-fg">
                <tr>
                  <th className="px-3 py-2 font-semibold">{k.form.needName}</th>
                  <th className="px-3 py-2 font-semibold">{k.student.hostsHeader}</th>
                  <th className="px-3 py-2 font-semibold">{k.student.networkHeader}</th>
                </tr>
              </thead>
              <tbody>
                {vlsm.needs.map((n, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-2 text-fg">{n.name}</td>
                    <td className="px-3 py-2">{n.hosts}</td>
                    <td className="px-3 py-2 font-mono">{teacher.solution?.[i] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">{k.teacher.solutionNote}</p>
        </section>
      )}

      <section aria-labelledby="tp-res" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="tp-res" className="card-title">{k.results.title}</h2>
          <a href={`/api/tp/${ex.id}/results?format=csv`} className="btn-ghost" download>
            <Download className="h-4 w-4" />
            {k.results.exportCsv}
          </a>
        </div>
        {teacher.results.length === 0 ? (
          <div className="card px-6 py-8 text-center text-sm text-muted" role="status">{k.results.empty}</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-panel2 text-fg">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">{c.student}</th>
                  <th className="px-4 py-2.5 font-semibold">{c.attempts}</th>
                  <th className="px-4 py-2.5 font-semibold">{c.best}</th>
                  <th className="px-4 py-2.5 font-semibold">{c.last}</th>
                  <th className="px-4 py-2.5 font-semibold">{c.lastAt}</th>
                </tr>
              </thead>
              <tbody>
                {teacher.results.map((r) => (
                  <tr key={`${r.userId ?? "x"}-${r.username}`} className="border-t border-line">
                    <td className="px-4 py-2.5 font-medium text-fg">{r.username}</td>
                    <td className="px-4 py-2.5">{r.attempts}/{ex.maxAttempts}</td>
                    <td className="px-4 py-2.5">{r.best}/100</td>
                    <td className="px-4 py-2.5">{r.last}/100</td>
                    <td className="px-4 py-2.5 text-fg2">{when(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">{k.results.note}</p>
      </section>

      <TpForm exercise={ex} locked={teacher.results.length > 0} classes={classes} />

      <details className="card p-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg">{k.teacher.preview}</summary>
        <p className="mb-4 mt-2 text-xs text-muted">{k.teacher.previewNote}</p>
        <TpStudentPanel detail={preview} />
      </details>
    </div>
  );
}
