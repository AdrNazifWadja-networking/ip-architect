"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { NetworkStatus, Site } from "@/lib/types";
import type { CustomFieldDef, TagInfo } from "@/lib/metaTypes";
import type { VrfOption } from "./NetworksView";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { FieldsInputs, TagsInput, initialFieldValues } from "@/components/meta/MetaInputs";

interface Props {
  ids: number[];
  sites: Site[];
  vrfs: VrfOption[];
  allTags: Pick<TagInfo, "name" | "color">[];
  fields: CustomFieldDef[];
  onClose: () => void;
  onDone: () => void;
}

type OnState = { status: boolean; site: boolean; vlan: boolean; vrf: boolean };

/** Ligne « case à cocher + champ » (définie hors du composant : sinon le champ perdrait le focus à chaque frappe). */
function Row({ k, label, on, toggle, change, children }: { k: keyof OnState; label: string; on: OnState; toggle: (k: keyof OnState) => void; change: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5">
      <input type="checkbox" id={`bulk-${k}`} checked={on[k]} onChange={() => toggle(k)} className="mt-1" aria-label={`${change} ${label}`} />
      <div>
        <label className="label-caps mb-1.5 block" htmlFor={`bulk-${k}-input`}>
          {label}
        </label>
        {children}
      </div>
    </div>
  );
}

const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];

/** Modification groupée : seules les lignes cochées sont envoyées ; le serveur applique tout ou rien. */
export function BulkEditForm({ ids, sites, vrfs, allTags, fields, onClose, onDone }: Props) {
  const { t } = useI18n();
  const f = t.bulk.form;
  const [on, setOn] = useState({ status: false, site: false, vlan: false, vrf: false });
  const [status, setStatus] = useState<NetworkStatus>("active");
  const [siteId, setSiteId] = useState("");
  const [vlan, setVlan] = useState("");
  const [vrfId, setVrfId] = useState("");
  const [addTags, setAddTags] = useState<string[]>([]);
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>(() => initialFieldValues(fields));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (k: keyof OnState) => setOn({ ...on, [k]: !on[k] });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (on.status) changes.status = status;
    if (on.site) changes.siteId = siteId ? Number(siteId) : null;
    if (on.vlan) changes.vlan = vlan.trim() ? Number(vlan) : null;
    if (on.vrf) changes.vrfId = vrfId ? Number(vrfId) : null;
    if (addTags.length > 0) changes.addTags = addTags;
    if (removeTags.length > 0) changes.removeTags = removeTags;
    const custom: Record<string, string> = {};
    for (const d of fields) if ((values[d.key] ?? "").trim() !== "") custom[d.key] = values[d.key];
    if (Object.keys(custom).length > 0) changes.customFields = custom;
    if (Object.keys(changes).length === 0) {
      setError(f.nothing);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/networks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, changes }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? f.failed);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : f.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={format(f.title, { n: ids.length })} className="card max-h-[92vh] w-full max-w-xl overflow-y-auto p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold text-fg">{format(f.title, { n: ids.length })}</h2>
          <button onClick={onClose} aria-label={t.networks.form.close} className="rounded-md p-1.5 text-muted hover:bg-panel2 hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted">{f.hint}</p>

        <form onSubmit={submit} className="space-y-4">
          <Row on={on} toggle={toggle} change={f.change} k="status" label={f.status}>
            <select id="bulk-status-input" value={status} onChange={(e) => { setStatus(e.target.value as NetworkStatus); setOn({ ...on, status: true }); }} className="input">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.status[s]}
                </option>
              ))}
            </select>
          </Row>
          <Row on={on} toggle={toggle} change={f.change} k="site" label={f.site}>
            <select id="bulk-site-input" value={siteId} onChange={(e) => { setSiteId(e.target.value); setOn({ ...on, site: true }); }} className="input">
              <option value="">{f.noSite}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Row>
          <Row on={on} toggle={toggle} change={f.change} k="vlan" label={f.vlan}>
            <input id="bulk-vlan-input" type="number" min={1} max={4094} value={vlan} onChange={(e) => { setVlan(e.target.value); setOn({ ...on, vlan: true }); }} className="input" />
            <p className="mt-1 text-xs text-muted">{f.vlanHint}</p>
          </Row>
          <Row on={on} toggle={toggle} change={f.change} k="vrf" label={f.vrf}>
            <select id="bulk-vrf-input" value={vrfId} onChange={(e) => { setVrfId(e.target.value); setOn({ ...on, vrf: true }); }} className="input">
              <option value="">{t.vrf.global}</option>
              {vrfs.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Row>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="bulk-add-tags">
              {f.addTags}
            </label>
            <TagsInput id="bulk-add-tags" value={addTags} onChange={setAddTags} suggestions={allTags} />
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="bulk-remove-tags">
              {f.removeTags}
            </label>
            <TagsInput id="bulk-remove-tags" value={removeTags} onChange={setRemoveTags} suggestions={allTags} />
          </div>

          {fields.length > 0 && (
            <div>
              <FieldsInputs idPrefix="bulk-field" defs={fields.map((d) => ({ ...d, required: false }))} values={values} onChange={setValues} />
              <p className="mt-1 text-xs text-muted">{f.customHint}</p>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              {f.cancel}
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? f.applying : f.apply}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
