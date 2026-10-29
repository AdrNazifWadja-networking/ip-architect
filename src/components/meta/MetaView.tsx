"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { CustomFieldDef, FieldType, MetaEntity, TagInfo } from "@/lib/metaTypes";
import { FIELD_LABEL_MAX, FIELD_TYPES, META_ENTITIES, TAG_COLORS, TAG_NAME_MAX } from "@/lib/metaTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { TagChip } from "./MetaInputs";

interface Props {
  tags: TagInfo[];
  fields: CustomFieldDef[];
  canEdit: boolean;
  canDefine: boolean;
}

async function call(url: string, method: string, body: unknown, fallback: string): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? fallback);
  }
}

export function MetaView({ tags, fields, canEdit, canDefine }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const m = t.tagging;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // nouvelle étiquette
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState<string>("gray");
  // nouveau champ
  const [entity, setEntity] = useState<MetaEntity>("network");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const addTag = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await call("/api/tags", "POST", { name: tagName, color: tagColor }, m.tags.failed);
      setTagName("");
    }, m.tags.failed);
  };

  const addField = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await call(
        "/api/custom-fields",
        "POST",
        { entity, key, label, type, required, ...(type === "choice" ? { options: options.split("\n").map((o) => o.trim()).filter(Boolean) } : {}) },
        m.fields.failed,
      );
      setKey("");
      setLabel("");
      setOptions("");
      setRequired(false);
    }, m.fields.failed);
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {error && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad xl:col-span-2">
          {error}
        </div>
      )}

      {/* Étiquettes */}
      <section className="card p-5">
        <h2 className="card-title">{m.tags.title}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">{m.tags.hint}</p>

        {canEdit && (
          <form onSubmit={addTag} className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <label className="label-caps mb-1.5 block" htmlFor="tag-name">{m.tags.name}</label>
              <input id="tag-name" value={tagName} maxLength={TAG_NAME_MAX} onChange={(e) => setTagName(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="tag-color">{m.tags.color}</label>
              <select id="tag-color" value={tagColor} onChange={(e) => setTagColor(e.target.value)} className="input">
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>{m.tags.colors[c]}</option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={busy} className="btn-primary">{busy ? m.tags.adding : m.tags.add}</button>
          </form>
        )}

        {tags.length === 0 ? (
          <p className="text-sm text-muted">{m.tags.empty}</p>
        ) : (
          <ul className="divide-y divide-line">
            {tags.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <TagChip tag={g} />
                <span className="text-xs text-muted">{format(m.tags.usage, { networks: g.networkCount, addresses: g.addressCount })}</span>
                {canEdit && (
                  <span className="ml-auto flex items-center gap-2">
                    <select
                      value={g.color}
                      aria-label={m.tags.color}
                      disabled={busy}
                      onChange={(e) => void run(() => call(`/api/tags/${g.id}`, "PATCH", { color: e.target.value }, m.tags.failed), m.tags.failed)}
                      className="input h-8 w-auto py-0 text-xs"
                    >
                      {TAG_COLORS.map((c) => (
                        <option key={c} value={c}>{m.tags.colors[c]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`${m.tags.delete} ${g.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(format(m.tags.deleteConfirm, { name: g.name }))) {
                          void run(() => call(`/api/tags/${g.id}`, "DELETE", undefined, m.tags.failed), m.tags.failed);
                        }
                      }}
                      className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Champs personnalisés */}
      <section className="card p-5">
        <h2 className="card-title">{m.fields.title}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">{canDefine ? m.fields.hint : m.fields.adminOnly}</p>

        {canDefine && (
          <form onSubmit={addField} className="mb-4 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="f-entity">{m.fields.entity}</label>
                <select id="f-entity" value={entity} onChange={(e) => setEntity(e.target.value as MetaEntity)} className="input">
                  {META_ENTITIES.map((x) => (
                    <option key={x} value={x}>{m.fields.entities[x]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="f-type">{m.fields.type}</label>
                <select id="f-type" value={type} onChange={(e) => setType(e.target.value as FieldType)} className="input">
                  {FIELD_TYPES.map((x) => (
                    <option key={x} value={x}>{m.fields.types[x]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="f-label">{m.fields.label}</label>
                <input id="f-label" value={label} maxLength={FIELD_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} className="input" required />
              </div>
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="f-key">{m.fields.key}</label>
                <input id="f-key" value={key} maxLength={30} onChange={(e) => setKey(e.target.value)} className="input font-mono" spellCheck={false} required />
                <p className="mt-1 text-xs text-muted">{m.fields.keyHint}</p>
              </div>
            </div>
            {type === "choice" && (
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="f-options">{m.fields.options}</label>
                <textarea id="f-options" value={options} onChange={(e) => setOptions(e.target.value)} rows={4} className="input" required />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-fg2">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              {m.fields.required}
              <span className="text-xs text-muted">— {m.fields.requiredHint}</span>
            </label>
            <button type="submit" disabled={busy} className="btn-primary">{busy ? m.fields.adding : m.fields.add}</button>
          </form>
        )}

        {fields.length === 0 ? (
          <p className="text-sm text-muted">{m.fields.empty}</p>
        ) : (
          <ul className="divide-y divide-line">
            {fields.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="font-medium text-fg">{f.label}</span>
                <code className="rounded bg-panel2 px-1.5 py-0.5 text-xs text-fg2">{f.key}</code>
                <span className="text-xs text-muted">
                  {m.fields.entities[f.entity]} · {m.fields.types[f.type]}
                  {f.type === "choice" && ` (${f.options.join(", ")})`}
                  {f.required && ` · ${m.fields.required}`}
                </span>
                {canDefine && (
                  <button
                    type="button"
                    aria-label={`${m.fields.delete} ${f.label}`}
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(format(m.fields.deleteConfirm, { label: f.label }))) {
                        void run(() => call(`/api/custom-fields/${f.id}`, "DELETE", undefined, m.fields.failed), m.fields.failed);
                      }
                    }}
                    className="ml-auto rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
