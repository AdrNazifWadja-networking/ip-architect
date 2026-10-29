/**
 * Mode TP : exercices corrigés automatiquement. L'enseignant (rôle éditeur ou plus) crée et publie des exercices ; l'étudiant
 * (rôle lecteur) remet ses réponses, reçoit sa note et un commentaire par élément. La correction est faite par le moteur de
 * calcul de l'application (src/lib/tp/grade.ts) : aucune réponse n'est saisie à la main par l'enseignant.
 *
 * Règles : un nombre de tentatives limité (la meilleure note compte), une date limite facultative, et la bonne réponse n'est
 * jamais envoyée à un étudiant tant qu'elle n'est pas dévoilée (option de l'exercice, tentatives épuisées ou date passée).
 */
import { getDb, type Db } from "./index";
import { atLeast } from "../auth/roles";
import { ApiError, type SessionUser } from "../types";
import {
  checkSubnetConfig,
  checkVlsmConfig,
  cleanAnswers,
  generateSubnetQuestions,
  gradeSubnet,
  gradeVlsm,
  vlsmSolution,
} from "../tp/grade";
import {
  TP_DEFAULT_ATTEMPTS,
  TP_DESCRIPTION_MAX,
  TP_MAX_ATTEMPTS,
  TP_TITLE_MAX,
  isTpKind,
  type GradeResult,
  type SubnetAnswers,
  type SubnetConfig,
  type TpAnswers,
  type TpConfig,
  type TpExerciseRow,
  type TpKind,
  type TpListItem,
  type TpResultRow,
  type TpStudentDetail,
  type TpSubmissionView,
  type TpTeacherDetail,
  type VlsmAnswers,
  type VlsmConfig,
} from "../tp/types";

interface Raw {
  id: number;
  title: string;
  description: string;
  kind: string;
  config: string;
  max_attempts: number;
  due_at: string | null;
  published: number;
  show_solution: number;
  class_id: number | null;
  class_name: string | null;
  created_by_name: string | null;
  created_at: string;
}

const COLS =
  "id, title, description, kind, config, max_attempts, due_at, published, show_solution, class_id, (SELECT name FROM tp_classes c WHERE c.id = tp_exercises.class_id) AS class_name, created_by_name, created_at";

function map(r: Raw): TpExerciseRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    kind: r.kind as TpKind,
    config: JSON.parse(r.config) as TpConfig,
    maxAttempts: r.max_attempts,
    dueAt: r.due_at,
    published: r.published === 1,
    showSolution: r.show_solution === 1,
    classId: r.class_id,
    className: r.class_name,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

export function getExercise(id: number, db: Db = getDb()): TpExerciseRow {
  const r = db.prepare(`SELECT ${COLS} FROM tp_exercises WHERE id = ?`).get(id) as Raw | undefined;
  if (!r) throw new ApiError("tpNotFound", 404);
  return map(r);
}

/**
 * Un étudiant ne voit que les exercices publiés et, si l'exercice est réservé à une classe, seulement s'il en est membre
 * (« introuvable » sinon : on ne révèle ni les brouillons ni les exercices des autres classes).
 */
function visibleTo(ex: TpExerciseRow, user: SessionUser | null, db: Db): boolean {
  if (user === null || atLeast(user.role, "editor")) return true;
  if (!ex.published) return false;
  if (ex.classId === null) return true;
  return !!db.prepare("SELECT 1 FROM tp_class_members WHERE class_id = ? AND user_id = ?").get(ex.classId, user.id);
}

export const isTeacher = (user: SessionUser | null) => user === null || atLeast(user.role, "editor");

const isClosed = (ex: { dueAt: string | null }, now: Date) => ex.dueAt !== null && now.getTime() > Date.parse(ex.dueAt);

/* ------------------------------ Création et modification ------------------------------ */

export interface TpInput {
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  config?: unknown;
  maxAttempts?: unknown;
  dueAt?: unknown;
  published?: unknown;
  showSolution?: unknown;
  /** Identifiant de classe, ou null pour tous les étudiants. */
  classId?: unknown;
}

function cleanClass(db: Db, v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || !db.prepare("SELECT 1 FROM tp_classes WHERE id = ?").get(v)) throw new ApiError("tpClassNotFound", 404);
  return v;
}

