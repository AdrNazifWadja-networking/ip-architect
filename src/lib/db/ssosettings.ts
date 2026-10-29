/**
 * Réglages de la connexion unique (OpenID Connect) et de l'annuaire (LDAP), dans la table « settings ».
 * Les secrets (secret client OIDC, mot de passe du compte de service LDAP) ne sont JAMAIS renvoyés par l'API
 * (seulement « un secret est enregistré ») et la sauvegarde de la base les retire.
 */
import { getDb, type Db } from "./index";
import { ApiError } from "../types";
import { parseLdapUrl } from "../ldap/client";
import { encodeFilter, renderFilter } from "../ldap/filter";
import {
  DEFAULT_ROLES,
  LDAP_DEFAULTS,
  OIDC_DEFAULTS,
  type LdapConfig,
  type LoginOptions,
  type OidcConfig,
  type Provisioning,
  type SsoConfig,
  type UpdateSsoInput,
} from "../ssoTypes";

const K = { oidc: "sso_oidc", ldap: "sso_ldap", oidcSecret: "sso_oidc_secret", ldapPassword: "sso_ldap_password" } as const;
/** Clés retirées de toute copie de la base. */
export const SSO_SECRET_SETTINGS: readonly string[] = [K.oidcSecret, K.ldapPassword];

const read = (db: Db, key: string): string | null => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
};
const write = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

const PROVISIONING_DEFAULTS: Provisioning = { allowedGroups: [], adminGroups: [], editorGroups: [], defaultRole: "viewer", syncRole: true };

const OIDC_BASE: Omit<OidcConfig, "hasSecret"> = {
  enabled: false,
  issuer: "",
  clientId: "",
  scopes: OIDC_DEFAULTS.scopes,
  usernameClaim: OIDC_DEFAULTS.usernameClaim,
  groupsClaim: OIDC_DEFAULTS.groupsClaim,
  label: OIDC_DEFAULTS.label,
  publicUrl: "",
  domains: [],
  ...PROVISIONING_DEFAULTS,
};
const LDAP_BASE: Omit<LdapConfig, "hasPassword"> = {
  enabled: false,
  url: "",
  startTls: false,
  bindDn: "",
  baseDn: "",
  ...LDAP_DEFAULTS,
  ...PROVISIONING_DEFAULTS,
};

function readJson<T extends object>(db: Db, key: string, base: T): T {
  try {
    const raw = read(db, key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? { ...base, ...v } : { ...base };
  } catch {
    return { ...base };
  }
}

export function getSsoConfig(db: Db = getDb()): SsoConfig {
  return {
    oidc: { ...readJson(db, K.oidc, OIDC_BASE), hasSecret: (read(db, K.oidcSecret) ?? "") !== "" },
    ldap: { ...readJson(db, K.ldap, LDAP_BASE), hasPassword: (read(db, K.ldapPassword) ?? "") !== "" },
  };
}

export const getOidcSecret = (db: Db = getDb()): string => read(db, K.oidcSecret) ?? "";
export const getLdapPassword = (db: Db = getDb()): string => read(db, K.ldapPassword) ?? "";

/** Ce que la page de connexion affiche : aucune donnée sensible. */
export function getLoginOptions(db: Db = getDb()): LoginOptions {
  const { oidc, ldap } = getSsoConfig(db);
  return { oidc: oidc.enabled ? { label: oidc.label } : null, ldap: ldap.enabled };
}

/* ------------------------------- Validation ------------------------------- */

const bad = (field: string): ApiError => new ApiError("ssoInvalidConfig", 422, { field });

function str(raw: unknown, field: string, max: number, opts: { required?: boolean; noSpace?: boolean } = {}): string {
  if (typeof raw !== "string") throw bad(field);
  const s = raw.trim();
  if (s.length > max || /[\u0000-\u001f\u007f]/.test(s) || (opts.noSpace && /\s/.test(s))) throw bad(field);
  if (opts.required && !s) throw bad(field);
  return s;
}

function bool(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw bad(field);
  return raw;
}

function list(raw: unknown, field: string, max = 50): string[] {
  if (!Array.isArray(raw) || raw.length > max) throw bad(field);
  const out: string[] = [];
  for (const x of raw) {
    const s = str(x, field, 300);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const isLoopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);

/** https obligatoire, sauf pour une machine locale (essais). Sans identifiants intégrés, sans paramètres. */
export function cleanHttpsUrl(raw: unknown, field: string, opts: { originOnly?: boolean } = {}): string {
  const s = str(raw, field, 300, { noSpace: true });
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(field);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(host))) || u.username || u.password || u.search || u.hash) throw bad(field);
  if (opts.originOnly && u.pathname !== "/") throw bad(field);
  return opts.originOnly ? u.origin : s.replace(/\/+$/, "");
}

