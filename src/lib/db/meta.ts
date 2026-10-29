import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import {
  ApiError,
  type CustomValue,
  type CustomValues,
  type TagRef,
} from "../types";
import {
  FIELDS_PER_ENTITY_MAX,
  FIELD_KEY_PATTERN,
  FIELD_LABEL_MAX,
  FIELD_OPTIONS_MAX,
  FIELD_OPTION_MAX,
  FIELD_TEXT_MAX,
  FIELD_TYPES,
  META_ENTITIES,
  TAGS_PER_ITEM_MAX,
  TAGS_PER_PROJECT_MAX,
  TAG_COLORS,
  TAG_NAME_MAX,
  type CreateFieldInput,
  type CreateTagInput,
  type CustomFieldDef,
  type FieldType,
  type MetaEntity,
  type TagColor,
  type TagInfo,
  type UpdateFieldInput,
  type UpdateTagInput,
} from "../metaTypes";

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Tables de liaison par entité (valeurs fixes, jamais issues de la requête). */
const TABLES = {
  network: { tags: "network_tags", values: "network_custom_values", col: "network_id" },
  address: { tags: "address_tags", values: "address_custom_values", col: "address_id" },
} as const;

/* --------------------------------- Étiquettes -------------------------------- */

function cleanTagName(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new ApiError("tagNameRequired", 422);
  if (name.length > TAG_NAME_MAX) throw new ApiError("tagNameTooLong", 422, { max: TAG_NAME_MAX });
  // eslint-disable-next-line no-control-regex
  if (/[,;\u0000-\u001f]/.test(name)) throw new ApiError("tagNameInvalid", 422);
  return name;
}

function cleanColor(raw: unknown, fallback: TagColor = "gray"): TagColor {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (!TAG_COLORS.includes(raw as TagColor)) throw new ApiError("invalidTagColor", 422);
  return raw as TagColor;
}

