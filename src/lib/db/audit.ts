/**
 * Journal d'audit : une ligne par action qui modifie des données, par connexion, déconnexion ou échec de connexion.
 *
 * - Append-only : aucune fonction ne modifie ni ne supprime une ligne, sauf `pruneAudit` (durée de conservation réglable,
 *   plafond de lignes).
 * - Aucun mot de passe, jeton ni secret n'est écrit. Pour une modification ou une suppression, on garde le nom des champs
 *   et leurs valeurs avant/après (adressage et réglages non secrets uniquement, voir db/changes.ts).
 * - Un échec d'écriture du journal ne doit jamais faire échouer l'action elle-même (voir lib/audit.ts).
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getAuditRetentionDays } from "./appsettings";
import { queueWebhooks } from "./webhooks";
import { parseChanges, sanitizeChanges, MAX_CHANGES_JSON, type ChangeSet } from "../changeTypes";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_PAGE_SIZE,
  isAuditAction,
  isAuditEntity,
  type AuditEntity,
  type AuditFilters,
  type AuditPage,
  type AuditRow,
} from "../auditTypes";

export const AUDIT_MAX_ROWS = 200_000;
const MAX_DETAIL = 300;
const MAX_EXPORT = 50_000;
const DAY_MS = 86_400_000;

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: number | null;
  detail?: string | null;
  userId?: number | null;
  username?: string | null;
  projectId?: number | null;
  ip?: string | null;
  /** Valeurs avant / après (jamais de secret : voir changeTypes.ts). */
  changes?: ChangeSet | null;
  /** « token:ipa_ab12 » si l'action vient d'un jeton d'API. */
  via?: string | null;
}

