"use client";

import { useState } from "react";
import type { Site, VlanRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  sites: Site[];
  /** Présent = mode modification. */
  vlan?: VlanRow;
  onClose: () => void;
  onCreated: () => void;
}

export function VlanForm({ sites, vlan, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const f = t.vlans.form;

  const editing = vlan !== undefined;
  // un VLAN utilisé par des réseaux est retrouvé par (site, numéro) : seul son nom peut changer
  const locked = editing && vlan.networkCount > 0;
  const [number, setNumber] = useState(vlan ? String(vlan.number) : "");
  const [name, setName] = useState(vlan?.name ?? "");
  const [siteId, setSiteId] = useState(vlan?.siteId != null ? String(vlan.siteId) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/vlans/${vlan.id}` : "/api/vlans", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: Number(number), name, siteId: siteId ? Number(siteId) : null }),
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
    <Modal title={editing ? f.editTitle : f.title} closeLabel={f.close} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_1fr]">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="vlan-number">
              {f.number}
            </label>
            <input
              id="vlan-number"
              type="number"
              min={1}
              max={4094}
              autoFocus={!editing}
              required
              disabled={locked}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="vlan-name">
              {f.name}
            </label>
            <input id="vlan-name" required maxLength={80} autoFocus={editing} value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>
        </div>

        <div>
          <label className="label-caps mb-1.5 block" htmlFor="vlan-site">
            {f.site}
          </label>
          <select id="vlan-site" value={siteId} disabled={locked} onChange={(e) => setSiteId(e.target.value)} className="input disabled:opacity-60">
            <option value="">{f.noSite}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {locked && vlan && <p className="text-xs text-muted">{format(f.lockedHint, { n: vlan.networkCount })}</p>}

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
            {saving ? (editing ? f.saving : f.submitting) : editing ? f.save : f.submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}