export function listTags(db: Db = getDb()): TagInfo[] {
  const project = getActiveProject(db);
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.color,
              (SELECT COUNT(*) FROM network_tags x WHERE x.tag_id = t.id) AS nc,
              (SELECT COUNT(*) FROM address_tags x WHERE x.tag_id = t.id) AS ac
       FROM tags t WHERE t.project_id = ? ORDER BY LOWER(t.name)`,
    )
    .all(project.id) as { id: number; name: string; color: TagColor; nc: number; ac: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, networkCount: r.nc, addressCount: r.ac }));
}

function getTag(id: number, db: Db): TagInfo {
  const t = listTags(db).find((x) => x.id === id);
  if (!t) throw new ApiError("tagNotFound", 404);
  return t;
}

function tagCount(db: Db, projectId: number): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM tags WHERE project_id = ?").get(projectId) as { c: number }).c;
}

export function createTag(input: CreateTagInput, db: Db = getDb()): TagInfo {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const name = cleanTagName(input.name);
  const color = cleanColor(input.color);
  if (db.prepare("SELECT 1 FROM tags WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(project.id, name)) {
    throw new ApiError("tagExists", 409, { name });
  }
  if (tagCount(db, project.id) >= TAGS_PER_PROJECT_MAX) throw new ApiError("tagLimit", 409, { max: TAGS_PER_PROJECT_MAX });
  const res = db.prepare("INSERT INTO tags (project_id, name, color) VALUES (?, ?, ?)").run(project.id, name, color);
  return getTag(Number(res.lastInsertRowid), db);
}

export function updateTag(id: number, input: UpdateTagInput, db: Db = getDb()): TagInfo {
  if (!input || typeof input !== "object" || Array.isArray(input) || (!has(input, "name") && !has(input, "color"))) {
    throw new ApiError("invalidBody", 400);
  }
  const project = getActiveProject(db);
  const cur = getTag(id, db);
  const name = has(input, "name") ? cleanTagName(input.name) : cur.name;
  const color = has(input, "color") ? cleanColor(input.color) : cur.color;
  if (db.prepare("SELECT 1 FROM tags WHERE project_id = ? AND LOWER(name) = LOWER(?) AND id != ?").get(project.id, name, id)) {
    throw new ApiError("tagExists", 409, { name });
  }
  db.prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?").run(name, color, id);
  return getTag(id, db);
}

export function deleteTag(id: number, db: Db = getDb()): TagInfo {
  const cur = getTag(id, db);
  db.prepare("DELETE FROM tags WHERE id = ?").run(id); // les liaisons partent en cascade
  return cur;
}

/* ----------------------------- Champs personnalisés ---------------------------- */

interface RawField {
  id: number;
  entity: MetaEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string;
  required: number;
  position: number;
}

function mapField(r: RawField): CustomFieldDef {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(r.options);
    if (Array.isArray(parsed)) options = parsed.map(String);
  } catch {
    options = [];
  }
  return { id: r.id, entity: r.entity, key: r.key, label: r.label, type: r.type, options, required: r.required === 1, position: r.position };
}

export function listFields(entity?: MetaEntity, db: Db = getDb()): CustomFieldDef[] {
  const project = getActiveProject(db);
  const rows = (
    entity
      ? db.prepare("SELECT * FROM custom_fields WHERE project_id = ? AND entity = ? ORDER BY position, id").all(project.id, entity)
      : db.prepare("SELECT * FROM custom_fields WHERE project_id = ? ORDER BY entity, position, id").all(project.id)
  ) as RawField[];
  return rows.map(mapField);
}

export function getField(id: number, db: Db = getDb()): CustomFieldDef {
  const f = listFields(undefined, db).find((x) => x.id === id);
  if (!f) throw new ApiError("fieldNotFound", 404);
  return f;
}

function cleanLabel(raw: unknown): string {
  const label = String(raw ?? "").trim();
  if (!label) throw new ApiError("fieldLabelRequired", 422);
  if (label.length > FIELD_LABEL_MAX) throw new ApiError("fieldLabelTooLong", 422, { max: FIELD_LABEL_MAX });
  return label;
}

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError("invalidFieldOptions", 422, { max: FIELD_OPTIONS_MAX });
  const out: string[] = [];
  for (const o of raw) {
    const v = String(o ?? "").trim();
    if (!v || v.length > FIELD_OPTION_MAX) throw new ApiError("invalidFieldOptions", 422, { max: FIELD_OPTIONS_MAX });
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length < 1 || out.length > FIELD_OPTIONS_MAX) throw new ApiError("invalidFieldOptions", 422, { max: FIELD_OPTIONS_MAX });
  return out;
}

export function createField(input: CreateFieldInput, db: Db = getDb()): CustomFieldDef {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  if (!META_ENTITIES.includes(input.entity as MetaEntity)) throw new ApiError("invalidFieldEntity", 422);
  const entity = input.entity as MetaEntity;
  const key = String(input.key ?? "").trim();
  if (!FIELD_KEY_PATTERN.test(key)) throw new ApiError("invalidFieldKey", 422);
  const label = cleanLabel(input.label);
  if (!FIELD_TYPES.includes(input.type as FieldType)) throw new ApiError("invalidFieldType", 422);
  const type = input.type as FieldType;
  const options = type === "choice" ? cleanOptions(input.options) : [];
  const required = input.required === true ? 1 : 0;

  if (db.prepare("SELECT 1 FROM custom_fields WHERE project_id = ? AND entity = ? AND key = ?").get(project.id, entity, key)) {
    throw new ApiError("fieldKeyExists", 409, { key });
  }
  const n = (db.prepare("SELECT COUNT(*) AS c, COALESCE(MAX(position), -1) AS m FROM custom_fields WHERE project_id = ? AND entity = ?").get(project.id, entity) as { c: number; m: number });
  if (n.c >= FIELDS_PER_ENTITY_MAX) throw new ApiError("fieldLimit", 409, { max: FIELDS_PER_ENTITY_MAX });

  const res = db
    .prepare("INSERT INTO custom_fields (project_id, entity, key, label, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.id, entity, key, label, type, JSON.stringify(options), required, n.m + 1);
  return getField(Number(res.lastInsertRowid), db);
}

export function updateField(id: number, input: UpdateFieldInput, db: Db = getDb()): CustomFieldDef {
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    !["label", "options", "required", "position"].some((k) => has(input, k))
  ) {
    throw new ApiError("invalidBody", 400);
  }
  const cur = getField(id, db);
  const label = has(input, "label") ? cleanLabel(input.label) : cur.label;
  let options = cur.options;
  if (has(input, "options")) {
    if (cur.type !== "choice") throw new ApiError("invalidFieldOptions", 422, { max: FIELD_OPTIONS_MAX });
    options = cleanOptions(input.options);
  }
  const required = has(input, "required") ? (input.required === true ? 1 : 0) : cur.required ? 1 : 0;
  let position = cur.position;
  if (has(input, "position")) {
    if (!Number.isInteger(input.position) || (input.position as number) < 0 || (input.position as number) > 1000) {
      throw new ApiError("invalidBody", 400);
    }
    position = input.position as number;
  }
  db.prepare("UPDATE custom_fields SET label = ?, options = ?, required = ?, position = ? WHERE id = ?").run(
    label, JSON.stringify(options), required, position, id,
  );
  return getField(id, db);
}

export function deleteField(id: number, db: Db = getDb()): CustomFieldDef {
  const cur = getField(id, db);
  db.prepare("DELETE FROM custom_fields WHERE id = ?").run(id); // les valeurs partent en cascade
  return cur;
}

/* --------------------------- Lecture groupée (listes) -------------------------- */

function decode(f: CustomFieldDef, value: string): CustomValue {
  if (f.type === "number") return Number(value);
  if (f.type === "bool") return value === "true";
  return value;
}

/** Étiquettes de plusieurs éléments en 2 requêtes (évite le N+1 des listes). */
export function tagsFor(entity: MetaEntity, ids: number[], db: Db): Map<number, TagRef[]> {
  const out = new Map<number, TagRef[]>();
  if (ids.length === 0) return out;
  const t = TABLES[entity];
  const rows = db
    .prepare(
      `SELECT x.${t.col} AS item, g.id, g.name, g.color FROM ${t.tags} x JOIN tags g ON g.id = x.tag_id
       WHERE x.${t.col} IN (${ids.map(() => "?").join(",")}) ORDER BY LOWER(g.name)`,
    )
    .all(...ids) as { item: number; id: number; name: string; color: string }[];
  for (const r of rows) {
    const list = out.get(r.item) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.item, list);
  }
  return out;
}

export function valuesFor(entity: MetaEntity, ids: number[], db: Db): Map<number, CustomValues> {
  const out = new Map<number, CustomValues>();
  if (ids.length === 0) return out;
  const t = TABLES[entity];
  const rows = db
    .prepare(
      `SELECT x.${t.col} AS item, f.key, f.type, f.id, f.entity, f.label, f.options, f.required, f.position, x.value
       FROM ${t.values} x JOIN custom_fields f ON f.id = x.field_id
       WHERE x.${t.col} IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as (RawField & { item: number; value: string })[];
  for (const r of rows) {
    const m = out.get(r.item) ?? {};
    m[r.key] = decode(mapField(r), r.value);
    out.set(r.item, m);
  }
  return out;
}