/** Une seule ligne, sans retour à la ligne ni caractère de contrôle, tronquée. */
export function cleanDetail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 1)}…` : s;
}

function cleanVia(via: string | null | undefined): string | null {
  return via && /^token:[A-Za-z0-9_-]{1,12}$/.test(via) ? via : null;
}

function changesJson(c: ChangeSet | null | undefined): string | null {
  const clean = sanitizeChanges(c);
  if (!clean) return null;
  const json = JSON.stringify(clean);
  return json.length <= MAX_CHANGES_JSON ? json : null;
}

function cleanIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.trim().slice(0, 64);
  return /^[0-9a-fA-F:.%]+$/.test(s) ? s : null; // une adresse, jamais du texte libre
}

export function recordAudit(entry: AuditEntry, db: Db = getDb(), now: Date = new Date()): void {
  if (!isAuditAction(entry.action) || !isAuditEntity(entry.entity)) throw new Error(`audit : action ou objet inconnu (${entry.action}/${entry.entity})`);
  const projectId = entry.projectId !== undefined ? entry.projectId : safeProjectId(db);
  const id = Number(
    db
      .prepare("INSERT INTO audit_log (at, user_id, username, project_id, action, entity, entity_id, detail, ip, changes, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        now.toISOString(),
        entry.userId ?? null,
        entry.username ? entry.username.slice(0, 80) : null,
        projectId,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        cleanDetail(entry.detail),
        cleanIp(entry.ip),
        changesJson(entry.changes),
        cleanVia(entry.via),
      ).lastInsertRowid,
  );
  // webhooks : même événement (objet.action), mêmes valeurs avant/après que le journal ; ne lève jamais
  queueWebhooks(db, { event: `${entry.entity}.${entry.action}`, projectId, username: entry.username, entity: entry.entity, entityId: entry.entityId, detail: cleanDetail(entry.detail), changes: entry.changes }, now);
  if (id % 100 === 0) pruneAudit(db, now);
}

function safeProjectId(db: Db): number | null {
  try {
    return getActiveProject(db).id;
  } catch {
    return null;
  }
}

/** Supprime les lignes plus anciennes que la durée de conservation, puis les plus anciennes au-delà du plafond. */
export function pruneAudit(db: Db = getDb(), now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - getAuditRetentionDays(db) * DAY_MS).toISOString();
  let n = Number(db.prepare("DELETE FROM audit_log WHERE at < ?").run(cutoff).changes);
  n += Number(db.prepare("DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?)").run(AUDIT_MAX_ROWS).changes);
  return n;
}

/**
 * Libellé lisible d'un objet (« 10.1.10.0/24 — LAN »), calculé à partir de la base : à appeler AVANT une suppression
 * pour garder une trace de ce qui a disparu. null si l'objet n'existe pas (ou plus).
 */
export function auditLabel(entity: AuditEntity, id: number, db: Db = getDb()): string | null {
  const one = (sql: string) => db.prepare(sql).get(id) as Record<string, string | number | null> | undefined;
  switch (entity) {
    case "network": {
      const r = one("SELECT cidr, name FROM networks WHERE id = ?");
      return r ? `${r.cidr} — ${r.name}` : null;
    }
    case "address": {
      const r = one("SELECT a.address, n.cidr FROM ip_addresses a JOIN networks n ON n.id = a.network_id WHERE a.id = ?");
      return r ? `${r.address} (${r.cidr})` : null;
    }
    case "vlan": {
      const r = one("SELECT number, name FROM vlans WHERE id = ?");
      return r ? `VLAN ${r.number} — ${r.name}` : null;
    }
    case "site":
      return (one("SELECT name FROM sites WHERE id = ?")?.name as string | undefined) ?? null;
    case "vrf":
      return (one("SELECT name FROM vrfs WHERE id = ?")?.name as string | undefined) ?? null;
    case "project":
      return (one("SELECT name FROM projects WHERE id = ?")?.name as string | undefined) ?? null;
    case "dhcpScope":
      return (one("SELECT name FROM dhcp_scopes WHERE id = ?")?.name as string | undefined) ?? null;
    case "dhcpReservation": {
      const r = one("SELECT mac, address FROM dhcp_reservations WHERE id = ?");
      return r ? `${r.mac} → ${r.address}` : null;
    }
    case "plan":
      return (one("SELECT name FROM plans WHERE id = ?")?.name as string | undefined) ?? null;
    case "user":
      return (one("SELECT username FROM users WHERE id = ?")?.username as string | undefined) ?? null;
    case "scan":
      return (one("SELECT cidr FROM networks WHERE id = ?")?.cidr as string | undefined) ?? null;
    case "topoDevice":
      return (one("SELECT name FROM topo_devices WHERE id = ?")?.name as string | undefined) ?? null;
    case "topoLink":
      return null;
    case "snmpCredential":
      return (one("SELECT name FROM snmp_credentials WHERE id = ?")?.name as string | undefined) ?? null;
    case "webhook":
      return (one("SELECT name FROM webhooks WHERE id = ?")?.name as string | undefined) ?? null;
    case "tag":
      return (one("SELECT name FROM tags WHERE id = ?")?.name as string | undefined) ?? null;
    case "customField":
      return (one("SELECT label FROM custom_fields WHERE id = ?")?.label as string | undefined) ?? null;
    case "tpClass":
      return (one("SELECT name FROM tp_classes WHERE id = ?")?.name as string | undefined) ?? null;
    case "exercise":
      return (one("SELECT title FROM tp_exercises WHERE id = ?")?.title as string | undefined) ?? null;
    default:
      return null;
  }
}

/* --------------------------------- Lecture --------------------------------- */

interface RawAudit {
  id: number;
  at: string;
  user_id: number | null;
  username: string | null;
  project_id: number | null;
  project_name: string | null;
  action: string;
  entity: string;
  entity_id: number | null;
  detail: string | null;
  ip: string | null;
  changes: string | null;
  via: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function where(f: AuditFilters): { sql: string; params: (string | number)[] } {
  const w: string[] = [];
  const p: (string | number)[] = [];
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    w.push("(LOWER(COALESCE(a.detail, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.username, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.changes, '')) LIKE ? ESCAPE '\\')");
    p.push(like, like, like);
  }
  if (f.user?.trim()) {
    w.push("a.username = ?");
    p.push(f.user.trim());
  }
  if (isAuditAction(f.action)) {
    w.push("a.action = ?");
    p.push(f.action);
  }
  if (isAuditEntity(f.entity)) {
    w.push("a.entity = ?");
    p.push(f.entity);
  }
  if (f.from && DAY.test(f.from) && !Number.isNaN(Date.parse(f.from))) {
    w.push("a.at >= ?");
    p.push(`${f.from}T00:00:00.000Z`);
  }
  if (f.to && DAY.test(f.to) && !Number.isNaN(Date.parse(f.to))) {
    w.push("a.at <= ?");
    p.push(`${f.to}T23:59:59.999Z`);
  }
  return { sql: w.length ? `WHERE ${w.join(" AND ")}` : "", params: p };
}

const SELECT = `SELECT a.id, a.at, a.user_id, a.username, a.project_id, pr.name AS project_name, a.action, a.entity, a.entity_id, a.detail, a.ip, a.changes, a.via
                FROM audit_log a LEFT JOIN projects pr ON pr.id = a.project_id`;

function mapRow(r: RawAudit): AuditRow {
  return {
    id: r.id,
    at: r.at,
    userId: r.user_id,
    username: r.username,
    projectId: r.project_id,
    projectName: r.project_name,
    // une valeur inconnue (base modifiée à la main) ne casse pas l'affichage
    action: (AUDIT_ACTIONS as readonly string[]).includes(r.action) ? (r.action as AuditRow["action"]) : "update",
    entity: (AUDIT_ENTITIES as readonly string[]).includes(r.entity) ? (r.entity as AuditRow["entity"]) : "settings",
    entityId: r.entity_id,
    detail: r.detail,
    ip: r.ip,
    changes: parseChanges(r.changes),
    via: r.via,
  };
}

export function listAudit(filters: AuditFilters = {}, db: Db = getDb()): AuditPage {
  const pageSize = Number.isInteger(filters.pageSize) && filters.pageSize! >= 1 && filters.pageSize! <= 200 ? filters.pageSize! : AUDIT_PAGE_SIZE;
  const { sql, params } = where(filters);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log a ${sql}`).get(...params) as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const asked = Number.isInteger(filters.page) && filters.page! >= 1 ? filters.page! : 1;
  const page = Math.min(asked, pages);
  const rows = db
    .prepare(`${SELECT} ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as RawAudit[];
  return { rows: rows.map(mapRow), total, page, pages, pageSize };
}

/** Toutes les lignes correspondant aux filtres (plafonné), pour l'export. */
export function listAuditForExport(filters: AuditFilters = {}, db: Db = getDb()): { rows: AuditRow[]; truncated: boolean } {
  const { sql, params } = where(filters);
  const rows = db.prepare(`${SELECT} ${sql} ORDER BY a.id DESC LIMIT ?`).all(...params, MAX_EXPORT + 1) as RawAudit[];
  return { rows: rows.slice(0, MAX_EXPORT).map(mapRow), truncated: rows.length > MAX_EXPORT };
}

/** Noms de compte présents dans le journal (liste déroulante du filtre). */
export function listAuditUsers(db: Db = getDb()): string[] {
  return (db.prepare("SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY LOWER(username)").all() as { username: string }[]).map((r) => r.username);
}
