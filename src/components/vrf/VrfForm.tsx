"use client";

import { useState } from "react";
import type { VrfRow } from "@/lib/types";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  /** Présent = mode modification. */
  vrf?: VrfRow;
  onClose: () => void;
  onCreated: (vrfId: number) => void;
}

export function VrfForm({ vrf, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const f = t.vrf.form;

  const editing = vrf !== undefined;
  const [name, setName] = useState(vrf?.name ?? "");
  const [rd, setRd] = useState(vrf?.rd ?? "");
  const [rtImport, setRtImport] = useState(vrf ? vrf.rtImport.join(", ") : "");
  const [rtExport, setRtExport] = useState(vrf ? vrf.rtExport.join(", ") : "");
  const [description, setDescription] = useState(vrf?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/vrfs/${vrf.id}` : "/api/vrfs", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        // un champ vidé est envoyé comme null en modification : il est effacé côté serveur
        body: JSON.stringify(
          editing
            ? { name, rd: rd.trim() || null, rtImport, rtExport, description: description.trim() || null }
            : { name, rd, rtImport, rtExport, description },
        ),
      });
      // le serveur renvoie déjà le message d'erreur dans la langue de l'utilisateur
      const data = (await res.json().catch(() => ({}))) as { error?: string; vrf?: { id: number } };
      if (!res.ok || !data.vrf) throw new Error(data.error ?? (editing ? f.saveFailed : f.createFailed));
      onCreated(data.vrf.id);
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
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="vrf-name">
            {f.name}
          </label>
          <input
            id="vrf-name"
            autoFocus={!editing}
            required
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={f.namePlaceholder}
            className="input font-mono"
          />
          <p className="mt-1 text-xs text-muted">{f.nameHint}</p>
        </div>

        <div>
          <label className="label-caps mb-1.5 block" htmlFor="vrf-rd">
            {f.rd}
          </label>
          <input
            id="vrf-rd"
            value={rd}
            onChange={(e) => setRd(e.target.value)}
            placeholder={f.rdPlaceholder}
            className="input font-mono"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="vrf-rt-import">
              {f.rtImport}
            </label>
            <input
              id="vrf-rt-import"
              value={rtImport}
              onChange={(e) => setRtImport(e.target.value)}
              placeholder={f.rtPlaceholder}
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="vrf-rt-export">
              {f.rtExport}
            </label>
            <input
              id="vrf-rt-export"
              value={rtExport}
              onChange={(e) => setRtExport(e.target.value)}
              placeholder={f.rtPlaceholder}
              className="input font-mono"
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted">{f.rtHint}</p>

        <div>
          <label className="label-caps mb-1.5 block" htmlFor="vrf-desc">
            {f.description}
          </label>
          <input id="vrf-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </div>

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