/** Complète des lignes (réseaux ou adresses) avec leurs étiquettes et valeurs de champs. */
export function attachMeta<T extends { id: number; tags: TagRef[]; customFields: CustomValues }>(
  entity: MetaEntity,
  rows: T[],
  db: Db,
): T[] {
  const ids = rows.map((r) => r.id);
  const tags = tagsFor(entity, ids, db);
  const vals = valuesFor(entity, ids, db);
  for (const r of rows) {
    r.tags = tags.get(r.id) ?? [];
    r.customFields = vals.get(r.id) ?? {};
  }
  return rows;
}

/* --------------------------------- Écriture ---------------------------------- */

export interface MetaInput {
  tags?: unknown;
  customFields?: unknown;
}

export const hasMeta = (input: object): boolean => has(input, "tags") || has(input, "customFields");

function encode(f: CustomFieldDef, raw: unknown): string {
  if (f.type === "text") {
    const s = String(raw).trim();
    if (s.length > FIELD_TEXT_MAX) throw new ApiError("textTooLong", 422, { max: FIELD_TEXT_MAX });
    return s;
  }
  if (f.type === "number") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) throw new ApiError("invalidFieldValue", 422, { label: f.label });
    return String(n);
  }
  if (f.type === "bool") {
    if (raw === true || raw === "true") return "true";
    if (raw === false || raw === "false") return "false";
    throw new ApiError("invalidFieldValue", 422, { label: f.label });
  }
  const s = String(raw).trim();
  const hit = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
  if (!hit) throw new ApiError("invalidFieldValue", 422, { label: f.label });
  return hit;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Valide et écrit étiquettes + champs d'un réseau/adresse. À appeler DANS une transaction :
 * une erreur de validation annule alors aussi l'élément créé juste avant.
 * `creating` : les champs obligatoires doivent être renseignés (sauf `skipRequired`, ex. import CSV).
 */
