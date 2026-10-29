"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { SiteRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtPct } from "@/lib/format";
import { SiteForm } from "./SiteForm";

interface Props {
  sites: SiteRow[];
  q: string;
}

export function SitesView({ sites, q }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SiteRow | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = t.sites;
  const col = s.columns;

  const remove = async (site: SiteRow) => {
    if (!window.confirm(format(s.deleteConfirm, { name: site.name }))) return;
    setDeleting(site.id);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${site.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? s.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : s.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Formulaire GET classique : fonctionne sans JavaScript */}
        <form action="/sites" method="get" role="search" className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input name="q" defaultValue={q} placeholder={s.searchPlaceholder} aria-label={s.searchLabel} className="input pl-9" />
        </form>
        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {s.newSite}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.address}</th>
              <th className="px-4 py-3 font-medium">{col.networks}</th>
              <th className="px-4 py-3 font-medium">{col.vlans}</th>
              <th className="px-4 py-3 font-medium">{col.usage}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sites.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted">
                  {q ? s.empty : s.emptyFirst}
                </td>
              </tr>
            )}
            {sites.map((site) => {
              const pct = site.ipv4UsagePct;
              const bar = pct === null ? "" : pct >= 85 ? "bg-bad" : pct >= 65 ? "bg-warn" : "bg-ok";
              const inUse = site.networkCount + site.vlanCount > 0;
              return (
                <tr key={site.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-fg">{site.name}</div>
                    {site.description && <div className="text-xs text-muted">{site.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-fg2">{site.address ?? <span className="text-muted">{s.noAddress}</span>}</td>
                  <td className="px-4 py-3 text-fg2">{format(s.networksCount, { n: site.networkCount })}</td>
                  <td className="px-4 py-3 text-fg2">{format(s.vlansCount, { n: site.vlanCount })}</td>
                  <td className="px-4 py-3">
                    {pct === null ? (
                      <span className="text-xs text-muted">{s.noUsage}</span>
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
                        href={`/reseaux?site=${site.id}`}
                        aria-label={format(s.viewNetworksLabel, { name: site.name })}
                        className="btn-ghost h-8 px-3 text-xs"
                      >
                        {s.viewNetworks}
                      </Link>
                      <button
                        onClick={() => setEditing(site)}
                        aria-label={format(s.editLabel, { name: site.name })}
                        className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => remove(site)}
                        disabled={deleting === site.id || inUse}
                        aria-label={format(s.deleteLabel, { name: site.name })}
                        title={inUse ? format(t.errors.siteInUse, { networks: site.networkCount, vlans: site.vlanCount }) : undefined}
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
      <p className="mt-3 text-xs text-muted">{format(s.shown, { n: sites.length })}</p>

      {editing && <SiteForm key={editing.id} site={editing} onClose={() => setEditing(null)} onDone={() => router.refresh()} />}
      {open && <SiteForm onClose={() => setOpen(false)} onDone={() => router.refresh()} />}
    </>
  );
}
