/**
 * Paramètres de l'application (table « settings », clé/valeur) : nom de l'organisation, conservation du journal d'audit,
 * seuils de supervision. Plus des informations sur la base et la sauvegarde.
 */
import { AI_SECRET_SETTING } from "./aisettings";
import { SSO_SECRET_SETTINGS } from "./ssosettings";
import { SMTP_SECRET_SETTING } from "./signupsettings";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH, getDb, type Db } from "./index";
import { getThresholds, setThresholds, type Thresholds } from "./monitoring";
import {
  AUDIT_DEFAULT_RETENTION_DAYS,
  AUDIT_MAX_RETENTION_DAYS,
  AUDIT_MIN_RETENTION_DAYS,
} from "../auditTypes";
import { ApiError } from "../types";

export interface AppSettings {
  /** Nom affiché sur les rapports (vide = aucun). */
  orgName: string;
  auditRetentionDays: number;
  thresholds: Thresholds;
}

export interface UpdateSettingsInput {
  orgName?: unknown;
  auditRetentionDays?: unknown;
  warnPct?: unknown;
  critPct?: unknown;
}

const MAX_ORG = 80;

function read(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

const write = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export function getOrgName(db: Db = getDb()): string {
  return read(db, "org_name") ?? "";
}

export function getAuditRetentionDays(db: Db = getDb()): number {
  const n = Number(read(db, "audit_retention_days"));
  return Number.isInteger(n) && n >= AUDIT_MIN_RETENTION_DAYS && n <= AUDIT_MAX_RETENTION_DAYS ? n : AUDIT_DEFAULT_RETENTION_DAYS;
}

export function getAppSettings(db: Db = getDb()): AppSettings {
  return { orgName: getOrgName(db), auditRetentionDays: getAuditRetentionDays(db), thresholds: getThresholds(db) };
}

/**
 * Modification partielle : un champ absent est inchangé. Tout est validé avant la première écriture, et l'ensemble se
 * fait dans une transaction : un seuil invalide n'enregistre pas non plus le nom de l'organisation.
 */
export function updateAppSettings(input: UpdateSettingsInput, db: Db = getDb()): AppSettings {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);

  let orgName: string | undefined;
  if (input.orgName !== undefined) {
    if (typeof input.orgName !== "string") throw new ApiError("invalidBody", 400);
    orgName = input.orgName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim();
    if (orgName.length > MAX_ORG) throw new ApiError("nameTooLong", 422);
  }
  let retention: number | undefined;
  if (input.auditRetentionDays !== undefined) {
    const n = input.auditRetentionDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < AUDIT_MIN_RETENTION_DAYS || n > AUDIT_MAX_RETENTION_DAYS) {
      throw new ApiError("invalidRetention", 422, { min: AUDIT_MIN_RETENTION_DAYS, max: AUDIT_MAX_RETENTION_DAYS });
    }
    retention = n;
  }
  const thresholds = input.warnPct !== undefined || input.critPct !== undefined;

  db.transaction(() => {
    if (thresholds) setThresholds({ warnPct: input.warnPct, critPct: input.critPct }, db); // lève invalidThresholds
    if (orgName !== undefined) write(db, "org_name", orgName);
    if (retention !== undefined) write(db, "audit_retention_days", String(retention));
  })();
  return getAppSettings(db);
}

/* ------------------------------ Base de données ------------------------------ */

export interface DatabaseInfo {
  file: string;
  sizeBytes: number | null;
  sqliteVersion: string;
  counts: { table: string; rows: number }[];
}

/** Tables comptées, dans l'ordre d'affichage (noms fixes : jamais issus d'une saisie). */
const COUNTED = [
  "projects",
  "sites",
  "networks",
  "vlans",
  "vrfs",
  "ip_addresses",
  "dhcp_scopes",
  "dhcp_reservations",
  "plans",
  "users",
  "audit_log",
] as const;

export function getDatabaseInfo(db: Db = getDb()): DatabaseInfo {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = fs.statSync(DB_PATH).size;
  } catch {
    sizeBytes = null; // base en mémoire (tests)
  }
  const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  return {
    file: path.basename(DB_PATH),
    sizeBytes,
    sqliteVersion: version,
    counts: COUNTED.map((table) => ({ table, rows: (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c })),
  };
}

/**
 * Copie cohérente de la base (VACUUM INTO : fichier compact, sans les fichiers annexes WAL). Les sessions ouvertes sont
 * retirées de la copie, ainsi que la clé d'API de l'assistant IA : on ne distribue ni jeton ni clé, même hachés. Les comptes et leurs empreintes de mot de passe y
 * restent : la sauvegarde est réservée aux administrateurs.
 */
export function createBackup(db: Db = getDb()): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ip-architect-backup-"));
  const file = path.join(dir, "backup.db");
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const copy = new Database(file);
    try {
      copy.exec("DELETE FROM user_sessions");
      // les secrets (clé d'API de l'assistant, mot de passe SMTP) et les inscriptions en attente ne sortent jamais de la base
      for (const key of [AI_SECRET_SETTING, SMTP_SECRET_SETTING, ...SSO_SECRET_SETTINGS]) copy.prepare("DELETE FROM settings WHERE key = ?").run(key);
      // secrets de signature des webhooks : la copie ne doit pas permettre de les forger (webhooks désactivés, à reconfigurer)
      copy.exec("UPDATE webhooks SET secret = '', active = 0");
      // communautés SNMP : la copie ne doit pas permettre d'interroger le parc (à ressaisir après restauration)
      copy.exec("UPDATE snmp_credentials SET community = ''");
      copy.exec("DELETE FROM settings WHERE key = 'setup_code'");
      copy.exec("DELETE FROM sso_flows");
      copy.exec("DELETE FROM signup_requests");
      copy.exec("DELETE FROM password_resets");
      copy.exec("VACUUM"); // un simple DELETE laisse les octets dans les pages libres du fichier : on le recompacte
    } finally {
      copy.close();
    }
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
