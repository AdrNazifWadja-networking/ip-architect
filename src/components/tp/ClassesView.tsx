"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { TP_CLASS_NAME_MAX, type TpClassMember, type TpClassRow } from "@/lib/tp/types";

interface Props {
  classes: TpClassRow[];
  students: TpClassMember[];
}

export function ClassesView({ classes, students }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const k = t.tp.classes;
  const [editing, setEditing] = useState<TpClassRow | "new" | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? students.filter((s) => s.username.includes(q) || s.displayName.toLowerCase().includes(q)) : students;
  }, [students, filter]);

  const open = (c: TpClassRow | "new") => {
    setEditing(c);
    setName(c === "new" ? "" : c.name);
    setPicked(new Set(c === "new" ? [] : c.members.map((m) => m.id)));
    setFilter("");
    setPaste("");
    setError(null);
    setNotice(null);
  };

  const call = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; unknown?: string[] };
    if (!res.ok) throw new Error(data.error ?? k.failed);
    return data;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, userIds: [...picked], ...(paste.trim() ? { usernames: paste } : {}) };
      const data = editing === "new" ? await call("/api/tp/classes", "POST", body) : await call(`/api/tp/classes/${(editing as TpClassRow).id}`, "PATCH", body);
      if (data.unknown && data.unknown.length > 0) {
        // la classe est enregistrée ; on signale les identifiants qui n'ont pas pu être inscrits
        setNotice(format(k.unknown, { list: data.unknown.join(", ") }));
        setEditing(null);
      } else setEditing(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : k.failed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: TpClassRow) => {
    if (!window.confirm(format(k.confirmDelete, { name: c.name }))) return;
    setError(null);
    try {
      await call(`/api/tp/classes/${c.id}`, "DELETE");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : k.failed);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/tp" className="text-sm text-brand-soft hover:underline">← {t.tp.title}</Link>
        <button type="button" className="btn-primary" onClick={() => open("new")}>
          <Plus className="h-4 w-4" />
          {k.newClass}
        </button>
      </div>
      <p className="max-w-3xl text-sm text-fg2">{k.intro}</p>
      {notice && <div role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg2">{notice}</div>}
      {error && !editing && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}

      {classes.length === 0 ? (
        <div className="card px-6 py-10 text-center text-sm text-muted" role="status">{k.empty}</div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {classes.map((c) => (
            <li key={c.id} className="card space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-fg">{c.name}</div>
                  <div className="text-xs text-muted">{format(k.counts, { students: c.members.length, exercises: c.exerciseCount })}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className="btn-ghost" aria-label={format(k.editLabel, { name: c.name })} onClick={() => open(c)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" className="btn-ghost" aria-label={format(k.deleteLabel, { name: c.name })} onClick={() => remove(c)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="line-clamp-3 text-xs text-fg2">{c.members.map((m) => m.username).join(", ") || k.noMembers}</p>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form onSubmit={save} className="card space-y-4 p-5" aria-label={editing === "new" ? k.newClass : k.editTitle}>
          <h2 className="text-sm font-semibold text-fg">{editing === "new" ? k.newClass : k.editTitle}</h2>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="cl-name">{k.name}</label>
            <input id="cl-name" className="input" required autoFocus maxLength={TP_CLASS_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="label-caps">{format(k.members, { n: picked.size })}</span>
              <input className="input w-56" aria-label={k.filter} placeholder={k.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {students.length === 0 ? (
              <p className="text-sm text-muted">{k.noStudents}</p>
            ) : (
              <>
                <div className="mb-2 flex gap-3 text-xs">
                  <button type="button" className="text-brand-soft hover:underline" onClick={() => setPicked(new Set([...picked, ...shown.map((s) => s.id)]))}>{k.selectShown}</button>
                  <button type="button" className="text-brand-soft hover:underline" onClick={() => setPicked(new Set([...picked].filter((id) => !shown.some((s) => s.id === id))))}>{k.unselectShown}</button>
                </div>
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line bg-panel2 p-2">
                  {shown.map((s) => (
                    <li key={s.id}>
                      <label className="flex items-center gap-2 text-sm text-fg2">
                        <input
                          type="checkbox"
                          checked={picked.has(s.id)}
                          onChange={(e) => {
                            const n = new Set(picked);
                            if (e.target.checked) n.add(s.id);
                            else n.delete(s.id);
                            setPicked(n);
                          }}
                        />
                        <span className="font-mono text-[13px] text-fg">{s.username}</span>
                        <span className="truncate text-muted">{s.displayName}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="cl-paste">{k.paste}</label>
            <textarea id="cl-paste" className="input min-h-[64px] font-mono" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="alice, bernard, camille" />
            <p className="mt-1 text-[11px] text-muted">{k.pasteHint}</p>
          </div>
          {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>{k.cancel}</button>
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? k.saving : k.save}</button>
          </div>
        </form>
      )}
    </div>
  );
}
