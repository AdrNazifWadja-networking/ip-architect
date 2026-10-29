"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import {
  DEFAULT_SUBNET_FIELDS,
  SUBNET_FIELDS,
  TP_DEFAULT_ATTEMPTS,
  TP_DEFAULT_QUESTIONS,
  TP_DESCRIPTION_MAX,
  TP_MAX_ATTEMPTS,
  TP_MAX_NEEDS,
  TP_MAX_QUESTIONS,
  TP_NEED_NAME_MAX,
  TP_TITLE_MAX,
  TP_KINDS,
  type SubnetConfig,
  type SubnetField,
  type TpExerciseRow,
  type TpKind,
  type VlsmConfig,
} from "@/lib/tp/types";

interface Props {
  /** Absent = création. */
  exercise?: TpExerciseRow;
  /** Des remises existent : l'énoncé est figé. */
  locked?: boolean;
  /** Classes disponibles (réservation de l'exercice). */
  classes: { id: number; name: string }[];
}

/** ISO UTC -> valeur d'un champ datetime-local (heure du navigateur). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TpForm({ exercise, locked = false, classes }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const k = t.tp;
  const f = k.form;
  const editing = exercise !== undefined;
  const vlsm0 = exercise?.kind === "vlsm" ? (exercise.config as VlsmConfig) : null;
  const sub0 = exercise?.kind === "subnet" ? (exercise.config as SubnetConfig) : null;

  const [title, setTitle] = useState(exercise?.title ?? "");
  const [description, setDescription] = useState(exercise?.description ?? "");
  const [kind, setKind] = useState<TpKind>(exercise?.kind ?? "vlsm");
  const [parent, setParent] = useState(vlsm0?.parent ?? "");
  const [needs, setNeeds] = useState<{ name: string; hosts: string }[]>(
    vlsm0 ? vlsm0.needs.map((n) => ({ name: n.name, hosts: String(n.hosts) })) : [{ name: "", hosts: "" }],
  );
  const [count, setCount] = useState(String(sub0?.count ?? TP_DEFAULT_QUESTIONS));
  const [fields, setFields] = useState<SubnetField[]>(sub0?.fields ?? DEFAULT_SUBNET_FIELDS);
  const [maxAttempts, setMaxAttempts] = useState(String(exercise?.maxAttempts ?? TP_DEFAULT_ATTEMPTS));
  const [due, setDue] = useState(toLocalInput(exercise?.dueAt ?? null));
  const [published, setPublished] = useState(exercise?.published ?? false);
  const [showSolution, setShowSolution] = useState(exercise?.showSolution ?? false);
  const [classId, setClassId] = useState(exercise?.classId === null || exercise?.classId === undefined ? "" : String(exercise.classId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const body = () => {
    const common = {
      title,
      description,
      maxAttempts: Number(maxAttempts),
      dueAt: due ? new Date(due).toISOString() : null,
      published,
      showSolution,
      classId: classId === "" ? null : Number(classId),
    };
    if (locked) return common;
    const config =
      kind === "vlsm"
        ? { parent: parent.trim(), needs: needs.map((n) => ({ name: n.name, hosts: Number(n.hosts) })) }
        : { count: Number(count), fields };
    return editing ? { ...common, config } : { ...common, kind, config };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(editing ? `/api/tp/${exercise.id}` : "/api/tp", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      const data = (await res.json().catch(() => ({}))) as { exercise?: { id: number }; error?: string };
      if (!res.ok || !data.exercise) throw new Error(data.error ?? t.errors.internal);
      if (editing) {
        setSaved(true);
        router.refresh();
      } else {
        router.push(`/tp/${data.exercise.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!exercise || !window.confirm(format(f.confirmDelete, { title: exercise.title }))) return;
    setError(null);
    try {
      const res = await fetch(`/api/tp/${exercise.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.errors.internal);
      }
      router.push("/tp");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    }
  };

  const toggleField = (name: SubnetField) => setFields((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  const label = "mb-1 block text-xs font-medium text-fg2";

  return (
    <form onSubmit={submit} className="card max-w-3xl space-y-5 p-5" aria-label={editing ? f.editTitle : f.createTitle}>
      {editing && <h2 className="card-title">{f.editTitle}</h2>}

      <div>
        <label className={label} htmlFor="tp-title">{f.title}</label>
        <input id="tp-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TP_TITLE_MAX} placeholder={f.titlePlaceholder} required />
      </div>
      <div>
        <label className={label} htmlFor="tp-desc">{f.description}</label>
        <textarea id="tp-desc" className="input h-24 py-2" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={TP_DESCRIPTION_MAX} />
      </div>

      {!editing && (
        <fieldset>
          <legend className={label}>{f.kind}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TP_KINDS.map((x) => (
              <label key={x} className={`cursor-pointer rounded-md border p-3 text-sm ${kind === x ? "border-brand bg-brand/10" : "border-line bg-panel"}`}>
                <input type="radio" name="tp-kind" className="mr-2" checked={kind === x} onChange={() => setKind(x)} />
                <span className="font-medium text-fg">{k.kinds[x]}</span>
                <span className="mt-1 block text-xs text-muted">{k.kindHelp[x]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {locked ? (
        <p className="rounded-md border border-line bg-panel2 p-3 text-sm text-fg2" role="note">{f.configLocked}</p>
      ) : kind === "vlsm" ? (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="tp-parent">{f.parent}</label>
            <input id="tp-parent" className="input max-w-xs font-mono" value={parent} onChange={(e) => setParent(e.target.value)} placeholder={f.parentPlaceholder} required />
          </div>
          <fieldset>
            <legend className={label}>{f.needs}</legend>
            <div className="space-y-2">
              {needs.map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input aria-label={`${f.needName} ${i + 1}`} className="input" value={n.name} maxLength={TP_NEED_NAME_MAX} placeholder={f.needName} onChange={(e) => setNeeds((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} required />
                  <input aria-label={`${f.needHosts} ${i + 1}`} className="input w-28" type="number" min={1} max={65534} value={n.hosts} placeholder={f.needHosts} onChange={(e) => setNeeds((cur) => cur.map((x, j) => (j === i ? { ...x, hosts: e.target.value } : x)))} required />
                  <button type="button" className="rounded p-2 text-muted hover:text-bad disabled:opacity-40" disabled={needs.length <= 1} aria-label={format(f.removeNeed, { n: i + 1 })} onClick={() => setNeeds((cur) => cur.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost mt-2" disabled={needs.length >= TP_MAX_NEEDS} onClick={() => setNeeds((cur) => [...cur, { name: "", hosts: "" }])}>
              <Plus className="h-4 w-4" />
              {f.addNeed}
            </button>
          </fieldset>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="tp-count">{f.questionCount}</label>
            <input id="tp-count" className="input w-28" type="number" min={1} max={TP_MAX_QUESTIONS} value={count} onChange={(e) => setCount(e.target.value)} required />
          </div>
          <fieldset>
            <legend className={label}>{f.fields}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {SUBNET_FIELDS.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm text-fg2">
                  <input type="checkbox" checked={fields.includes(name)} onChange={() => toggleField(name)} />
                  {k.fields[name]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="tp-class">{f.class}</label>
          <select id="tp-class" className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">{f.classAll}</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">{f.classHelp}</p>
        </div>
        <div>
          <label className={label} htmlFor="tp-attempts">{f.maxAttempts}</label>
          <input id="tp-attempts" className="input w-28" type="number" min={1} max={TP_MAX_ATTEMPTS} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} required />
        </div>
        <div>
          <label className={label} htmlFor="tp-due">{f.due}</label>
          <input id="tp-due" className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          <p className="mt-1 text-xs text-muted">{f.dueHelp}</p>
        </div>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-fg2">
          <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
          {f.published}
        </label>
        <label className="flex items-center gap-2 text-sm text-fg2">
          <input type="checkbox" checked={showSolution} onChange={(e) => setShowSolution(e.target.checked)} />
          {f.showSolution}
        </label>
      </div>

      {error && <p className="rounded-md border border-bad/40 bg-bad/10 p-3 text-sm text-bad" role="alert">{error}</p>}
      {saved && <p className="text-sm text-ok" role="status">{f.saved}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {editing ? (busy ? f.saving : f.save) : busy ? f.creating : f.create}
        </button>
        {editing && (
          <button type="button" className="btn-ghost text-bad" onClick={remove}>
            <Trash2 className="h-4 w-4" />
            {f.delete}
          </button>
        )}
      </div>
    </form>
  );
}
