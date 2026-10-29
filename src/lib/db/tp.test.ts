import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { createUser } from "./users";
import {
  createExercise,
  deleteExercise,
  hideExpected,
  listExercises,
  listResults,
  studentDetail,
  submitAnswers,
  teacherDetail,
  updateExercise,
} from "./tp";
import { vlsmSolution } from "../tp/grade";
import { ApiError, type SessionUser } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const PW = "Correct-horse-42";
async function users(db: Db) {
  const mk = async (username: string, role: "viewer" | "editor" | "admin"): Promise<SessionUser> => {
    const u = await createUser({ username, displayName: username, password: PW, role }, db);
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, projectScope: "all" };
  };
  return { prof: await mk("prof", "editor"), a: await mk("alice", "viewer"), b: await mk("bernard", "viewer") };
}

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

const VLSM = { title: "TP1", kind: "vlsm", maxAttempts: 2, config: { parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 100 }, { name: "B", hosts: 20 }] } };
const SOL = vlsmSolution(VLSM.config as never) as string[];
const ans = { "0": SOL[0], "1": SOL[1] };
const NOW = new Date("2026-10-24T10:00:00Z");

test("tp : un étudiant ne voit que les exercices publiés ; le brouillon est « introuvable »", async () => {
  const db = freshDb();
  const { prof, a } = await users(db);
  const ex = createExercise(VLSM, prof, db, NOW);
  assert.equal(ex.published, false);
  assert.equal(listExercises(a, db, NOW).length, 0);
  assert.equal(listExercises(prof, db, NOW).length, 1);
  assert.equal(code(() => studentDetail(ex.id, a, db, NOW)), "tpNotFound");
  assert.equal(code(() => submitAnswers(ex.id, a, ans, db, NOW)), "tpNotFound");
  updateExercise(ex.id, { published: true }, db);
  assert.equal(listExercises(a, db, NOW).length, 1);
  assert.equal(studentDetail(ex.id, a, db, NOW).attemptsLeft, 2);
});

test("tp : tentatives limitées, meilleure note conservée, historique, solution cachée sauf option", async () => {
  const db = freshDb();
  const { prof, a } = await users(db);
  const ex = createExercise({ ...VLSM, published: true }, prof, db, NOW);
  const r1 = submitAnswers(ex.id, a, { "0": SOL[0], "1": "" }, db, NOW);
  assert.equal(r1.score, 50);
  assert.equal(r1.attemptsLeft, 1);
  assert.ok(r1.result.items.every((i) => i.expected === undefined), "bonne réponse masquée");
  const r2 = submitAnswers(ex.id, a, { "0": "10.0.0.0/30", "1": "" }, db, NOW);
  assert.equal(r2.score, 0);
  assert.equal(r2.best, 50, "la meilleure note reste 50");
  assert.equal(r2.revealed, false);
  assert.equal(r2.solution, null);
  assert.equal(code(() => submitAnswers(ex.id, a, ans, db, NOW)), "tpNoAttempts");
  const d = studentDetail(ex.id, a, db, NOW);
  assert.deepEqual(d.submissions.map((s) => s.score), [50, 0]);
  assert.equal(d.best, 50);
  assert.equal(JSON.stringify(d).includes(SOL[0]) , d.submissions.some((s) => JSON.stringify(s.answers).includes(SOL[0])), "la solution n'apparaît que dans les propres réponses de l'étudiant");

  const shown = createExercise({ ...VLSM, published: true, showSolution: true }, prof, db, NOW);
  submitAnswers(shown.id, a, { "0": "x" }, db, NOW);
  const last = submitAnswers(shown.id, a, { "0": "x" }, db, NOW);
  assert.equal(last.revealed, true);
  assert.deepEqual(last.solution, SOL);
  assert.equal(last.result.items[0].expected, SOL[0]);
});

test("tp : date limite : remise refusée après, solution dévoilée avec l'option", async () => {
  const db = freshDb();
  const { prof, a } = await users(db);
  const ex = createExercise({ ...VLSM, published: true, showSolution: true, dueAt: "2026-10-24T12:00:00Z" }, prof, db, NOW);
  assert.equal(submitAnswers(ex.id, a, ans, db, NOW).score, 100);
  const later = new Date("2026-10-24T12:00:01Z");
  assert.equal(code(() => submitAnswers(ex.id, a, ans, db, later)), "tpClosed");
  const d = studentDetail(ex.id, a, db, later);
  assert.equal(d.closed, true);
  assert.equal(d.revealed, true);
  assert.deepEqual(d.solution, SOL);
  assert.equal(listExercises(a, db, later)[0].closed, true);
  // pile à la date limite : encore ouvert
  assert.equal(studentDetail(ex.id, a, db, new Date("2026-10-24T12:00:00Z")).closed, false);
});

