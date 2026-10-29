"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { DhcpScopeRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt } from "@/lib/format";
import { formatLease } from "@/lib/dhcp/lease";
import { ScopeForm, type NetworkOption } from "./ScopeForm";

interface Props {
  scopes: DhcpScopeRow[];
  networks: NetworkOption[];
  q: string;
  preselectedNetwork: number | null;
}

export function DhcpScopes({ scopes, networks, q, preselectedNetwork }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(preselectedNetwork !== null);
  const [editing, setEditing] = useState<DhcpScopeRow | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const col = t.dhcp.columns;

  const remove = async (s: DhcpScopeRow) => {
    if (!window.confirm(format(t.dhcp.deleteConfirm, { name: s.name }))) return;
    setDeleting(s.id);
    setError(null);
    try {
      const res = await fetch(`/api/dhcp/scopes/${s.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.dhcp.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.dhcp.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Formulaire GET classique : fonctionne sans JavaScript */}
        <form action="/dhcp" method="get" role="search" className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t.dhcp.searchPlaceholder}
            aria-label={t.dhcp.searchLabel}
            className="input pl-9"
          />
        </form>
        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t.dhcp.newScope}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.scope}</th>
              <th className="px-4 py-3 font-medium">{col.network}</th>
              <th className="px-4 py-3 font-medium">{col.range}</th>
              <th className="px-4 py-3 font-medium">{col.lease}</th>
              <th className="px-4 py-3 font-medium">{col.pool}</th>
              <th className="px-4 py-3 font-medium">{col.status}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {scopes.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted">
                  {t.dhcp.empty}
                </td>
              </tr>
            )}
            {scopes.map((s) => (
              <tr key={s.id} className="hover:bg-panel2/60">
                <td className="px-4 py-3">
                  <Link href={`/dhcp/${s.id}`} className="font-semibold text-fg hover:text-brand-soft">
                    {s.name}
                  </Link>
                  <div className="text-xs text-muted">{format(t.dhcp.reservations, { n: s.reservationCount })}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-[13px] text-fg2">{s.networkCidr}</div>
                  <div className="text-xs text-muted">{s.siteName ?? s.networkName}</div>
                </td>
                <td className="px-4 py-3 font-mono text-[13px] text-fg2">
                  {s.rangeStart} – {s.rangeEnd}
                </td>
                <td className="px-4 py-3 text-muted">{formatLease(s.leaseSeconds, t.dhcp.lease)}</td>
                <td className="px-4 py-3">
                  <div className="text-fg2">
                    {format(t.dhcp.distributable, { free: fmtInt(s.distributable, locale), total: fmtInt(s.poolSize, locale) })}
                  </div>
                  {s.conflictCount > 0 && (
                    <div className="text-xs font-medium text-warn">{format(t.dhcp.conflicts, { n: s.conflictCount })}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      s.enabled ? "bg-ok/15 text-ok" : "bg-line text-muted"
                    }`}
                  >
                    {s.enabled ? t.dhcp.enabled : t.dhcp.disabled}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Link
                      href={`/dhcp/${s.id}`}
                      aria-label={format(t.dhcp.manageLabel, { name: s.name })}
                      className="btn-ghost h-8 px-3 text-xs"
                    >
                      {t.dhcp.manage}
                    </Link>
                    <button
                      onClick={() => setEditing(s)}
                      aria-label={format(t.dhcp.editLabel, { name: s.name })}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => remove(s)}
                      disabled={deleting === s.id}
                      aria-label={format(t.dhcp.deleteLabel, { name: s.name })}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">{format(t.dhcp.shown, { n: scopes.length })}</p>

      {editing && (
        <ScopeForm
          key={editing.id}
          scope={editing}
          networks={networks}
          initialNetworkId={null}
          onClose={() => setEditing(null)}
          onCreated={() => router.refresh()}
        />
      )}

      {open && (
        <ScopeForm
          networks={networks}
          initialNetworkId={preselectedNetwork}
          onClose={() => setOpen(false)}
          onCreated={(id) => router.push(`/dhcp/${id}`)}
        />
      )}
    </>
  );
}
