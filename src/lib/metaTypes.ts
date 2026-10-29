/** Constantes et types partagés (serveur + interface) pour les étiquettes et les champs personnalisés. */

export const TAG_COLORS = ["gray", "blue", "green", "amber", "red", "purple"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const META_ENTITIES = ["network", "address"] as const;
export type MetaEntity = (typeof META_ENTITIES)[number];

export const FIELD_TYPES = ["text", "number", "choice", "bool"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const TAG_NAME_MAX = 30;
export const TAGS_PER_PROJECT_MAX = 100;
export const TAGS_PER_ITEM_MAX = 10;
export const FIELD_LABEL_MAX = 60;
export const FIELDS_PER_ENTITY_MAX = 20;
export const FIELD_OPTIONS_MAX = 20;
export const FIELD_OPTION_MAX = 40;
export const FIELD_TEXT_MAX = 200;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

export interface TagInfo {
  id: number;
  name: string;
  color: TagColor;
  networkCount: number;
  addressCount: number;
}

export interface CustomFieldDef {
  id: number;
  entity: MetaEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  position: number;
}

export interface CreateTagInput {
  name: string;
  color?: string;
}
export interface UpdateTagInput {
  name?: string;
  color?: string;
}
export interface CreateFieldInput {
  entity: string;
  key: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
}
export interface UpdateFieldInput {
  label?: string;
  options?: string[];
  required?: boolean;
  position?: number;
}