/** Le mot de passe de l'annuaire ne doit pas circuler en clair sur le réseau : ldap:// seul n'est admis que sur la machine locale. */
export function ldapTransportOk(url: string, startTls: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const u = parseLdapUrl(url);
  if (!u) return false;
  return u.secure || startTls || isLoopback(u.host) || env.IP_ARCHITECT_LDAP_ALLOW_PLAIN === "1";
}

function cleanProvisioning<T extends Partial<Provisioning>>(cur: Provisioning, input: T): Provisioning {
  const p = { ...cur };
  if (input.allowedGroups !== undefined) p.allowedGroups = list(input.allowedGroups, "allowedGroups");
  if (input.adminGroups !== undefined) p.adminGroups = list(input.adminGroups, "adminGroups");
  if (input.editorGroups !== undefined) p.editorGroups = list(input.editorGroups, "editorGroups");
  if (input.defaultRole !== undefined) {
    if (!(DEFAULT_ROLES as readonly string[]).includes(input.defaultRole as string)) throw bad("defaultRole");
    p.defaultRole = input.defaultRole;
  }
  if (input.syncRole !== undefined) p.syncRole = bool(input.syncRole, "syncRole");
  return p;
}

const CLAIM = /^[A-Za-z0-9_.:\-/]{1,60}$/;
const ATTR = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;
const attr = (raw: unknown, field: string): string => {
  const s = str(raw, field, 41, { required: true, noSpace: true });
  if (!ATTR.test(s)) throw bad(field);
  return s;
};

function cleanOidc(cur: SsoConfig["oidc"], input: NonNullable<UpdateSsoInput["oidc"]>): { cfg: Omit<OidcConfig, "hasSecret">; secret?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ApiError("invalidBody", 400);
  const { hasSecret: _h, ...base } = cur;
  const cfg: Omit<OidcConfig, "hasSecret"> = { ...base, ...cleanProvisioning(cur, input) };
  if (input.issuer !== undefined) cfg.issuer = cleanHttpsUrl(input.issuer, "issuer");
  if (input.clientId !== undefined) cfg.clientId = str(input.clientId, "clientId", 200, { noSpace: true });
  if (input.scopes !== undefined) {
    const s = str(input.scopes, "scopes", 200).split(/\s+/).filter(Boolean);
    if (!s.includes("openid") || s.some((x) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(x))) throw bad("scopes");
    cfg.scopes = [...new Set(s)].join(" ");
  }
  if (input.usernameClaim !== undefined) {
    cfg.usernameClaim = str(input.usernameClaim, "usernameClaim", 60, { required: true });
    if (!CLAIM.test(cfg.usernameClaim)) throw bad("usernameClaim");
  }
  if (input.groupsClaim !== undefined) {
    cfg.groupsClaim = str(input.groupsClaim, "groupsClaim", 60);
    if (cfg.groupsClaim && !CLAIM.test(cfg.groupsClaim)) throw bad("groupsClaim");
  }
  if (input.label !== undefined) cfg.label = str(input.label, "label", 30, { required: true });
  if (input.publicUrl !== undefined) cfg.publicUrl = cleanHttpsUrl(input.publicUrl, "publicUrl", { originOnly: true });
  if (input.domains !== undefined) {
    cfg.domains = list(input.domains, "domains", 30).map((d) => d.toLowerCase().replace(/^@/, ""));
    if (cfg.domains.some((d) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d))) throw bad("domains");
  }
  if (input.enabled !== undefined) cfg.enabled = bool(input.enabled, "enabled");
  const secret = input.clientSecret !== undefined ? str(input.clientSecret, "clientSecret", 500, { noSpace: true }) : undefined;
  if (cfg.enabled && (!cfg.issuer || !cfg.clientId)) throw new ApiError("ssoNotConfigured", 409);
  return { cfg, secret };
}

