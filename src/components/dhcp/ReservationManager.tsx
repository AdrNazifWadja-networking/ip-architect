"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { DhcpReservationRow, DhcpScopeRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

interface Props {
  scope: DhcpScopeRow;
  reservations: DhcpReservationRow[];
}

export function ReservationManager({ scope, reservations }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const r = t.dhcp.detail.reservations;

  const [mac, setMac] = useState("");
  const [address, setAddress] = useState("");
  const [hostname, setHostname] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  // modification en ligne : adresse MAC, nom d'hôte, description (l'IP ne change pas : supprimer puis recréer)
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ mac: "", hostname: "", description: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/dhcp/scopes/${scope.id}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac, address, hostname, description }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? r.addFailed);
      setMac("");
      setAddress("");
      setHostname("");
      setDescription("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : r.addFailed);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (row: DhcpReservationRow) => {
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/dhcp/scopes/${scope.id}/reservations/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // un champ vidé est envoyé comme null : il est effacé côté serveur
        body: JSON.stringify({
          mac: draft.mac,
          hostname: draft.hostname.trim() || null,
          description: draft.description.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? r.editFailed);
      }
      setEditId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : r.editFailed);
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (row: DhcpReservationRow) => {
    if (!window.confirm(format(r.deleteConfirm, { mac: row.mac, address: row.address }))) return;
    setDeleting(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/dhcp/scopes/${scope.id}/reservations/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? r.deleteFailed);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : r.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="card mb-4 p-5">
      <h2 className="mb-1 text-sm font-semibold text-fg">{r.title}</h2>
      <p className="text-xs text-muted">{r.hint}</p>
      <p className="mb-4 text-xs text-muted">{r.ipHint}</p>

      <form onSubmit={add} className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1.2fr_auto] lg:items-end">
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="res-mac">
            {r.mac}
          </label>
          <input
            id="res-mac"
            required
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder={r.macPlaceholder}
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="res-ip">
            {r.address}
          </label>
          <input
            id="res-ip"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={scope.rangeEnd.replace(/\d+$/, "240")}
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="res-host">
            {r.hostname}
          </label>
          <input id="res-host" maxLength={100} value={hostname} onChange={(e) => setHostname(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="res-desc">
            {r.description}
          </label>
          <input id="res-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </div>
        <button type="submit" disabled={saving} className="btn-primary">
          <Plus className="h-4 w-4" />
          {saving ? r.adding : r.add}
        </button>
      </form>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2.5 font-medium">{r.address}</th>
              <th className="px-4 py-2.5 font-medium">{r.mac}</th>
              <th className="px-4 py-2.5 font-medium">{r.hostname}</th>
              <th className="px-4 py-2.5 font-medium">{r.description}</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {reservations.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  {r.empty}
                </td>
              </tr>
            )}
            {reservations.map((row) =>
              editId === row.id ? (
                <tr key={row.id} className="bg-panel2/60">
                  <td className="px-4 py-2 font-mono text-[13px] text-fg">{row.address}</td>
                  <td className="px-4 py-2">
                    <input
                      value={draft.mac}
                      autoFocus
                      onChange={(e) => setDraft({ ...draft, mac: e.target.value })}
                      aria-label={r.mac}
                      className="input h-8 py-0 font-mono text-xs"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      value={draft.hostname}
                      maxLength={100}
                      onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
                      aria-label={r.hostname}
                      className="input h-8 py-0 text-xs"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      value={draft.description}
                      maxLength={200}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      aria-label={r.description}
                      className="input h-8 py-0 text-xs"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => saveEdit(row)}
                      disabled={savingEdit}
                      aria-label={r.save}
                      title={r.save}
                      className="rounded-md p-2 text-ok hover:bg-ok/10 disabled:opacity-40"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      aria-label={r.cancel}
                      title={r.cancel}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ) : (
              <tr key={row.id} className="hover:bg-panel2/60">
                <td className="px-4 py-2.5 font-mono text-[13px] text-fg">{row.address}</td>
                <td className="px-4 py-2.5 font-mono text-[13px] text-fg2">{row.mac}</td>
                <td className="px-4 py-2.5 text-fg2">{row.hostname ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">{row.description ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => {
                      setError(null);
                      setEditId(row.id);
                      setDraft({ mac: row.mac, hostname: row.hostname ?? "", description: row.description ?? "" });
                    }}
                    aria-label={format(r.edit, { mac: row.mac })}
                    className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => remove(row)}
                    disabled={deleting === row.id}
                    aria-label={format(r.delete, { mac: row.mac })}
                    className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
