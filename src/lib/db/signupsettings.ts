/**
 * Réglages de l'inscription par e-mail (table « settings », clé/valeur) : activation, domaines autorisés, serveur SMTP.
 * Le mot de passe SMTP est stocké en clair comme le reste de la base : il n'est JAMAIS renvoyé par l'API (seulement
 * « un mot de passe est enregistré ») et la sauvegarde le retire.
 */
import { getDb, type Db } from "./index";
import { authEnabled } from "./users";
import { isLoopback, isSmtpSecurity, normalizeEmail, type SignupConfig, type SmtpSecurity, type UpdateSignupConfigInput } from "../signupTypes";
import { ApiError } from "../types";

const K = {
  enabled: "signup_enabled",
  domains: "signup_domains",
  console: "signup_console",
  host: "smtp_host",
  port: "smtp_port",
  security: "smtp_security",
  user: "smtp_user",
  password: "smtp_password",
  from: "smtp_from",
} as const;

/** Clé retirée de toute copie de la base. */
export const SMTP_SECRET_SETTING = K.password;

const read = (db: Db, key: string): string | null => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
};
const write = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export function getSignupConfig(db: Db = getDb()): SignupConfig {
  const sec = read(db, K.security);
  const port = Number(read(db, K.port));
  return {
    enabled: read(db, K.enabled) === "1",
    domains: (read(db, K.domains) ?? "").split(",").filter(Boolean),
    consoleMode: read(db, K.console) === "1",
    smtp: {
      host: read(db, K.host) ?? "",
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 465,
      security: isSmtpSecurity(sec) ? sec : "tls",
      user: read(db, K.user) ?? "",
      from: read(db, K.from) ?? "",
      hasPassword: (read(db, K.password) ?? "") !== "",
    },
  };
}

/** Le mot de passe SMTP, pour le seul client SMTP du serveur. */
export const getSmtpSecret = (db: Db = getDb()): string => read(db, K.password) ?? "";

/** L'inscription est ouverte : activée par un administrateur ET la connexion est exigée (un compte existe déjà). */
export function isSignupOpen(db: Db = getDb()): boolean {
  return read(db, K.enabled) === "1" && authEnabled(db);
}

const bad = (field: string) => new ApiError("signupInvalidConfig", 422, { field });

function cleanHost(raw: unknown): string {
  const h = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (h === "") return "";
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) && h !== "::1") throw bad("smtpHost");
  return h;
}
function cleanPort(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) throw bad("smtpPort");
  return n;
}
function cleanUser(raw: unknown): string {
  const u = typeof raw === "string" ? raw.trim() : "";
  if (u.length > 200 || /[\u0000-\u001f\u007f]/.test(u)) throw bad("smtpUser");
  return u;
}
function cleanPassword(raw: unknown, host: string): string {
  if (typeof raw !== "string") throw bad("smtpPassword");
  // Gmail affiche les mots de passe d'application par groupes séparés par des espaces : ils font partie de l'affichage, pas du secret
  const p = /(^|\.)(gmail|googlemail)\.com$/.test(host) ? raw.replace(/\s+/g, "") : raw.trim();
  if (p.length > 200 || /[\u0000-\u001f\u007f]/.test(p)) throw bad("smtpPassword");
  return p;
}
function cleanFrom(raw: unknown): string {
  if (typeof raw === "string" && raw.trim() === "") return "";
  const e = normalizeEmail(raw);
  if (!e) throw bad("smtpFrom");
  return e;
}
export function cleanDomains(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : null;
  if (!list) throw bad("domains");
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== "string") throw bad("domains");
    const d = x.trim().toLowerCase().replace(/^@/, "");
    if (!d) continue;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) throw bad("domains");
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > 50) throw bad("domains");
  return out;
}

/** Modification partielle, validée en entier avant la première écriture, dans une transaction. */
export function updateSignupConfig(input: UpdateSignupConfigInput, db: Db = getDb()): SignupConfig {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const cur = getSignupConfig(db);
  for (const k of ["enabled", "consoleMode"] as const) if (input[k] !== undefined && typeof input[k] !== "boolean") throw new ApiError("invalidBody", 400);

  const host = input.smtpHost !== undefined ? cleanHost(input.smtpHost) : cur.smtp.host;
  const port = input.smtpPort !== undefined ? cleanPort(input.smtpPort) : cur.smtp.port;
  if (input.smtpSecurity !== undefined && !isSmtpSecurity(input.smtpSecurity)) throw bad("smtpSecurity");
  const security: SmtpSecurity = (input.smtpSecurity as SmtpSecurity | undefined) ?? cur.smtp.security;
  const user = input.smtpUser !== undefined ? cleanUser(input.smtpUser) : cur.smtp.user;
  const password = input.smtpPassword !== undefined ? cleanPassword(input.smtpPassword, host) : undefined;
  const from = input.smtpFrom !== undefined ? cleanFrom(input.smtpFrom) : cur.smtp.from;
  const domains = input.domains !== undefined ? cleanDomains(input.domains) : cur.domains;
  const enabled = input.enabled !== undefined ? (input.enabled as boolean) : cur.enabled;
  const consoleMode = input.consoleMode !== undefined ? (input.consoleMode as boolean) : cur.consoleMode;

  // jamais d'identifiants ni de code en clair sur le réseau : sans chiffrement, seule la machine locale est acceptée
  if (host && security === "none" && !isLoopback(host)) throw bad("smtpSecurity");
  const hasPassword = password !== undefined ? password !== "" : cur.smtp.hasPassword;
  if ((user !== "") !== hasPassword) {
    if (enabled || user !== "" || password !== undefined) throw bad(user !== "" ? "smtpPassword" : "smtpUser");
  }
  if (enabled && !consoleMode && (!host || !from)) throw new ApiError("signupNotConfigured", 409);

  db.transaction(() => {
    write(db, K.enabled, enabled ? "1" : "0");
    write(db, K.console, consoleMode ? "1" : "0");
    write(db, K.domains, domains.join(","));
    write(db, K.host, host);
    write(db, K.port, String(port));
    write(db, K.security, security);
    write(db, K.user, user);
    write(db, K.from, from);
    if (password !== undefined) write(db, K.password, password);
  })();
  return getSignupConfig(db);
}
