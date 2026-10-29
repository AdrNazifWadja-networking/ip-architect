"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { CustomFieldDef } from "@/lib/metaTypes";
import { TAGS_PER_ITEM_MAX, TAG_NAME_MAX } from "@/lib/metaTypes";
import type { CustomValues, TagRef } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

export const TAG_STYLE: Record<string, string> = {
  gray: "bg-neutral/20 text-muted",
  blue: "bg-ipv4/20 text-ipv4",
  green: "bg-ok/15 text-ok",
  amber: "bg-warn/15 text-warn",
  red: "bg-bad/15 text-bad",
  purple: "bg-ipv6/20 text-ipv6",
};

export function TagChip({ tag }: { tag: Pick<TagRef, "name" | "color"> }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${TAG_STYLE[tag.color] ?? TAG_STYLE.gray}`}>
      {tag.name}
    </span>
  );
}

/** Saisie d'étiquettes : Entrée (ou virgule) ajoute, les noms inconnus seront créés par le serveur. */
export function TagsInput({
  id,
  value,
  onChange,
  suggestions,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: { name: string }[];
}) {
  const { t } = useI18n();
  const m = t.tagging.form;
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const name = raw.trim().replace(/\s+/g, " ").replace(/[,;]/g, "");
    if (!name || value.length >= TAGS_PER_ITEM_MAX) return setDraft("");
    if (!value.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...value, name]);
    setDraft("");
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {value.map((name) => {
          const known = suggestions.find((s) => s.name.toLowerCase() === name.toLowerCase()) as { name: string; color?: string } | undefined;
          return (
            <span key={name} className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-[11px] font-medium ${TAG_STYLE[known?.color ?? "gray"] ?? TAG_STYLE.gray}`}>
              {name}
              <button
                type="button"
                aria-label={format(m.remove, { name })}
                onClick={() => onChange(value.filter((v) => v !== name))}
                className="rounded-full p-0.5 hover:bg-black/10"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
      </div>
      <input
        id={id}
        list={`${id}-list`}
        value={draft}
        maxLength={TAG_NAME_MAX}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",") || v.endsWith(";")) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={m.tagsPlaceholder}
        className="input"
      />
      <datalist id={`${id}-list`}>
        {suggestions.map((s) => (
          <option key={s.name} value={s.name} />
        ))}
      </datalist>
    </div>
  );
}

/** Valeurs de formulaire : toujours des chaînes ("" = vide, "true"/"false" pour les oui/non). */
export function initialFieldValues(defs: CustomFieldDef[], current: CustomValues = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) out[d.key] = current[d.key] === undefined ? "" : String(current[d.key]);
  return out;
}

/** Charge utile API : tous les champs connus (vide = effacer). */
export function fieldsPayload(defs: CustomFieldDef[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) out[d.key] = values[d.key] ?? "";
  return out;
}

export function FieldsInputs({
  idPrefix,
  defs,
  values,
  onChange,
}: {
  idPrefix: string;
  defs: CustomFieldDef[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  if (defs.length === 0) return null;
  const set = (key: string, v: string) => onChange({ ...values, [key]: v });
  return (
    <fieldset className="space-y-3">
      <legend className="label-caps mb-1.5">{t.tagging.form.customFields}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {defs.map((d) => {
          const id = `${idPrefix}-${d.key}`;
          const v = values[d.key] ?? "";
          return (
            <div key={d.id}>
              <label htmlFor={id} className="mb-1 block text-xs text-fg2">
                {d.label}
                {d.required && <span className="text-bad"> *</span>}
              </label>
              {d.type === "choice" || d.type === "bool" ? (
                <select id={id} value={v} onChange={(e) => set(d.key, e.target.value)} className="input" required={d.required}>
                  <option value="">{t.tagging.form.choose}</option>
                  {d.type === "bool" ? (
                    <>
                      <option value="true">{t.tagging.fields.yes}</option>
                      <option value="false">{t.tagging.fields.no}</option>
                    </>
                  ) : (
                    d.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <input
                  id={id}
                  type={d.type === "number" ? "number" : "text"}
                  step={d.type === "number" ? "any" : undefined}
                  maxLength={200}
                  value={v}
                  onChange={(e) => set(d.key, e.target.value)}
                  className="input"
                  required={d.required}
                />
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Valeur lisible d'un champ (listes, tableaux). */
export function displayValue(d: CustomFieldDef, v: string | number | boolean | undefined, yes: string, no: string): string {
  if (v === undefined) return "—";
  if (d.type === "bool") return v === true ? yes : no;
  return String(v);
}