export function writeMeta(
  entity: MetaEntity,
  itemId: number,
  input: MetaInput,
  db: Db,
  opts: { creating: boolean; skipRequired?: boolean },
): void {
  const project = getActiveProject(db);
  const t = TABLES[entity];

  // 1) champs personnalisés
  const defs = listFields(entity, db);
  const given = has(input, "customFields") ? input.customFields : undefined;
  if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) {
    throw new ApiError("invalidBody", 400);
  }
  const values = (given ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!defs.some((d) => d.key === key)) throw new ApiError("unknownField", 422, { key });
  }
  const upserts: [CustomFieldDef, string][] = [];
  const clears: CustomFieldDef[] = [];
  for (const d of defs) {
    if (has(values, d.key) && !isEmpty(values[d.key])) upserts.push([d, encode(d, values[d.key])]);
    else if (has(values, d.key)) {
      if (d.required && !opts.skipRequired) throw new ApiError("fieldRequired", 422, { label: d.label });
      clears.push(d);
    } else if (opts.creating && d.required && !opts.skipRequired) {
      throw new ApiError("fieldRequired", 422, { label: d.label });
    }
  }

  // 2) étiquettes (remplacement complet)
  let tagIds: number[] | undefined;
  if (has(input, "tags")) {
    if (!Array.isArray(input.tags)) throw new ApiError("invalidBody", 400);
    const names: string[] = [];
    for (const raw of input.tags) {
      const n = cleanTagName(raw);
      if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    }
    if (names.length > TAGS_PER_ITEM_MAX) throw new ApiError("tooManyTags", 422, { max: TAGS_PER_ITEM_MAX });
    tagIds = [];
    for (const n of names) {
      const hit = db.prepare("SELECT id FROM tags WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(project.id, n) as { id: number } | undefined;
      if (hit) tagIds.push(hit.id);
      else {
        if (tagCount(db, project.id) >= TAGS_PER_PROJECT_MAX) throw new ApiError("tagLimit", 409, { max: TAGS_PER_PROJECT_MAX });
        tagIds.push(Number(db.prepare("INSERT INTO tags (project_id, name, color) VALUES (?, ?, 'gray')").run(project.id, n).lastInsertRowid));
      }
    }
  }

  // 3) écriture
  for (const [d, v] of upserts) {
    db.prepare(`INSERT INTO ${t.values} (${t.col}, field_id, value) VALUES (?, ?, ?)
                ON CONFLICT (${t.col}, field_id) DO UPDATE SET value = excluded.value`).run(itemId, d.id, v);
  }
  for (const d of clears) db.prepare(`DELETE FROM ${t.values} WHERE ${t.col} = ? AND field_id = ?`).run(itemId, d.id);
  if (tagIds) {
    db.prepare(`DELETE FROM ${t.tags} WHERE ${t.col} = ?`).run(itemId);
    for (const id of tagIds) db.prepare(`INSERT INTO ${t.tags} (${t.col}, tag_id) VALUES (?, ?)`).run(itemId, id);
  }
}

/** Identifiant d'étiquette d'après son nom (filtre ?tag=), -1 si inconnue : aucun résultat. */
export function tagIdByName(name: string, db: Db): number {
  const project = getActiveProject(db);
  const r = db.prepare("SELECT id FROM tags WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(project.id, name.trim()) as { id: number } | undefined;
  return r?.id ?? -1;
}
