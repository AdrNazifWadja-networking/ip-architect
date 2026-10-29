"use client";

import { useState } from "react";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { GradeItem, GradeResult, SubnetField, TpAnswers, TpStudentDetail, TpSubmissionView } from "@/lib/tp/types";

interface Props {
  detail: TpStudentDetail;
}

interface Outcome {
  attempt: number;
  score: number;
  result: GradeResult;
  attemptsLeft: number;
  best: number;
  revealed: boolean;
  solution: string[] | null;
}

type Answers = Record<string, string | Record<string, string>>;

function feedback(t: Dictionary, item: GradeItem): string {
  return format(t.tp.feedback[item.code], (item.params ?? {}) as Record<string, string | number>);
}

export function ResultTable({ result }: { result: GradeResult }) {
  const { t } = useI18n();
  const s = t.tp.student;
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-panel2 text-fg">
          <tr>
            <th className="px-3 py-2 font-semibold">{s.item}</th>
            <th className="px-3 py-2 font-semibold">{s.points}</th>
            <th className="px-3 py-2 font-semibold">{s.comment}</th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((it) => (
            <tr key={`${it.key}-${it.field ?? ""}`} className="border-t border-line align-top">
              <td className="px-3 py-2 text-fg">
                {it.label}
                {it.field && <span className="block text-xs text-muted">{t.tp.fields[it.field].replace(/ \(.*\)$/, "")}</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {Math.round(it.points * 10) / 10} / {Math.round(it.max * 10) / 10}
              </td>
              <td className={`px-3 py-2 ${it.code === "ok" ? "text-ok" : it.code === "oversized" ? "text-warn" : "text-bad"}`}>
                {feedback(t, it)}
                {it.expected && it.code !== "ok" && <span className="mt-0.5 block font-mono text-xs text-fg2">{format(s.expected, { value: it.expected })}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function initialAnswers(detail: TpStudentDetail): Answers {
  const last = detail.submissions[detail.submissions.length - 1];
  return last ? ({ ...(last.answers as Answers) } as Answers) : {};
}

export function TpStudentPanel({ detail }: Props) {
  const { t, locale } = useI18n();
  const s = t.tp.student;
  const ex = detail.exercise;
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(detail));
  const [subs, setSubs] = useState<TpSubmissionView[]>(detail.submissions);
  const [attemptsLeft, setAttemptsLeft] = useState(detail.attemptsLeft);
  const [best, setBest] = useState<number | null>(detail.best);
  const [solution, setSolution] = useState<string[] | null>(detail.solution);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const when = (iso: string) => new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  const canSubmit = attemptsLeft > 0 && !detail.closed;
  const last = subs[subs.length - 1];

  const setVlsm = (i: number, v: string) => setAnswers((cur) => ({ ...cur, [String(i)]: v }));
  const setSub = (q: string, f: SubnetField, v: string) =>
    setAnswers((cur) => ({ ...cur, [q]: { ...((cur[q] as Record<string, string> | undefined) ?? {}), [f]: v } }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tp/${ex.id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }) });
      const data = (await res.json().catch(() => ({}))) as Partial<Outcome> & { error?: string };
      if (!res.ok || data.result === undefined || data.attempt === undefined) throw new Error(data.error ?? t.errors.internal);
      setSubs((cur) => [...cur, { attempt: data.attempt!, score: data.score!, submittedAt: new Date().toISOString(), answers: answers as TpAnswers, result: data.result! }]);
      setAttemptsLeft(data.attemptsLeft ?? 0);
      setBest(data.best ?? null);
      setSolution(data.solution ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    } finally {
      setBusy(false);
    }
  };

  const input = "input font-mono";
  const vlsm = detail.statement.vlsm;

  return (
    <div className="space-y-6">
      {ex.description && <p className="max-w-3xl whitespace-pre-line text-sm text-fg2">{ex.description}</p>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-fg2" role="status">
        {ex.dueAt && <span>{format(s.dueOn, { date: when(ex.dueAt) })}</span>}
        <span>{format(s.attemptsLeft, { n: attemptsLeft, max: ex.maxAttempts })}</span>
        {best !== null && <span className="font-medium text-fg">{format(s.bestScore, { score: best })}</span>}
      </div>
      {detail.closed && <p className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm text-fg2">{s.closed}</p>}
      {!detail.closed && attemptsLeft === 0 && <p className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm text-fg2">{s.noAttempts}</p>}

      <form onSubmit={submit} className="card space-y-4 p-5" aria-label={ex.title}>
        {vlsm ? (
          <>
            <p className="text-sm text-fg2">{s.statementVlsm}</p>
            <p className="font-mono text-sm font-semibold text-fg">{format(s.parent, { parent: vlsm.parent })}</p>
            <div className="space-y-2">
              {vlsm.needs.map((n, i) => (
                <div key={i} className="grid items-center gap-2 sm:grid-cols-[1fr_220px]">
                  <label htmlFor={`need-${i}`} className="text-sm text-fg">{format(s.needLine, { name: n.name, hosts: n.hosts })}</label>
                  <input id={`need-${i}`} className={input} placeholder="10.20.30.64/26" autoComplete="off" spellCheck={false} disabled={!canSubmit} value={(answers[String(i)] as string | undefined) ?? ""} onChange={(e) => setVlsm(i, e.target.value)} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg2">{s.statementSubnet}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {(detail.statement.questions ?? []).map((q, n) => (
                <fieldset key={q.key} className="rounded-md border border-line p-3">
                  <legend className="px-1 text-xs text-muted">{format(s.question, { n: n + 1 })}</legend>
                  <p className="mb-2 font-mono text-base font-semibold text-fg">{q.cidr}</p>
                  <div className="space-y-2">
                    {(detail.statement.fields ?? []).map((f) => (
                      <div key={f}>
                        <label htmlFor={`${q.key}-${f}`} className="mb-0.5 block text-xs text-fg2">{t.tp.fields[f]}</label>
                        <input id={`${q.key}-${f}`} className={input} autoComplete="off" spellCheck={false} disabled={!canSubmit} value={((answers[q.key] as Record<string, string> | undefined) ?? {})[f] ?? ""} onChange={(e) => setSub(q.key, f, e.target.value)} />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </>
        )}
        {error && <p className="rounded-md border border-bad/40 bg-bad/10 p-3 text-sm text-bad" role="alert">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy || !canSubmit}>
          {busy ? s.submitting : s.submit}
        </button>
      </form>

      {last && (
        <section aria-labelledby="tp-last" className="space-y-2">
          <h2 id="tp-last" className="card-title">{format(s.lastResult, { n: last.attempt })}</h2>
          <p className="text-lg font-semibold text-fg">{format(s.score, { score: last.score })}</p>
          <ResultTable result={last.result} />
        </section>
      )}

      {solution && (
        <section aria-labelledby="tp-sol" className="space-y-2">
          <h2 id="tp-sol" className="card-title">{s.solutionTitle}</h2>
          <ul className="font-mono text-sm text-fg">
            {vlsm?.needs.map((n, i) => (
              <li key={i}>
                {n.name} : {solution[i]}
              </li>
            ))}
          </ul>
        </section>
      )}

      {subs.length > 1 && (
        <section aria-labelledby="tp-hist" className="space-y-1">
          <h2 id="tp-hist" className="card-title">{s.history}</h2>
          <ul className="text-sm text-fg2">
            {subs.slice(0, -1).map((x) => (
              <li key={x.attempt}>{format(s.attemptLine, { n: x.attempt, score: x.score, date: when(x.submittedAt) })}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