function cleanLdap(cur: SsoConfig["ldap"], input: NonNullable<UpdateSsoInput["ldap"]>): { cfg: Omit<LdapConfig, "hasPassword">; password?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ApiError("invalidBody", 400);
  const { hasPassword: _h, ...base } = cur;
  const cfg: Omit<LdapConfig, "hasPassword"> = { ...base, ...cleanProvisioning(cur, input) };
  if (input.url !== undefined) {
    cfg.url = str(input.url, "url", 300, { noSpace: true });
    if (cfg.url && !parseLdapUrl(cfg.url)) throw bad("url");
  }
  if (input.startTls !== undefined) cfg.startTls = bool(input.startTls, "startTls");
  if (input.bindDn !== undefined) cfg.bindDn = str(input.bindDn, "bindDn", 500);
  if (input.baseDn !== undefined) cfg.baseDn = str(input.baseDn, "baseDn", 500);
  if (input.userFilter !== undefined) {
    cfg.userFilter = str(input.userFilter, "userFilter", 300, { required: true });
    if (!cfg.userFilter.includes("{username}")) throw bad("userFilter");
    try {
      encodeFilter(renderFilter(cfg.userFilter, "test"));
    } catch {
      throw bad("userFilter");
    }
  }
  if (input.usernameAttr !== undefined) cfg.usernameAttr = attr(input.usernameAttr, "usernameAttr");
  if (input.displayNameAttr !== undefined) cfg.displayNameAttr = attr(input.displayNameAttr, "displayNameAttr");
  if (input.emailAttr !== undefined) cfg.emailAttr = attr(input.emailAttr, "emailAttr");
  if (input.groupAttr !== undefined) cfg.groupAttr = attr(input.groupAttr, "groupAttr");
  if (input.enabled !== undefined) cfg.enabled = bool(input.enabled, "enabled");
  const password = input.bindPassword !== undefined ? str(input.bindPassword, "bindPassword", 500) : undefined;
  if (cfg.url && !cfg.startTls && !ldapTransportOk(cfg.url, cfg.startTls)) throw new ApiError("ldapPlain", 422);
  if (cfg.enabled && (!cfg.url || !cfg.baseDn)) throw new ApiError("ssoNotConfigured", 409);
  return { cfg, password };
}

/** Modification partielle, validée en entier avant la première écriture, dans une transaction. */
export function updateSsoConfig(input: UpdateSsoInput, db: Db = getDb()): SsoConfig {
  if (!input || typeof input !== "object" || Array.isArray(input) || (input.oidc === undefined && input.ldap === undefined)) throw new ApiError("invalidBody", 400);
  const cur = getSsoConfig(db);
  const o = input.oidc !== undefined ? cleanOidc(cur.oidc, input.oidc) : null;
  const l = input.ldap !== undefined ? cleanLdap(cur.ldap, input.ldap) : null;
  db.transaction(() => {
    if (o) {
      write(db, K.oidc, JSON.stringify(o.cfg));
      if (o.secret !== undefined) write(db, K.oidcSecret, o.secret);
    }
    if (l) {
      write(db, K.ldap, JSON.stringify(l.cfg));
      if (l.password !== undefined) write(db, K.ldapPassword, l.password);
    }
  })();
  return getSsoConfig(db);
}
