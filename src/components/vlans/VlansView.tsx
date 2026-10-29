"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { Site, VlanRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { VlanForm } from "./VlanForm";

interface Props {
  vlans: VlanRow[];
  sites: Site[];
  filters: { q: string; site: string };
}

export function VlansView({ vlans, sites, filters }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const [q, setQ] = useState(filters.q);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VlanRow | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const navigate = (next: Partial<typeof filters>) => {
    const merged = { ...filters, q, ...next };
    const params = new URLSearchParams();
    if (merged.q.trim()) params.set("q", merged.q.trim());
    if (merged.site) params.set("site", merged.site);
    const qs = params.toString();
    router.replace(qs ? `/vlans?${qs}` : "/vlans");
  };

  const remove = async (v: VlanRow) => {
    if (!window.confirm(format(t.vlans.deleteConfirm, { number: v.number, name: v.name }))) return;
    setDeleting(v.id);
    setError(null);
    try {
      const res = await fetch(`/api/vlans/${v.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.vlans.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.vlans.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  const col = t.vlans.columns;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form
          className="relative min-w-[220px] flex-1 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            navigate({});
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.vlans.searchPlaceholder}
            aria-label={t.vlans.searchLabel}
            className="input pl-9"
          />
        </form>

        <select
          value={filters.site}
          onChange={(e) => navigate({ site: e.target.value })}
          aria-label={t.vlans.siteFilter}
          className="input w-auto"
        >
          <option value="">{t.vlans.allSites}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t.vlans.newVlan}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.vlan}</th>
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.site}</th>
              <th className="px-4 py-3 font-medium">{col.networks}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {vlans.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted">
                  {t.vlans.empty}
                </td>
              </tr>
            )}
            {vlans.map((v) => {
              const inUse = v.networkCount > 0;
              return (
                <tr key={v.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-3">
                    <span className="rounded bg-brand/15 px-2 py-0.5 font-mono text-[13px] font-semibold text-brand-soft">
                      {v.number}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg2">{v.name}</td>
                  <td className="px-4 py-3 text-muted">{v.siteName ?? t.vlans.global}</td>
                  <td className="px-4 py-3 text-muted">{format(t.vlans.networksCount, { n: v.networkCount })}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(v)}
                      aria-label={format(t.vlans.editLabel, { number: v.number })}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => remove(v)}
                      disabled={deleting === v.id || inUse}
                      aria-label={format(t.vlans.deleteLabel, { number: v.number })}
                      title={inUse ? format(t.errors.vlanInUse, { n: v.networkCount }) : undefined}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">{format(t.vlans.shown, { n: vlans.length })}</p>

      {editing && <VlanForm key={editing.id} sites={sites} vlan={editing} onClose={() => setEditing(null)} onCreated={() => router.refresh()} />}
      {open && <VlanForm sites={sites} onClose={() => setOpen(false)} onCreated={() => router.refresh()} />}
    </>
  );
}
