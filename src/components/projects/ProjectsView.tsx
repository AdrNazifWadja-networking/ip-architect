"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import type { ProjectRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { ProjectForm } from "./ProjectForm";

interface Props {
  projects: ProjectRow[];
}

export function ProjectsView({ projects }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = t.projects;
  const col = p.columns;

  // fuseau UTC : le serveur et le navigateur affichent la même date (pas d'écart d'hydratation)
  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-GB", { timeZone: "UTC" }) : p.unknownDate;

  const call = async (id: number, url: string, init: RequestInit, fallback: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? fallback);
      }
      // le projet actif a changé (ou disparu) : toutes les pages serveur, menu compris, se recalculent
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(null);
    }
  };

  const activate = (pr: ProjectRow) => call(pr.id, `/api/projects/${pr.id}/activate`, { method: "POST" }, p.activateFailed);

  const remove = (pr: ProjectRow) => {
    const msg = format(p.deleteConfirm, {
      name: pr.name,
      networks: pr.networkCount,
      sites: pr.siteCount,
      vlans: pr.vlanCount,
      vrfs: pr.vrfCount,
    });
    if (!window.confirm(msg)) return;
    void call(pr.id, `/api/projects/${pr.id}`, { method: "DELETE" }, p.deleteFailed);
  };

  return (
    <>
      <div className="mb-4 flex items-center">
        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {p.newProject}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{col.name}</th>
              <th className="px-4 py-3 font-medium">{col.networks}</th>
              <th className="px-4 py-3 font-medium">{col.sites}</th>
              <th className="px-4 py-3 font-medium">{col.vlans}</th>
              <th className="px-4 py-3 font-medium">{col.vrfs}</th>
              <th className="px-4 py-3 font-medium">{col.created}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {projects.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted">
                  {p.empty}
                </td>
              </tr>
            )}
            {projects.map((pr) => (
              <tr key={pr.id} className={pr.active ? "bg-brand/5" : "hover:bg-panel2/60"}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">{pr.name}</span>
                    {pr.active && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-medium text-ok">
                        <Check className="h-3 w-3" />
                        {p.activeBadge}
                      </span>
                    )}
                  </div>
                  {pr.description && <div className="text-xs text-muted">{pr.description}</div>}
                </td>
                <td className="px-4 py-3 text-fg2">{pr.networkCount}</td>
                <td className="px-4 py-3 text-fg2">{pr.siteCount}</td>
                <td className="px-4 py-3 text-fg2">{pr.vlanCount}</td>
                <td className="px-4 py-3 text-fg2">{pr.vrfCount}</td>
                <td className="px-4 py-3 text-muted">{day(pr.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {!pr.active && (
                      <button
                        onClick={() => activate(pr)}
                        disabled={busy === pr.id}
                        aria-label={format(p.activateLabel, { name: pr.name })}
                        className="btn-ghost h-8 px-3 text-xs"
                      >
                        {p.activate}
                      </button>
                    )}
                    <button
                      onClick={() => setEditing(pr)}
                      aria-label={format(p.editLabel, { name: pr.name })}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => remove(pr)}
                      disabled={busy === pr.id || pr.active}
                      aria-label={format(p.deleteLabel, { name: pr.name })}
                      title={pr.active ? t.errors.projectActive : undefined}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
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
      <p className="mt-3 text-xs text-muted">{format(p.shown, { n: projects.length })}</p>
      <p className="mt-1 text-xs text-muted">{p.note}</p>

      {editing && <ProjectForm key={editing.id} project={editing} onClose={() => setEditing(null)} onDone={() => router.refresh()} />}
      {open && <ProjectForm onClose={() => setOpen(false)} onDone={() => router.refresh()} />}
    </>
  );
}
