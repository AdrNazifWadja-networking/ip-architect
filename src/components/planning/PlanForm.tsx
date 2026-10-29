"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  vrfs: { id: number; name: string }[];
  onClose: () => void;
}

/** Création d'un plan : nom, bloc à découper et VRF. Les besoins se saisissent ensuite dans l'éditeur. */
export function PlanForm({ vrfs, onClose }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const f = t.planning.form;
  const [name, setName] = useState("");
  const [parentCidr, setParentCidr] = useState("");
  const [vrfId, setVrfId] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentCidr, vrfId: vrfId === "" ? null : Number(vrfId), description }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; plan?: { id: number } };
      if (!res.ok || !data.plan) throw new Error(data.error ?? f.createFailed);
      router.push(`/planification/${data.plan.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : f.createFailed);
      setSaving(false);
    }
  };

  return (
    <Modal title={f.title} closeLabel={f.close} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="plan-name">
            {f.name}
          </label>
          <input id="plan-name" autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={f.namePlaceholder} className="input" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="plan-parent">
              {f.parent}
            </label>
            <input
              id="plan-parent"
              required
              value={parentCidr}
              onChange={(e) => setParentCidr(e.target.value)}
              placeholder={f.parentPlaceholder}
              className="input font-mono"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="plan-vrf">
              {f.vrf}
            </label>
            <select id="plan-vrf" value={vrfId} onChange={(e) => setVrfId(e.target.value)} className="input">
              <option value="">{f.noVrf}</option>
              {vrfs.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="plan-desc">
            {f.description}
          </label>
          <input id="plan-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
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
            {saving ? f.submitting : f.submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}
