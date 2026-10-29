/**
 * Code d'installation : tant qu'aucun compte n'existe, l'application est ouverte, et la première personne qui l'atteint pourrait créer
 * le compte administrateur. En production (NODE_ENV=production, donc Docker et `npm start`), cette ouverture est donc fermée :
 *  - toutes les routes et pages renvoient vers la création du premier compte ;
 *  - cette création exige un code, affiché dans la console du serveur au démarrage (ou fixé par IP_ARCHITECT_SETUP_CODE).
 * En développement (`npm run dev`), rien ne change. IP_ARCHITECT_REQUIRE_SETUP_CODE=1 / 0 force l'un ou l'autre.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, type Db } from "../db";
import { countUsers } from "../db/users";
import { getThrottle } from "./throttle";
import { ApiError } from "../types";

export const SETUP_CODE_SETTING = "setup_code";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function setupRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.IP_ARCHITECT_REQUIRE_SETUP_CODE === "1") return true;
  if (env.IP_ARCHITECT_REQUIRE_SETUP_CODE === "0") return false;
  return env.NODE_ENV === "production";
}

/** L'application attend son premier compte ET exige le code d'installation. */
export const setupActive = (db: Db = getDb(), env: NodeJS.ProcessEnv = process.env): boolean => setupRequired(env) && countUsers(db) === 0;

/** Le code courant : variable d'environnement, sinon un code aléatoire (XXXX-XXXX-XXXX) créé une fois et conservé en base. */
export function getSetupCode(db: Db = getDb(), env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.IP_ARCHITECT_SETUP_CODE?.trim();
  if (fixed) return fixed;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETUP_CODE_SETTING) as { value: string } | undefined;
  if (row) return row.value;
  const bytes = randomBytes(12);
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SETUP_CODE_SETTING, code);
  return code;
}

export const clearSetupCode = (db: Db = getDb()): void => { db.prepare("DELETE FROM settings WHERE key = ?").run(SETUP_CODE_SETTING); };

const digest = (s: string): Buffer => createHash("sha256").update(s.trim().toUpperCase()).digest();

/** Vérifie le code fourni (comparaison à temps constant, 5 essais par 15 minutes pour tout le serveur). Lève 403 ou 429. */
export function assertSetupCode(given: unknown, db: Db = getDb(), env: NodeJS.ProcessEnv = process.env): void {
  if (!setupRequired(env)) return;
  const throttle = getThrottle();
  const wait = throttle.remaining("setup");
  if (wait > 0) throw new ApiError("tooManyAttempts", 429, { minutes: Math.ceil(wait / 60_000) });
  const ok = typeof given === "string" && given.length <= 64 && timingSafeEqual(digest(given), digest(getSetupCode(db, env)));
  if (!ok) {
    throttle.fail("setup");
    throw new ApiError("setupCodeInvalid", 403);
  }
  throttle.success("setup");
}
