/** Mode TP : types et constantes, sans accès à la base (importables côté navigateur). */

export const TP_KINDS = ["vlsm", "subnet"] as const;
export type TpKind = (typeof TP_KINDS)[number];
export const isTpKind = (v: unknown): v is TpKind => typeof v === "string" && (TP_KINDS as readonly string[]).includes(v);

/** Champs que l'étudiant peut avoir à calculer pour chaque adresse d'un exercice « sous-réseau ». */
export const SUBNET_FIELDS = ["network", "broadcast", "firstHost", "lastHost", "hosts", "mask"] as const;
export type SubnetField = (typeof SUBNET_FIELDS)[number];
export const DEFAULT_SUBNET_FIELDS: SubnetField[] = ["network", "broadcast", "firstHost", "lastHost", "hosts"];

export const TP_TITLE_MAX = 100;
export const TP_DESCRIPTION_MAX = 2000;
export const TP_MAX_NEEDS = 12;
export const TP_MAX_HOSTS = 65534;
export const TP_MAX_QUESTIONS = 20;
export const TP_DEFAULT_QUESTIONS = 5;
export const TP_MAX_ATTEMPTS = 10;
export const TP_DEFAULT_ATTEMPTS = 3;
export const TP_NEED_NAME_MAX = 40;
export const TP_ANSWER_MAX = 100;

export interface VlsmConfig {
  /** Bloc parent IPv4 (adresse réseau). */
  parent: string;
  needs: { name: string; hosts: number }[];
}

export interface SubnetConfig {
  count: number;
  fields: SubnetField[];
}

export type TpConfig = VlsmConfig | SubnetConfig;

/** Une question d'un exercice « sous-réseau » : une adresse d'hôte avec son préfixe (ex. 192.168.37.141/27). */
export interface SubnetQuestion {
  key: string;
  cidr: string;
}

/** VLSM : réponses indexées par le numéro du besoin (« 0 », « 1 »…). Sous-réseau : question -> champ -> valeur. */
export type VlsmAnswers = Record<string, string>;
export type SubnetAnswers = Record<string, Record<string, string>>;
export type TpAnswers = VlsmAnswers | SubnetAnswers;

export type GradeCode = "ok" | "missing" | "invalid" | "notNetwork" | "outside" | "overlap" | "tooSmall" | "oversized" | "wrong";

export interface GradeItem {
  /** Besoin (« 0 »…) ou question (« q1 »…). */
  key: string;
  /** Sous-réseau : le champ demandé. */
  field?: SubnetField;
  /** VLSM : nom du besoin. Sous-réseau : adresse de la question. */
  label: string;
  points: number;
  max: number;
  code: GradeCode;
  /** Pour « oversized » : préfixe donné et préfixe optimal. */
  params?: Record<string, string | number>;
  /** Bonne réponse : jamais envoyée à un étudiant tant que la solution n'est pas dévoilée. */
  expected?: string;
}

export interface GradeResult {
  /** Note sur 100. */
  score: number;
  items: GradeItem[];
}

export interface TpExerciseRow {
  id: number;
  title: string;
  description: string;
  kind: TpKind;
  config: TpConfig;
  maxAttempts: number;
  /** ISO 8601 UTC ; null = pas de date limite. */
  dueAt: string | null;
  published: boolean;
  showSolution: boolean;
  /** Classe à laquelle l'exercice est réservé ; null = tous les étudiants. */
  classId: number | null;
  className: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface TpListItem {
  id: number;
  title: string;
  kind: TpKind;
  published: boolean;
  classId: number | null;
  className: string | null;
  dueAt: string | null;
  maxAttempts: number;
  closed: boolean;
  /** Tentatives du compte courant et sa meilleure note. */
  attemptsUsed: number;
  best: number | null;
  /** Enseignants seulement : nombre d'étudiants et de remises. */
  students: number | null;
  submissions: number | null;
}

export interface TpSubmissionView {
  attempt: number;
  score: number;
  submittedAt: string;
  answers: TpAnswers;
  result: GradeResult;
}

export interface TpStudentDetail {
  exercise: Omit<TpExerciseRow, "config" | "createdByName">;
  /** Énoncé : pour VLSM, le bloc et les besoins ; pour « sous-réseau », les questions propres à ce compte. */
  statement: { vlsm?: VlsmConfig; questions?: SubnetQuestion[]; fields?: SubnetField[] };
  submissions: TpSubmissionView[];
  attemptsLeft: number;
  best: number | null;
  closed: boolean;
  /** La solution est montrée (enseignant, ou tentatives épuisées / date passée avec l'option activée). */
  revealed: boolean;
  /** VLSM : un CIDR par besoin ; sous-réseau : rien (les bonnes réponses figurent dans les éléments corrigés). */
  solution: string[] | null;
}

export interface TpClassMember {
  id: number;
  username: string;
  displayName: string;
}

export interface TpClassRow {
  id: number;
  name: string;
  members: TpClassMember[];
  exerciseCount: number;
}

export const TP_CLASS_NAME_MAX = 60;
export const TP_CLASS_MAX_MEMBERS = 500;

export interface TpResultRow {
  userId: number | null;
  username: string;
  attempts: number;
  best: number;
  last: number;
  lastAt: string;
}

export interface TpTeacherDetail {
  exercise: TpExerciseRow;
  statement: TpStudentDetail["statement"];
  /** VLSM : solution de référence (un CIDR par besoin). */
  solution: string[] | null;
  results: TpResultRow[];
}
