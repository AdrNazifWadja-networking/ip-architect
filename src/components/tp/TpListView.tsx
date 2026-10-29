"use client";

import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { TpListItem } from "@/lib/tp/types";

interface Props {
  items: TpListItem[];
  canManage: boolean;
  openMode: boolean;
}

const TONE = { draft: "bg-panel2 text-muted", published: "bg-ok/15 text-ok", closed: "bg-warn/15 text-warn" } as const;

export function statusOf(i: { published: boolean; closed: boolean }): keyof typeof TONE {
  return !i.published ? "draft" : i.closed ? "closed" : "published";
}

export function TpListView({ items, canManage, openMode }: Props) {
  const { t, locale } = useI18n();
  const k = t.tp;
  const c = k.list.columns;
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) : k.list.noDue);

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-fg2">{k.intro}</p>
      {openMode && (
        <div className="card border-warn/40 bg-warn/10 p-3 text-sm text-fg2" role="status">
          {k.openMode}
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/tp/nouveau" className="btn-primary">
            <Plus className="h-4 w-4" />
            {k.list.newExercise}
          </Link>
          <Link href="/tp/classes" className="btn-ghost">
            <Users className="h-4 w-4" />
            {k.list.manageClasses}
          </Link>
          <span className="text-xs text-muted">{k.signupHint}</span>
        </div>
      )}
      {items.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-muted" role="status">
          {canManage ? k.list.empty : k.list.emptyStudent}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-panel2 text-fg">
              <tr>
                <th className="px-4 py-2.5 font-semibold">{c.title}</th>
                <th className="px-4 py-2.5 font-semibold">{c.kind}</th>
                <th className="px-4 py-2.5 font-semibold">{c.class}</th>
                <th className="px-4 py-2.5 font-semibold">{c.status}</th>
                <th className="px-4 py-2.5 font-semibold">{c.due}</th>
                <th className="px-4 py-2.5 font-semibold">{c.attempts}</th>
                <th className="px-4 py-2.5 font-semibold">{c.best}</th>
                {canManage && <th className="px-4 py-2.5 font-semibold">{c.students}</th>}
                {canManage && <th className="px-4 py-2.5 font-semibold">{c.submissions}</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const st = statusOf(i);
                return (
                  <tr key={i.id} className="border-t border-line">
                    <td className="px-4 py-2.5 font-medium">
                      <Link href={`/tp/${i.id}`} className="text-brand-soft hover:underline">
                        {i.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-fg2">{k.kinds[i.kind]}</td>
                    <td className="px-4 py-2.5 text-fg2">{i.className ?? k.form.classAll}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE[st]}`}>{k.status[st]}</span>
                    </td>
                    <td className="px-4 py-2.5 text-fg2">{day(i.dueAt)}</td>
                    <td className="px-4 py-2.5 text-fg2">
                      {i.attemptsUsed}/{i.maxAttempts}
                    </td>
                    <td className="px-4 py-2.5 text-fg2">{i.best === null ? "—" : `${i.best}/100`}</td>
                    {canManage && <td className="px-4 py-2.5 text-fg2">{i.students}</td>}
                    {canManage && <td className="px-4 py-2.5 text-fg2">{i.submissions}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
