"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { NetworkRow, NetworkStatus, Site } from "@/lib/types";
import type { VrfOption } from "./NetworksView";
import { calcSubnet } from "@/lib/ip/cidr";
import { useI18n } from "@/lib/i18n/client";
import { formatCount } from "@/lib/format";
import type { CustomFieldDef, TagInfo } from "@/lib/metaTypes";
import { FieldsInputs, TagsInput, fieldsPayload, initialFieldValues } from "@/components/meta/MetaInputs";

interface Props {
  sites: Site[];
  vrfs: VrfOption[];
  initialVrfId: string;
  allTags: Pick<TagInfo, "name" | "color">[];
  fields: CustomFieldDef[];
  /** Présent = mode modification (le CIDR est figé). */
  network?: NetworkRow;
  onClose: () => void;
  onCreated: () => void;
}

const toInt = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];

export function NetworkForm({ sites, vrfs, initialVrfId, allTags, fields, network, onClose, onCreated }: Props) {
  const { t, locale } = useI18n();
  const f = t.networks.form;

  const editing = network !== undefined;
  const [cidr, setCidr] = useState(network?.cidr ?? "");
  const [name, setName] = useState(network?.name ?? "");
  const [siteId, setSiteId] = useState(network?.siteId != null ? String(network.siteId) : "");
  const [vlan, setVlan] = useState(network?.vlan != null ? String(network.vlan) : "");
  const [vrfId, setVrfId] = useState(editing ? (network.vrfId != null ? String(network.vrfId) : "") : initialVrfId);
  const [status, setStatus] = useState<NetworkStatus>(network?.status ?? "active");
  const [used, setUsed] = useState(editing ? String(network.usedIps) : "");
  const [reserved, setReserved] = useState(editing ? String(network.reservedIps) : "");
  const [tags, setTags] = useState<string[]>(network?.tags.map((x) => x.name) ?? []);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => initialFieldValues(fields, network?.customFields));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fermeture avec Échap
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Aperçu en direct du calcul CIDR
  const preview = useMemo(() => (cidr.trim() ? calcSubnet(cidr.trim()) : null), [cidr]);
  const invalid = cidr.trim() !== "" && !preview;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/networks/${network.id}` : "/api/networks", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // le CIDR n'est envoyé qu'à la création : il ne se modifie pas
          ...(editing ? {} : { cidr: cidr.trim() }),
          name,
          siteId: siteId ? Number(siteId) : null,
          vlan: toInt(vlan) ?? null,
          vrfId: vrfId ? Number(vrfId) : null,
          status,
          usedIps: toInt(used) ?? 0,
          reservedIps: toInt(reserved) ?? 0,
          tags,
          customFields: fieldsPayload(fields, fieldValues),
        }),
      });
      // le serveur renvoie déjà le message d'erreur dans la langue de l'utilisateur
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? (editing ? f.saveFailed : f.createFailed));
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : editing ? f.saveFailed : f.createFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={editing ? f.editTitle : f.title} className="card max-h-[92vh] w-full max-w-xl overflow-y-auto p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-fg">{editing ? f.editTitle : f.title}</h2>
          <button onClick={onClose} aria-label={f.close} className="rounded-md p-1.5 text-muted hover:bg-panel2 hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="cidr">
              {f.cidr}
            </label>
            <input
              id="cidr"
              autoFocus={!editing}
              disabled={editing}
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              placeholder={f.cidrPlaceholder}
              className={`input font-mono disabled:opacity-60 ${invalid ? "border-bad focus:border-bad focus:ring-bad" : ""}`}
              required
            />
            {editing && <p className="mt-1 text-xs text-muted">{f.cidrLocked}</p>}
            {invalid && <p className="mt-1 text-xs text-bad">{f.invalidCidr}</p>}
            {preview && !editing && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-line bg-panel2 p-3 text-xs">
                <dt className="text-muted">{f.previewNetwork}</dt>
                <dd className="font-mono text-fg2">{preview.cidr}</dd>
                <dt className="text-muted">{f.previewRange}</dt>
                <dd className="truncate font-mono text-fg2">
                  {preview.firstHost} → {preview.lastHost}
                </dd>
                <dt className="text-muted">{f.previewUsable}</dt>
                <dd className="text-fg2">{formatCount(preview.usable, locale)}</dd>
              </dl>
            )}
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="name">
              {f.name}
            </label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} className="input" maxLength={80} required />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="site">
                {f.site}
              </label>
              <select id="site" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="input">
                <option value="">{f.noSite}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="vlan">
                {f.vlan}
              </label>
              <input
                id="vlan"
                type="number"
                min={1}
                max={4094}
                value={vlan}
                onChange={(e) => setVlan(e.target.value)}
                className="input"
                placeholder={f.vlanPlaceholder}
              />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="status">
                {f.status}
              </label>
              <select id="status" value={status} onChange={(e) => setStatus(e.target.value as NetworkStatus)} className="input">
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t.status[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="vrf">
              {f.vrf}
            </label>
            <select id="vrf" value={vrfId} onChange={(e) => setVrfId(e.target.value)} className="input">
              <option value="">{f.noVrf}</option>
              {vrfs.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="used">
                {f.used}
              </label>
              <input id="used" type="number" min={0} value={used} onChange={(e) => setUsed(e.target.value)} className="input" placeholder="0" />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="reserved">
                {f.reserved}
              </label>
              <input id="reserved" type="number" min={0} value={reserved} onChange={(e) => setReserved(e.target.value)} className="input" placeholder="0" />
            </div>
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="net-tags">
              {t.tagging.form.tags}
            </label>
            <TagsInput id="net-tags" value={tags} onChange={setTags} suggestions={allTags} />
            <p className="mt-1 text-xs text-muted">{t.tagging.form.tagsHint}</p>
          </div>

          <FieldsInputs idPrefix="net-field" defs={fields} values={fieldValues} onChange={setFieldValues} />

          {error && (
            <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              {f.cancel}
            </button>
            <button type="submit" disabled={saving || invalid} className="btn-primary">
              {saving ? (editing ? f.saving : f.submitting) : editing ? f.save : f.submit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