test("tp : énoncé figé dès qu'il y a une remise ; type fixe ; validations", async () => {
  const db = freshDb();
  const { prof, a } = await users(db);
  const ex = createExercise({ ...VLSM, published: true }, prof, db, NOW);
  updateExercise(ex.id, { config: { parent: "10.0.0.0/23", needs: VLSM.config.needs } }, db); // encore libre
  submitAnswers(ex.id, a, ans, db, NOW);
  assert.equal(code(() => updateExercise(ex.id, { config: VLSM.config }, db)), "tpHasSubmissions");
  assert.equal(updateExercise(ex.id, { title: "Autre", maxAttempts: 5 }, db).title, "Autre");
  assert.equal(code(() => updateExercise(ex.id, { kind: "subnet" }, db)), "tpKindLocked");
  assert.equal(code(() => updateExercise(999, { title: "x" }, db)), "tpNotFound");
  assert.equal(code(() => createExercise({ ...VLSM, title: "" }, prof, db)), "tpTitleRequired");
  assert.equal(code(() => createExercise({ ...VLSM, kind: "?" }, prof, db)), "tpKindInvalid");
  assert.equal(code(() => createExercise({ ...VLSM, description: 5 }, prof, db)), "invalidBody");
  assert.equal(code(() => createExercise({ ...VLSM, description: "x".repeat(2001) }, prof, db)), "tpDescriptionTooLong");
  assert.equal(code(() => createExercise({ ...VLSM, published: "oui" }, prof, db)), "invalidBody");
  assert.equal(code(() => createExercise(null as never, prof, db)), "invalidBody");
});

test("tp : sous-réseaux : chaque étudiant a ses questions (stables), la note vient du moteur", async () => {
  const db = freshDb();
  const { prof, a, b } = await users(db);
  const ex = createExercise({ title: "Calculs", kind: "subnet", published: true, config: { count: 3, fields: ["network", "hosts"] } }, prof, db, NOW);
  const qa = studentDetail(ex.id, a, db, NOW).statement.questions!;
  const qb = studentDetail(ex.id, b, db, NOW).statement.questions!;
  assert.deepEqual(qa, studentDetail(ex.id, a, db, NOW).statement.questions);
  assert.notDeepEqual(qa, qb);
  assert.equal(code(() => submitAnswers(ex.id, null, {}, db, NOW)), "tpAccountRequired");
  const r = submitAnswers(ex.id, a, Object.fromEntries(qa.map((q) => [q.key, { network: "0.0.0.0", hosts: "1" }])), db, NOW);
  assert.equal(r.score, 0);
  assert.equal(r.result.items.length, 6);
});

test("tp : résultats par étudiant ; un compte supprimé garde ses notes ; supprimer l'exercice supprime les remises", async () => {
  const db = freshDb();
  const { prof, a, b } = await users(db);
  const ex = createExercise({ ...VLSM, published: true, maxAttempts: 3 }, prof, db, NOW);
  submitAnswers(ex.id, a, { "0": "x" }, db, NOW);
  submitAnswers(ex.id, a, ans, db, new Date("2026-10-24T11:00:00Z"));
  submitAnswers(ex.id, b, { "0": SOL[0] }, db, NOW);
  const res = listResults(ex.id, db);
  assert.deepEqual(res.map((r) => [r.username, r.attempts, r.best, r.last]), [["alice", 2, 100, 100], ["bernard", 1, 50, 50]]);
  const t = teacherDetail(ex.id, prof, db);
  assert.deepEqual(t.solution, SOL);
  assert.equal(listExercises(prof, db, NOW)[0].students, 2);
  assert.equal(listExercises(prof, db, NOW)[0].submissions, 3);
  assert.equal(listExercises(a, db, NOW)[0].students, null, "un étudiant ne voit pas les effectifs");
  db.prepare("DELETE FROM users WHERE id = ?").run(b.id);
  const after = listResults(ex.id, db);
  assert.equal(after.length, 2);
  assert.equal(after.find((r) => r.username === "bernard")!.userId, null);
  deleteExercise(ex.id, db);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM tp_submissions").get() as { c: number }).c, 0);
  assert.equal(code(() => deleteExercise(ex.id, db)), "tpNotFound");
});

test("tp : hideExpected retire seulement la bonne réponse", () => {
  const r = hideExpected({ score: 50, items: [{ key: "0", label: "A", points: 50, max: 100, code: "ok", expected: "10.0.0.0/25" }] });
  assert.deepEqual(r, { score: 50, items: [{ key: "0", label: "A", points: 50, max: 100, code: "ok" }] });
});