function cleanTitle(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim() : "";
  if (!s) throw new ApiError("tpTitleRequired", 422);
  if (s.length > TP_TITLE_MAX) throw new ApiError("tpTitleTooLong", 422, { max: TP_TITLE_MAX });
  return s;
}

function cleanDescription(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ApiError("invalidBody", 400);
  const s = v.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (s.length > TP_DESCRIPTION_MAX) throw new ApiError("tpDescriptionTooLong", 422, { max: TP_DESCRIPTION_MAX });
  return s;
}

function cleanAttempts(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > TP_MAX_ATTEMPTS) throw new ApiError("tpAttemptsInvalid", 422, { max: TP_MAX_ATTEMPTS });
  return v;
}

function cleanDue(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new ApiError("tpDueInvalid", 422);
  return new Date(v).toISOString();
}

function cleanBool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new ApiError("invalidBody", 400);
  return v;
}

function cleanConfig(kind: TpKind, raw: unknown): TpConfig {
  const c = kind === "vlsm" ? checkVlsmConfig(raw) : checkSubnetConfig(raw);
  if (!c.ok) throw new ApiError(c.code, 422);
  return c.config;
}

export function createExercise(input: TpInput, user: SessionUser | null, db: Db = getDb(), now: Date = new Date()): TpExerciseRow {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const title = cleanTitle(input.title);
  if (!isTpKind(input.kind)) throw new ApiError("tpKindInvalid", 422);
  const config = cleanConfig(input.kind, input.kind === "subnet" && input.config === undefined ? {} : input.config);
  const id = Number(
    db
      .prepare(
        `INSERT INTO tp_exercises (title, description, kind, config, max_attempts, due_at, published, show_solution, class_id, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        cleanDescription(input.description),
        input.kind,
        JSON.stringify(config),
        input.maxAttempts === undefined ? TP_DEFAULT_ATTEMPTS : cleanAttempts(input.maxAttempts),
        input.dueAt === undefined ? null : cleanDue(input.dueAt),
        input.published === undefined ? 0 : cleanBool(input.published) ? 1 : 0,
        input.showSolution === undefined ? 0 : cleanBool(input.showSolution) ? 1 : 0,
        input.classId === undefined ? null : cleanClass(db, input.classId),
        user?.id ?? null,
        user?.username ?? null,
        now.toISOString(),
      ).lastInsertRowid,
  );
  return getExercise(id, db);
}

export function updateExercise(id: number, input: TpInput, db: Db = getDb()): TpExerciseRow {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const cur = getExercise(id, db);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (input.kind !== undefined && input.kind !== cur.kind) throw new ApiError("tpKindLocked", 422);
  if (input.title !== undefined) set("title", cleanTitle(input.title));
  if (input.description !== undefined) set("description", cleanDescription(input.description));
  if (input.maxAttempts !== undefined) set("max_attempts", cleanAttempts(input.maxAttempts));
  if (input.dueAt !== undefined) set("due_at", cleanDue(input.dueAt));
  if (input.published !== undefined) set("published", cleanBool(input.published) ? 1 : 0);
  if (input.showSolution !== undefined) set("show_solution", cleanBool(input.showSolution) ? 1 : 0);
  if (input.classId !== undefined) set("class_id", cleanClass(db, input.classId));
  if (input.config !== undefined) {
    const next = cleanConfig(cur.kind, input.config);
    if (JSON.stringify(next) !== JSON.stringify(cur.config)) {
      // changer l'énoncé après des remises rendrait les notes incomparables
      const n = (db.prepare("SELECT COUNT(*) AS c FROM tp_submissions WHERE exercise_id = ?").get(id) as { c: number }).c;
      if (n > 0) throw new ApiError("tpHasSubmissions", 409);
      set("config", JSON.stringify(next));
    }
  }
  if (sets.length > 0) db.prepare(`UPDATE tp_exercises SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getExercise(id, db);
}

/**
 * Copie un exercice (énoncé, réglages, classe) en BROUILLON, sans remises ni date limite : pratique pour la promotion suivante
 * ou une variante. Le titre reçoit « (2) ».
 */
export function duplicateExercise(id: number, user: SessionUser | null, db: Db = getDb(), now: Date = new Date()): TpExerciseRow {
  const src = getExercise(id, db);
  const suffix = " (2)";
  const title = src.title.length + suffix.length > TP_TITLE_MAX ? src.title.slice(0, TP_TITLE_MAX - suffix.length) + suffix : src.title + suffix;
  return createExercise(
    { title, description: src.description, kind: src.kind, config: src.config, maxAttempts: src.maxAttempts, dueAt: null, published: false, showSolution: src.showSolution, classId: src.classId },
    user,
    db,
    now,
  );
}

export function deleteExercise(id: number, db: Db = getDb()): void {
  getExercise(id, db);
  db.prepare("DELETE FROM tp_exercises WHERE id = ?").run(id);
}

/* ------------------------------ Consultation ------------------------------ */

interface SubRaw {
  attempt: number;
  score: number;
  submitted_at: string;
  answers: string;
  result: string;
}

function ownSubmissions(exId: number, user: SessionUser | null, db: Db): SubRaw[] {
  if (!user) return [];
  return db
    .prepare("SELECT attempt, score, submitted_at, answers, result FROM tp_submissions WHERE exercise_id = ? AND user_id = ? ORDER BY attempt")
    .all(exId, user.id) as unknown as SubRaw[];
}

/** Retire la bonne réponse d'un résultat (elle n'est jamais envoyée à un étudiant avant d'être dévoilée). */
export function hideExpected(r: GradeResult): GradeResult {
  return { score: r.score, items: r.items.map(({ expected: _e, ...rest }) => rest) };
}

export function listExercises(user: SessionUser | null, db: Db = getDb(), now: Date = new Date()): TpListItem[] {
  const teacher = isTeacher(user);
  const rows = (
    teacher
      ? db.prepare(`SELECT ${COLS} FROM tp_exercises ORDER BY id DESC`).all()
      : db
          .prepare(`SELECT ${COLS} FROM tp_exercises WHERE published = 1 AND (class_id IS NULL OR class_id IN (SELECT class_id FROM tp_class_members WHERE user_id = ?)) ORDER BY id DESC`)
          .all(user!.id)
  ) as unknown as Raw[];
  const own = user
    ? (db
        .prepare("SELECT exercise_id AS id, COUNT(*) AS n, MAX(score) AS best FROM tp_submissions WHERE user_id = ? GROUP BY exercise_id")
        .all(user.id) as unknown as { id: number; n: number; best: number }[])
    : [];
  const all = teacher
    ? (db
        .prepare("SELECT exercise_id AS id, COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, username)) AS s FROM tp_submissions GROUP BY exercise_id")
        .all() as unknown as { id: number; n: number; s: number }[])
    : [];
  return rows.map((r) => {
    const ex = map(r);
    const mine = own.find((o) => o.id === ex.id);
    const tot = all.find((o) => o.id === ex.id);
    return {
      id: ex.id,
      title: ex.title,
      kind: ex.kind,
      published: ex.published,
      classId: ex.classId,
      className: ex.className,
      dueAt: ex.dueAt,
      maxAttempts: ex.maxAttempts,
      closed: isClosed(ex, now),
      attemptsUsed: mine?.n ?? 0,
      best: mine ? mine.best : null,
      students: teacher ? (tot?.s ?? 0) : null,
      submissions: teacher ? (tot?.n ?? 0) : null,
    };
  });
}

function statementFor(ex: TpExerciseRow, user: SessionUser | null): TpStudentDetail["statement"] {
  if (ex.kind === "vlsm") return { vlsm: ex.config as VlsmConfig };
  const c = ex.config as SubnetConfig;
  return { questions: generateSubnetQuestions(`${ex.id}:${user?.id ?? 0}`, c.count), fields: c.fields };
}

/** Vue d'un exercice pour qui le passe (un enseignant peut aussi le passer en aperçu). */
export function studentDetail(id: number, user: SessionUser | null, db: Db = getDb(), now: Date = new Date()): TpStudentDetail {
  const ex = getExercise(id, db);
  if (!visibleTo(ex, user, db)) throw new ApiError("tpNotFound", 404);
  const subs = ownSubmissions(id, user, db);
  const closed = isClosed(ex, now);
  const attemptsLeft = Math.max(0, ex.maxAttempts - subs.length);
  const teacher = isTeacher(user);
  const revealed = teacher || (ex.showSolution && (attemptsLeft === 0 || closed));
  const submissions: TpSubmissionView[] = subs.map((s) => {
    const result = JSON.parse(s.result) as GradeResult;
    return { attempt: s.attempt, score: s.score, submittedAt: s.submitted_at, answers: JSON.parse(s.answers) as TpAnswers, result: revealed ? result : hideExpected(result) };
  });
  const { config: _c, createdByName: _n, ...pub } = ex;
  return {
    exercise: pub,
    statement: statementFor(ex, user),
    submissions,
    attemptsLeft,
    best: subs.length ? Math.max(...subs.map((s) => s.score)) : null,
    closed,
    revealed,
    solution: revealed && ex.kind === "vlsm" ? (vlsmSolution(ex.config as VlsmConfig).filter((c): c is string => c !== null)) : null,
  };
}

export function listResults(id: number, db: Db = getDb()): TpResultRow[] {
  getExercise(id, db);
  const rows = db
    .prepare("SELECT user_id, username, attempt, score, submitted_at FROM tp_submissions WHERE exercise_id = ? ORDER BY username COLLATE NOCASE, attempt")
    .all(id) as unknown as { user_id: number | null; username: string; attempt: number; score: number; submitted_at: string }[];
  const by = new Map<string, TpResultRow>();
  for (const r of rows) {
    const key = r.user_id !== null ? `u${r.user_id}` : `n${r.username}`;
    const cur = by.get(key);
    // les lignes arrivent par tentative croissante : la dernière écrase « last »
    by.set(key, { userId: r.user_id, username: r.username, attempts: (cur?.attempts ?? 0) + 1, best: Math.max(cur?.best ?? 0, r.score), last: r.score, lastAt: r.submitted_at });
  }
  return [...by.values()];
}

export function teacherDetail(id: number, user: SessionUser | null, db: Db = getDb()): TpTeacherDetail {
  const ex = getExercise(id, db);
  return {
    exercise: ex,
    statement: statementFor(ex, user),
    solution: ex.kind === "vlsm" ? vlsmSolution(ex.config as VlsmConfig).filter((c): c is string => c !== null) : null,
    results: listResults(id, db),
  };
}

/* ------------------------------ Remise ------------------------------ */

export interface SubmitOutcome {
  attempt: number;
  score: number;
  result: GradeResult;
  attemptsLeft: number;
  best: number;
  revealed: boolean;
  solution: string[] | null;
}

export function submitAnswers(id: number, user: SessionUser | null, rawAnswers: unknown, db: Db = getDb(), now: Date = new Date()): SubmitOutcome {
  const ex = getExercise(id, db);
  if (!visibleTo(ex, user, db)) throw new ApiError("tpNotFound", 404);
  // sans compte, il n'y a personne à qui attribuer la note
  if (!user) throw new ApiError("tpAccountRequired", 403);
  if (isClosed(ex, now)) throw new ApiError("tpClosed", 409);
  const answers = cleanAnswers(ex.kind, rawAnswers);
  if (!answers) throw new ApiError("invalidBody", 400);

  const result = ((): GradeResult => {
    if (ex.kind === "vlsm") return gradeVlsm(ex.config as VlsmConfig, answers as VlsmAnswers, true);
    const c = ex.config as SubnetConfig;
    return gradeSubnet(generateSubnetQuestions(`${ex.id}:${user.id}`, c.count), c.fields, answers as SubnetAnswers, true);
  })();

  const attempt = db.transaction(() => {
    const used = (db.prepare("SELECT COUNT(*) AS c FROM tp_submissions WHERE exercise_id = ? AND user_id = ?").get(id, user.id) as { c: number }).c;
    if (used >= ex.maxAttempts) throw new ApiError("tpNoAttempts", 409);
    db.prepare("INSERT INTO tp_submissions (exercise_id, user_id, username, attempt, answers, score, result, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      user.id,
      user.username,
      used + 1,
      JSON.stringify(answers),
      result.score,
      JSON.stringify(result),
      now.toISOString(),
    );
    return used + 1;
  })();

  const attemptsLeft = Math.max(0, ex.maxAttempts - attempt);
  const best = (db.prepare("SELECT MAX(score) AS m FROM tp_submissions WHERE exercise_id = ? AND user_id = ?").get(id, user.id) as { m: number }).m;
  const revealed = isTeacher(user) || (ex.showSolution && attemptsLeft === 0);
  return {
    attempt,
    score: result.score,
    result: revealed ? result : hideExpected(result),
    attemptsLeft,
    best,
    revealed,
    solution: revealed && ex.kind === "vlsm" ? vlsmSolution(ex.config as VlsmConfig).filter((c): c is string => c !== null) : null,
  };
}
