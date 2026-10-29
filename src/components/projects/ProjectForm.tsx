"use client";

import { useState } from "react";
import type { ProjectRow } from "@/lib/types";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  /** Présent = mode modification. */
  project?: ProjectRow;
  onClose: () => void;
  onDone: () => void;
}

export function ProjectForm({ project, onClose, onDone }: Props) {
  const { t } = useI18n();
  const f = t.projects.form;
  const editing = project !== undefined;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/projects/${project.id}` : "/api/projects", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { name, description: description.trim() || null } : { name, description }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; project?: { id: number } };
      if (!res.ok || !data.project) throw new Error(data.error ?? (editing ? f.saveFailed : f.createFailed));
      onDone();
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
          <label className="label-caps mb-1.5 block" htmlFor="project-name">
            {f.name}
          </label>
          <input
            id="project-name"
            autoFocus={!editing}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={f.namePlaceholder}
            className="input"
          />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="project-desc">
            {f.description}
          </label>
          <input id="project-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
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
