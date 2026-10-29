"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { VrfRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtPct } from "@/lib/format";
import { VrfForm } from "./VrfForm";

interface Props {
  vrfs: VrfRow[];
  globalCount: number;
  q: string;
}

export function VrfView({ vrfs, globalCount, q }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VrfRow | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const col = t.vrf.columns;

  const remove = async (v: VrfRow) => {
    if (!window.confirm(format(t.vrf.deleteConfirm, { name: v.name }))) return;
    setDeleting(v.id);
    setError(null);
    try {
      const res = await fetch(`/api/vrfs/${v.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.vrf.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.vrf.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Formulaire GET classique : fonctionne sans JavaScript */}
        <form action="/vrf" method="get" role="search" className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t.vrf.searchPlaceholder}
            aria-label={t.vrf.searchLabel}
            className="input pl-9"
          />
        </form>
        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t.vrf.newVrf}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.rd}</th>
              <th className="px-4 py-3 font-medium">{col.targets}</th>
              <th className="px-4 py-3 font-medium">{col.networks}</th>
              <th className="px-4 py-3 font-medium">{col.usage}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {vrfs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted">
                  {t.vrf.empty}
                </td>
              </tr>
            )}
            {vrfs.map((v) => {
              const pct = v.ipv4UsagePct;
              const bar = pct === null ? "" : pct >= 85 ? "bg-bad" : pct >= 65 ? "bg-warn" : "bg-ok";
              return (
                <tr key={v.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-3">
                    <Link href={`/vrf/${v.id}`} className="font-mono font-semibold text-fg hover:text-brand-soft">
                      {v.name}
                    </Link>
                    {v.description && <div className="text-xs text-muted">{v.description}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-[13px] text-fg2">
                    {v.rd ?? <span className="font-sans text-xs text-muted">{t.vrf.noRd}</span>}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {format(t.vrf.targetsCount, { imp: v.rtImport.length, exp: v.rtExport.length })}
                  </td>
                  <td className="px-4 py-3 text-fg2">{format(t.vrf.networksCount, { n: v.networkCount })}</td>
                  <td className="px-4 py-3">
                    {pct === null ? (
                      <span className="text-xs text-muted">{t.vrf.noUsage}</span>
                    ) : (
                      <div className="w-36">
                        <div className="mb-1 text-right text-xs text-fg2">{fmtPct(pct, locale, 0)}</div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-line">
                          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/vrf/${v.id}`}
                        aria-label={format(t.vrf.manageLabel, { name: v.name })}
                        className="btn-ghost h-8 px-3 text-xs"
                      >
                        {t.vrf.manage}
                      </Link>
                      <button
                        onClick={() => setEditing(v)}
                        aria-label={format(t.vrf.editLabel, { name: v.name })}
                        className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => remove(v)}
                        disabled={deleting === v.id || v.networkCount > 0}
                        aria-label={format(t.vrf.deleteLabel, { name: v.name })}
                        title={v.networkCount > 0 ? format(t.errors.vrfInUse, { n: v.networkCount }) : undefined}
                        className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">{format(t.vrf.shown, { n: vrfs.length })}</p>
      <p className="mt-1 text-xs text-muted">{format(t.vrf.globalNote, { n: globalCount })}</p>

      {editing && <VrfForm key={editing.id} vrf={editing} onClose={() => setEditing(null)} onCreated={() => router.refresh()} />}
      {open && <VrfForm onClose={() => setOpen(false)} onCreated={(id) => router.push(`/vrf/${id}`)} />}
    </>
  );
}
