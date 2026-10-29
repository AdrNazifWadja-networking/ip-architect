"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Trash2, X } from "lucide-react";
import type { AddressStatus, IpAddressRow, NetworkRow } from "@/lib/types";
import { calcSubnet } from "@/lib/ip/cidr";
import { addressAt, offsetInCidr } from "@/lib/ip/allocate";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { CustomFieldDef, TagInfo } from "@/lib/metaTypes";
import { FieldsInputs, TagChip, TagsInput, displayValue, fieldsPayload, initialFieldValues } from "@/components/meta/MetaInputs";

interface Props {
  network: NetworkRow;
  addresses: IpAddressRow[];
  /** Étiquettes existantes du projet (suggestions de saisie). */
  allTags: Pick<TagInfo, "name" | "color">[];
  /** Champs personnalisés définis pour les adresses. */
  fields: CustomFieldDef[];
}

/** La grille reste lisible jusqu'à 1 024 cellules (un /22). Au-delà, ou en IPv6, on se contente de la liste. */
const GRID_MAX = 1024n;

const STATUS_BADGE: Record<AddressStatus, string> = {
  used: "bg-ok/15 text-ok",
  reserved: "bg-warn/15 text-warn",
};

export function AddressManager({ network, addresses, allTags, fields }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const d = t.ipam.detail;
  const addressInput = useRef<HTMLInputElement>(null);

  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<AddressStatus>("used");
  const [hostname, setHostname] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => initialFieldValues(fields));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<number | null>(null);
  // modification en ligne d'une adresse inventoriée (l'adresse elle-même ne change pas)
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ status: AddressStatus; hostname: string; description: string }>({
    status: "used",
    hostname: "",
    description: "",
  });
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const statusLabel: Record<AddressStatus, string> = { used: d.form.used, reserved: d.form.reserved };

  // Cellules de la grille : une par adresse attribuable à un hôte (hors adresse réseau et broadcast en IPv4)
  const cells = useMemo(() => {
    const info = calcSubnet(network.cidr);
    if (!info || info.version !== 4 || info.total > GRID_MAX) return null;
    const total = Number(info.total);
    const start = info.prefix <= 30 ? 1 : 0;
    const end = info.prefix <= 30 ? total - 2 : total - 1;
    const byOffset = new Map<number, IpAddressRow>();
    for (const a of addresses) {
      const offset = offsetInCidr(network.cidr, a.address);
      if (offset !== null) byOffset.set(offset, a);
    }
    const list: { offset: number; address: string; row?: IpAddressRow }[] = [];
    for (let offset = start; offset <= end; offset++) {
      const addr = addressAt(network.cidr, offset);
      if (addr) list.push({ offset, address: addr, row: byOffset.get(offset) });
    }
    return list;
  }, [network.cidr, addresses]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/networks/${network.id}/addresses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim(), status, hostname, description, tags, customFields: fieldsPayload(fields, fieldValues) }),
      });
      // le serveur renvoie déjà le message d'erreur dans la langue de l'utilisateur
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? d.form.failed);
      setAddress("");
      setHostname("");
      setDescription("");
      setTags([]);
      setFieldValues(initialFieldValues(fields));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : d.form.failed);
    } finally {
      setSaving(false);
    }
  };

  const release = async (a: IpAddressRow) => {
    if (!window.confirm(format(d.table.releaseConfirm, { address: a.address }))) return;
    setReleasing(a.id);
    setError(null);
    try {
      const res = await fetch(`/api/networks/${network.id}/addresses/${a.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? d.table.releaseFailed);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : d.table.releaseFailed);
    } finally {
      setReleasing(null);
    }
  };

  const startEdit = (a: IpAddressRow) => {
    setError(null);
    setEditId(a.id);
    setDraft({ status: a.status, hostname: a.hostname ?? "", description: a.description ?? "" });
    setEditTags(a.tags.map((x) => x.name));
    setEditFields(initialFieldValues(fields, a.customFields));
  };

  const saveEdit = async (a: IpAddressRow) => {
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/networks/${network.id}/addresses/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // un champ vidé est envoyé comme null : il est effacé côté serveur
        body: JSON.stringify({
          status: draft.status,
          hostname: draft.hostname.trim() || null,
          description: draft.description.trim() || null,
          tags: editTags,
          customFields: fieldsPayload(fields, editFields),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? d.table.editFailed);
      }
      setEditId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : d.table.editFailed);
    } finally {
      setSavingEdit(false);
    }
  };

  const cellClass = (row?: IpAddressRow) =>
    row
      ? row.status === "used"
        ? "bg-ok/80 text-white"
        : "bg-warn/80 text-white"
      : "border border-line bg-panel2 text-muted hover:border-brand hover:bg-brand/20";

  return (
    <>
      {/* Grille d'occupation */}
      <div className="card mb-4 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="card-title">{d.grid.title}</h2>
          <div className="flex items-center gap-4 text-xs text-fg2">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-line bg-panel2" />
              {d.grid.free}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-ok/80" />
              {d.grid.used}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-warn/80" />
              {d.grid.reserved}
            </span>
          </div>
        </div>

        {cells ? (
          <div className="flex flex-wrap gap-1">
            {cells.map(({ offset, address: cellAddress, row }) => (
              <button
                key={offset}
                type="button"
                disabled={!!row}
                onClick={() => {
                  setAddress(cellAddress);
                  addressInput.current?.focus();
                }}
                title={
                  row
                    ? format(d.grid.cellTaken, { address: cellAddress, label: row.hostname ?? statusLabel[row.status] })
                    : format(d.grid.cellFree, { address: cellAddress })
                }
                aria-label={cellAddress}
                className={`flex h-7 w-7 items-center justify-center rounded text-[9px] font-medium transition-colors disabled:cursor-default ${cellClass(row)}`}
              >
                {cellAddress.split(".")[3]}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{d.grid.unavailable}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        {/* Formulaire d'allocation */}
        <form onSubmit={submit} className="card h-fit space-y-4 p-5">
          <h2 className="card-title">{d.form.title}</h2>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="ip-address">
              {d.form.address}
            </label>
            <input
              id="ip-address"
              ref={addressInput}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={d.form.addressPlaceholder}
              spellCheck={false}
              className="input font-mono"
            />
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="ip-status">
              {d.form.status}
            </label>
            <select
              id="ip-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as AddressStatus)}
              className="input"
            >
              <option value="used">{d.form.used}</option>
              <option value="reserved">{d.form.reserved}</option>
            </select>
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="ip-hostname">
              {d.form.hostname}
            </label>
            <input
              id="ip-hostname"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              maxLength={100}
              className="input"
            />
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="ip-description">
              {d.form.description}
            </label>
            <input
              id="ip-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              className="input"
            />
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="ip-tags">
              {t.tagging.form.tags}
            </label>
            <TagsInput id="ip-tags" value={tags} onChange={setTags} suggestions={allTags} />
          </div>

          <FieldsInputs idPrefix="ip-field" defs={fields} values={fieldValues} onChange={setFieldValues} />

          {error && (
            <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <button type="submit" disabled={saving} className="btn-primary w-full">
            {saving ? d.form.submitting : d.form.submit}
          </button>
        </form>

        {/* Adresses inventoriées */}
        <div className="card overflow-x-auto">
          <h2 className="card-title px-5 pb-1 pt-5">{d.table.title}</h2>
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">{d.table.address}</th>
                <th className="px-4 py-3 font-medium">{d.table.status}</th>
                <th className="px-4 py-3 font-medium">{d.table.hostname}</th>
                <th className="px-4 py-3 font-medium">{d.table.description}</th>
                <th className="px-4 py-3 font-medium">{t.tagging.form.tags}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {addresses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-muted">
                    {d.table.empty}
                  </td>
                </tr>
              )}
              {addresses.map((a) =>
                editId === a.id ? (
                  [
                  <tr key={`${a.id}-row`} className="bg-panel2/60">
                    <td className="px-5 py-2 font-mono text-[13px] text-fg">{a.address}</td>
                    <td className="px-4 py-2">
                      <select
                        value={draft.status}
                        onChange={(e) => setDraft({ ...draft, status: e.target.value as AddressStatus })}
                        aria-label={d.table.status}
                        className="input h-8 py-0 text-xs"
                      >
                        <option value="used">{d.form.used}</option>
                        <option value="reserved">{d.form.reserved}</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        value={draft.hostname}
                        maxLength={100}
                        autoFocus
                        onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
                        aria-label={d.table.hostname}
                        className="input h-8 py-0 text-xs"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        value={draft.description}
                        maxLength={200}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        aria-label={d.table.description}
                        className="input h-8 py-0 text-xs"
                      />
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">{editTags.length}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => saveEdit(a)}
                        disabled={savingEdit}
                        aria-label={d.table.save}
                        title={d.table.save}
                        className="rounded-md p-2 text-ok hover:bg-ok/10 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setEditId(null)}
                        aria-label={d.table.cancel}
                        title={d.table.cancel}
                        className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>,
                  <tr key={`${a.id}-meta`} className="bg-panel2/60">
                    <td colSpan={6} className="space-y-3 px-5 pb-4 pt-1">
                      <TagsInput id={`ip-tags-${a.id}`} value={editTags} onChange={setEditTags} suggestions={allTags} />
                      <FieldsInputs idPrefix={`ip-field-${a.id}`} defs={fields} values={editFields} onChange={setEditFields} />
                    </td>
                  </tr>,
                  ]
                ) : (
                <tr key={a.id} className="hover:bg-panel2/60">
                  <td className="px-5 py-2.5 font-mono text-[13px] text-fg">{a.address}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[a.status]}`}>
                      {statusLabel[a.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-fg2">{a.hostname ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{a.description ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {a.tags.map((tag) => (
                        <TagChip key={tag.id} tag={tag} />
                      ))}
                    </div>
                    {fields.some((f) => a.customFields[f.key] !== undefined) && (
                      <dl className="mt-1 space-y-0.5 text-[11px] text-muted">
                        {fields
                          .filter((f) => a.customFields[f.key] !== undefined)
                          .map((f) => (
                            <div key={f.id}>
                              <dt className="inline">{f.label} : </dt>
                              <dd className="inline text-fg2">{displayValue(f, a.customFields[f.key], t.tagging.fields.yes, t.tagging.fields.no)}</dd>
                            </div>
                          ))}
                      </dl>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => startEdit(a)}
                      aria-label={format(d.table.edit, { address: a.address })}
                      className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => release(a)}
                      disabled={releasing === a.id}
                      aria-label={format(d.table.release, { address: a.address })}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
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
      </div>
    </>
  );
}
