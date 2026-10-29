"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { NetworkRow, NetworkStatus, Site } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt, fmtPct } from "@/lib/format";
import { NetworkForm } from "./NetworkForm";
import { BulkEditForm } from "./BulkEditForm";
import type { CustomFieldDef, TagInfo } from "@/lib/metaTypes";
import { TagChip, displayValue } from "@/components/meta/MetaInputs";

export interface VrfOption {
  id: number;
  name: string;
}

interface Props {
  networks: NetworkRow[];
  sites: Site[];
  vrfs: VrfOption[];
  allTags: Pick<TagInfo, "name" | "color">[];
  fields: CustomFieldDef[];
  initialOpen: boolean;
  filters: { q: string; status: string; version: string; vrf: string; site: string; tag: string };
}

const STATUS_STYLE: Record<NetworkStatus, string> = {
  active: "bg-ok/15 text-ok",
  inactive: "bg-neutral/20 text-muted",
  maintenance: "bg-warn/15 text-warn",
  error: "bg-bad/15 text-bad",
};

const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];

export function NetworksView({ networks, sites, vrfs, allTags, fields, initialOpen, filters }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [q, setQ] = useState(filters.q);
  const [open, setOpen] = useState(initialOpen);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [editing, setEditing] = useState<NetworkRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // sélection multiple (modification et suppression groupées)
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const allSelected = networks.length > 0 && networks.every((n) => selected.has(n.id));
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(networks.map((n) => n.id)));
  const removeSelected = async () => {
    if (!window.confirm(format(t.bulk.deleteConfirm, { n: selected.size }))) return;
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/networks/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.bulk.deleteFailed);
      }
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.bulk.deleteFailed);
    } finally {
      setBulkBusy(false);
    }
  };

  const navigate = (next: Partial<typeof filters>) => {
    const merged = { ...filters, q, ...next };
    const params = new URLSearchParams();
    if (merged.q.trim()) params.set("q", merged.q.trim());
    if (merged.status) params.set("status", merged.status);
    if (merged.version) params.set("version", merged.version);
    if (merged.vrf) params.set("vrf", merged.vrf);
    if (merged.site) params.set("site", merged.site);
    if (merged.tag) params.set("tag", merged.tag);
    const qs = params.toString();
    router.replace(qs ? `/reseaux?${qs}` : "/reseaux");
  };

  const closeForm = () => {
    setOpen(false);
    if (initialOpen) navigate({}); // retire ?nouveau=1 de l'URL
  };

  const remove = async (n: NetworkRow) => {
    if (!window.confirm(format(t.networks.deleteConfirm, { cidr: n.cidr, name: n.name }))) return;
    setDeleting(n.id);
    setError(null);
    try {
      const res = await fetch(`/api/networks/${n.id}`, { method: "DELETE" });
      if (!res.ok) {
        // le serveur renvoie déjà le message dans la langue de l'utilisateur
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.networks.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.networks.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  // Changer la VRF d'un réseau : le serveur refuse le déplacement s'il créerait un chevauchement dans la VRF de destination
  const moveToVrf = async (n: NetworkRow, value: string) => {
    setMoving(n.id);
    setError(null);
    try {
      const res = await fetch(`/api/networks/${n.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vrfId: value ? Number(value) : null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.networks.moveFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.networks.moveFailed);
    } finally {
      setMoving(null);
    }
  };

  const col = t.networks.columns;

  return (
    <>
      {/* Barre d'outils */}
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
            placeholder={t.networks.searchPlaceholder}
            aria-label={t.networks.searchLabel}
            className="input pl-9"
          />
        </form>

        <select
          value={filters.status}
          onChange={(e) => navigate({ status: e.target.value })}
          aria-label={t.networks.statusFilter}
          className="input w-auto"
        >
          <option value="">{t.networks.allStatuses}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </select>

        <select
          value={filters.version}
          onChange={(e) => navigate({ version: e.target.value })}
          aria-label={t.networks.versionFilter}
          className="input w-auto"
        >
          <option value="">{t.networks.allVersions}</option>
          <option value="4">IPv4</option>
          <option value="6">IPv6</option>
        </select>

        <select
          value={filters.vrf}
          onChange={(e) => navigate({ vrf: e.target.value })}
          aria-label={t.networks.vrfFilter}
          className="input w-auto"
        >
          <option value="">{t.networks.allVrfs}</option>
          <option value="none">{t.networks.noVrf}</option>
          {vrfs.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>

        <select
          value={filters.site}
          onChange={(e) => navigate({ site: e.target.value })}
          aria-label={t.networks.siteFilter}
          className="input w-auto"
        >
          <option value="">{t.networks.allSites}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {(allTags.length > 0 || filters.tag) && (
          <select
            value={filters.tag}
            onChange={(e) => navigate({ tag: e.target.value })}
            aria-label={t.tagging.filter.tag}
            className="input w-auto"
          >
            <option value="">{t.tagging.filter.allTags}</option>
            {allTags.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        )}

        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t.networks.newNetwork}
        </button>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm">
          <span className="font-medium text-fg">{format(t.bulk.selected, { n: selected.size })}</span>
          <button className="btn-primary" onClick={() => setBulkOpen(true)} disabled={bulkBusy}>
            <Pencil className="h-4 w-4" />
            {t.bulk.edit}
          </button>
          <button className="btn-ghost text-bad" onClick={removeSelected} disabled={bulkBusy}>
            <Trash2 className="h-4 w-4" />
            {t.bulk.delete}
          </button>
          <button className="btn-ghost ml-auto" onClick={() => setSelected(new Set())}>
            {t.bulk.clear}
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      {/* Tableau */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1020px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="w-10 px-4 py-3">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={t.bulk.selectAll} />
              </th>
              <th className="px-4 py-3 font-medium">{col.network}</th>
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.site}</th>
              <th className="px-4 py-3 font-medium">{col.vlan}</th>
              <th className="px-4 py-3 font-medium">{col.vrf}</th>
              <th className="px-4 py-3 font-medium">{col.status}</th>
              <th className="px-4 py-3 font-medium">{col.usage}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {networks.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-muted">
                  {t.networks.empty}
                </td>
              </tr>
            )}
            {networks.map((n) => {
              const bar = n.usagePct >= 85 ? "bg-bad" : n.usagePct >= 65 ? "bg-warn" : "bg-ok";
              return (
                <tr key={n.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleOne(n.id)} aria-label={format(t.bulk.selectRow, { cidr: n.cidr })} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          n.version === 4 ? "bg-ipv4/20 text-ipv4" : "bg-ipv6/20 text-ipv6"
                        }`}
                      >
                        v{n.version}
                      </span>
                      <Link
                        href={`/ipam/${n.id}`}
                        title={t.networks.openIpam}
                        className="font-mono text-[13px] text-fg hover:text-brand-soft hover:underline"
                      >
                        {n.cidr}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-fg2">
                    {n.name}
                    {n.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {n.tags.map((tag) => (
                          <TagChip key={tag.id} tag={tag} />
                        ))}
                      </div>
                    )}
                    {fields.some((f) => n.customFields[f.key] !== undefined) && (
                      <div className="mt-1 text-[11px] text-muted">
                        {fields
                          .filter((f) => n.customFields[f.key] !== undefined)
                          .map((f) => `${f.label} : ${displayValue(f, n.customFields[f.key], t.tagging.fields.yes, t.tagging.fields.no)}`)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{n.siteName ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{n.vlan ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select
                      value={n.vrfId ?? ""}
                      disabled={moving === n.id}
                      onChange={(e) => moveToVrf(n, e.target.value)}
                      aria-label={format(t.networks.moveVrfLabel, { cidr: n.cidr })}
                      className="input h-8 w-auto min-w-[110px] py-0 text-xs disabled:opacity-50"
                    >
                      <option value="">{t.vrf.global}</option>
                      {vrfs.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[n.status]}`}>
                      {t.status[n.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {n.version === 4 ? (
                      <div className="w-44">
                        <div className="mb-1 flex justify-between text-xs text-muted">
                          <span>
                            {fmtInt(n.usedIps, locale)} / {fmtInt(n.capacity, locale)}
                          </span>
                          <span className="text-fg2">{fmtPct(n.usagePct, locale, 0)}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-line">
                          <div className={`h-full rounded-full ${bar}`} style={{ width: `${n.usagePct}%` }} />
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">
                        {format(t.networks.usedAddresses, { n: fmtInt(n.usedIps, locale) })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(n)}
                      aria-label={format(t.networks.editLabel, { cidr: n.cidr })}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => remove(n)}
                      disabled={deleting === n.id}
                      aria-label={format(t.networks.deleteLabel, { cidr: n.cidr })}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
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
      <p className="mt-3 text-xs text-muted">{format(t.networks.shown, { n: networks.length })}</p>

      {bulkOpen && (
        <BulkEditForm
          ids={[...selected]}
          sites={sites}
          vrfs={vrfs}
          allTags={allTags}
          fields={fields}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setSelected(new Set());
            router.refresh();
          }}
        />
      )}

      {editing && (
        <NetworkForm
          key={editing.id}
          network={editing}
          sites={sites}
          vrfs={vrfs}
          initialVrfId=""
          allTags={allTags}
          fields={fields}
          onClose={() => setEditing(null)}
          onCreated={() => router.refresh()}
        />
      )}

      {open && (
        <NetworkForm
          sites={sites}
          vrfs={vrfs}
          initialVrfId={/^\d+$/.test(filters.vrf) ? filters.vrf : ""}
          allTags={allTags}
          fields={fields}
          onClose={closeForm}
          onCreated={() => router.refresh()}
        />
      )}
    </>
  );
}
