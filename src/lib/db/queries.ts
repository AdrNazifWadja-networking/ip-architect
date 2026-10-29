import { getDb, type Db } from "./index";
import { resolveProjectFor } from "./access";
import { getMonitoring } from "./monitoring";
import { attachMeta, tagIdByName, writeMeta } from "./meta";
import { fingerprint } from "./notifications";
import { requestContext } from "../auth/request";
import { calcSubnet, cidrOverlap, parseCidr, normalizeCidr } from "../ip/cidr";
import {
  ApiError,
  type AlertSeverity,
  type CreateNetworkInput,
  type DashboardData,
  type Delta,
  type NetworkRow,
  type NetworkStatus,
  type Site,
} from "../types";

const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];
const DAY_MS = 86_400_000;

interface RawNetwork {
  id: number;
  cidr: string;
  version: 4 | 6;
  name: string;
  site_id: number | null;
  site_name: string | null;
  vlan: number | null;
  vrf_id: number | null;
  vrf_name: string | null;
  status: NetworkStatus;
  used_ips: number;
  reserved_ips: number;
  capacity: number;
  created_at: string;
}

const NETWORK_SELECT = `
  SELECT n.id, n.cidr, n.version, n.name, n.site_id, s.name AS site_name, n.vlan, n.vrf_id, v.name AS vrf_name,
         n.status, n.used_ips, n.reserved_ips, n.capacity, n.created_at
  FROM networks n LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN vrfs v ON v.id = n.vrf_id`;

function mapNetwork(r: RawNetwork): NetworkRow {
  return {
    id: r.id,
    cidr: r.cidr,
    version: r.version,
    name: r.name,
    siteId: r.site_id,
    siteName: r.site_name,
    vlan: r.vlan,
    vrfId: r.vrf_id,
    vrfName: r.vrf_name,
    status: r.status,
    usedIps: r.used_ips,
    reservedIps: r.reserved_ips,
    capacity: r.capacity,
    usagePct: r.capacity > 0 ? Math.min(100, (r.used_ips / r.capacity) * 100) : 0,
    createdAt: r.created_at,
    tags: [],
    customFields: {},
  };
}

export function getActiveProject(db: Db = getDb()): { id: number; name: string } {
  // requête d'un compte connecté : SON projet (en-tête X-Project-Id, sinon son projet actif), parmi ceux auxquels il a accès
  const ctx = requestContext();
  if (ctx) return resolveProjectFor(db, ctx.user, ctx.projectId);
  // application ouverte, script ou test : réglage commun, sinon le premier projet
  const chosen = db.prepare("SELECT value FROM settings WHERE key = 'active_project_id'").get() as
    | { value: string }
    | undefined;
  const byId = chosen
    ? (db.prepare("SELECT id, name FROM projects WHERE id = ?").get(Number(chosen.value)) as
        | { id: number; name: string }
        | undefined)
    : undefined;
  const p =
    byId ??
    (db.prepare("SELECT id, name FROM projects ORDER BY id LIMIT 1").get() as { id: number; name: string } | undefined);
  if (!p) throw new ApiError("noProject", 404);
  return p;
}

export function listSites(db: Db = getDb()): Site[] {
  const project = getActiveProject(db);
  return db.prepare("SELECT id, name FROM sites WHERE project_id = ? ORDER BY name").all(project.id) as Site[];
}

/* ------------------------------- Réseaux ------------------------------ */

export interface NetworkFilters {
  q?: string;
  status?: NetworkStatus;
  version?: 4 | 6;
  /** Identifiant de VRF, ou "none" pour la VRF globale (réseaux sans VRF). */
  vrf?: number | "none";
  /** Identifiant de site. */
  siteId?: number;
  /** Nom d'étiquette : ne garde que les réseaux qui la portent. */
  tag?: string;
}

export function listNetworks(filters: NetworkFilters = {}, db: Db = getDb()): NetworkRow[] {
  const project = getActiveProject(db);
  const where: string[] = ["n.project_id = ?"];
  const params: (string | number)[] = [project.id];

  if (filters.status && STATUSES.includes(filters.status)) {
    where.push("n.status = ?");
    params.push(filters.status);
  }
  if (filters.version === 4 || filters.version === 6) {
    where.push("n.version = ?");
    params.push(filters.version);
  }
  if (filters.vrf === "none") {
    where.push("n.vrf_id IS NULL");
  } else if (typeof filters.vrf === "number" && Number.isInteger(filters.vrf)) {
    where.push("n.vrf_id = ?");
    params.push(filters.vrf);
  }
  if (typeof filters.siteId === "number" && Number.isInteger(filters.siteId)) {
    where.push("n.site_id = ?");
    params.push(filters.siteId);
  }
  if (filters.tag?.trim()) {
    where.push("EXISTS (SELECT 1 FROM network_tags nt WHERE nt.network_id = n.id AND nt.tag_id = ?)");
    params.push(tagIdByName(filters.tag, db));
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push(
      "(LOWER(n.cidr) LIKE ? OR LOWER(n.name) LIKE ? OR LOWER(COALESCE(s.name, '')) LIKE ? OR LOWER(COALESCE(v.name, '')) LIKE ? OR EXISTS (SELECT 1 FROM network_tags nt JOIN tags g ON g.id = nt.tag_id WHERE nt.network_id = n.id AND LOWER(g.name) LIKE ?))",
    );
    params.push(like, like, like, like, like);
  }

  const rows = db
    .prepare(`${NETWORK_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.name, n.version, n.cidr`)
    .all(...params) as RawNetwork[];
  return attachMeta("network", rows.map(mapNetwork), db);
}

export function createNetwork(
  input: CreateNetworkInput,
  db: Db = getDb(),
  opts: { skipRequired?: boolean } = {},
): NetworkRow {
  const project = getActiveProject(db);

  const name = (input.name ?? "").trim();
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);

  const parsed = parseCidr(input.cidr ?? "");
  const cidr = normalizeCidr(input.cidr ?? "");
  if (!parsed || !cidr) throw new ApiError("invalidCidr", 422);

  const status: NetworkStatus = input.status ?? "active";
  if (!STATUSES.includes(status)) throw new ApiError("invalidStatus", 422);

  const vlan = input.vlan ?? null;
  if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) {
    throw new ApiError("invalidVlan", 422);
  }

  const siteId = input.siteId ?? null;
  if (siteId !== null) {
    const exists = db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, project.id);
    if (!exists) throw new ApiError("siteNotFound", 422);
  }

  const info = calcSubnet(cidr)!;
  const capacity = Number(
    info.usable > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : info.usable,
  );
  const used = input.usedIps ?? 0;
  const reserved = input.reservedIps ?? 0;
  if (!Number.isInteger(used) || !Number.isInteger(reserved) || used < 0 || reserved < 0) {
    throw new ApiError("invalidCounters", 422);
  }
  if (used + reserved > capacity) {
    throw new ApiError("tooManyAddresses", 422, { n: capacity });
  }

  // VRF : null = table de routage globale
  const vrfId = input.vrfId ?? null;
  if (vrfId !== null) {
    if (!Number.isInteger(vrfId)) throw new ApiError("invalidId", 400);
    const exists = db.prepare("SELECT 1 FROM vrfs WHERE id = ? AND project_id = ?").get(vrfId, project.id);
    if (!exists) throw new ApiError("vrfNotFound", 422);
  }

  // Détection de chevauchement avec les réseaux existants (même version IP, MÊME VRF :
  // c'est tout l'intérêt d'une VRF de pouvoir réutiliser les mêmes adresses dans un autre espace d'adressage)
  const existing = db
    .prepare("SELECT cidr, name FROM networks WHERE project_id = ? AND version = ? AND vrf_id IS ?")
    .all(project.id, parsed.version, vrfId) as { cidr: string; name: string }[];
  const clash = existing.find((e) => cidrOverlap(e.cidr, cidr));
  if (clash) throw new ApiError("overlap", 409, { cidr: clash.cidr, name: clash.name });

  const insert = db.transaction((): number => {
  const res = db
    .prepare(
      `INSERT INTO networks (project_id, site_id, cidr, version, name, vlan, vrf_id, status, used_ips, reserved_ips, capacity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      siteId,
      cidr,
      parsed.version,
      name,
      vlan,
      vrfId,
      status,
      used,
      reserved,
      capacity,
      new Date().toISOString(),
    );
  const newId = Number(res.lastInsertRowid);
  writeMeta("network", newId, input, db, { creating: true, skipRequired: opts.skipRequired });
  return newId;
  });
  const newId = insert();

  const row = db.prepare(`${NETWORK_SELECT} WHERE n.id = ?`).get(newId) as RawNetwork;
  return attachMeta("network", [mapNetwork(row)], db)[0];
}

export function deleteNetwork(id: number, db: Db = getDb()): void {
  const project = getActiveProject(db);
  const res = db.prepare("DELETE FROM networks WHERE id = ? AND project_id = ?").run(id, project.id);
  if (res.changes === 0) throw new ApiError("networkNotFound", 404);
}

/* ------------------------------- Dashboard ---------------------------- */

/** Enregistre (ou met à jour) l'instantané d'utilisation du jour : c'est ce qui alimente la courbe d'évolution. */
export function recordSnapshot(projectId: number, db: Db = getDb()): void {
  const m = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(used_ips) * 100.0 / NULLIF(SUM(capacity), 0) FROM networks WHERE project_id = @p AND version = 4), 0) AS v4,
         COALESCE((SELECT SUM(CASE WHEN status = 'active' AND used_ips > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
                   FROM networks WHERE project_id = @p AND version = 6), 0) AS v6,
         COALESCE((SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
                   FROM networks WHERE project_id = @p), 0) AS act`,
    )
    .get({ p: projectId }) as { v4: number; v6: number; act: number };

  db.prepare("INSERT OR REPLACE INTO usage_history (project_id, day, ipv4, ipv6, active) VALUES (?, ?, ?, ?, ?)").run(
    projectId,
    new Date().toISOString().slice(0, 10),
    m.v4,
    m.v6,
    m.act,
  );
}

function growth(now: number, before: number): Delta | null {
  if (before <= 0) return null;
  return { value: ((now - before) / before) * 100 };
}

export function getDashboard(db: Db = getDb()): DashboardData {
  const project = getActiveProject(db);
  recordSnapshot(project.id, db);

  const cutoff = new Date(Date.now() - 30 * DAY_MS).toISOString();

  const t = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN version = 4 THEN 1 ELSE 0 END), 0) AS v4n,
         COALESCE(SUM(CASE WHEN version = 6 THEN 1 ELSE 0 END), 0) AS v6n,
         COALESCE(SUM(CASE WHEN version = 4 THEN used_ips ELSE 0 END), 0) AS v4used,
         COALESCE(SUM(CASE WHEN version = 6 THEN used_ips ELSE 0 END), 0) AS v6used,
         COALESCE(SUM(CASE WHEN version = 4 THEN reserved_ips ELSE 0 END), 0) AS v4res,
         COALESCE(SUM(CASE WHEN version = 4 THEN capacity ELSE 0 END), 0) AS v4cap
       FROM networks WHERE project_id = ?`,
    )
    .get(project.id) as { v4n: number; v6n: number; v4used: number; v6used: number; v4res: number; v4cap: number };

  const count = (sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { c: number }).c;

  const v6Before = count(
    "SELECT COUNT(*) AS c FROM networks WHERE project_id = ? AND version = 6 AND created_at <= ?",
    project.id,
    cutoff,
  );
  const vlans = count("SELECT COUNT(*) AS c FROM vlans WHERE project_id = ?", project.id);
  const vlansBefore = count("SELECT COUNT(*) AS c FROM vlans WHERE project_id = ? AND created_at <= ?", project.id, cutoff);
  // « Alertes actives » = les contrôles de supervision EN COURS (calculés sur les données réelles, comme la cloche et les e-mails)
  const findings = getMonitoring(db, project.id).findings.filter((f) => f.severity !== "info");
  const alerts = new Set(findings.map((f) => fingerprint(project.id, f))).size;

  const history = (
    db
      .prepare(
        `SELECT day, ipv4, ipv6, active FROM usage_history
         WHERE project_id = ? ORDER BY day DESC LIMIT 31`,
      )
      .all(project.id) as { day: string; ipv4: number; ipv6: number; active: number }[]
  ).reverse();

  const usageRate = t.v4cap > 0 ? (t.v4used / t.v4cap) * 100 : 0;
  const usageDelta: Delta | null = history.length >= 2 ? { value: usageRate - history[0].ipv4 } : null;

  const versionTotal = t.v4used + t.v6used;

  const topSites = db
    .prepare(
      `SELECT s.name AS name, SUM(n.used_ips) * 100.0 / SUM(n.capacity) AS pct
       FROM sites s JOIN networks n ON n.site_id = s.id AND n.version = 4
       WHERE s.project_id = ? GROUP BY s.id ORDER BY pct DESC LIMIT 5`,
    )
    .all(project.id) as { name: string; pct: number }[];

  const statusRows = db
    .prepare("SELECT status, COUNT(*) AS c FROM networks WHERE project_id = ? GROUP BY status")
    .all(project.id) as { status: NetworkStatus; c: number }[];
  const statusTotal = statusRows.reduce((a, r) => a + r.c, 0);
  const statusSplit = STATUSES.map((s) => {
    const c = statusRows.find((r) => r.status === s)?.c ?? 0;
    return { status: s, count: c, pct: statusTotal ? (c / statusTotal) * 100 : 0 };
  });

  const currentProblems = findings.slice(0, 5).map((f) => ({
    kind: f.kind,
    severity: f.severity as "critical" | "warning",
    params: f.params,
    href: f.href,
  }));

  return {
    project,
    kpis: {
      ipv4Networks: t.v4n,
      ipv6Networks: t.v6n,
      ipv6Delta: growth(t.v6n, v6Before),
      usedIps: t.v4used,
      capacity: t.v4cap,
      usageRate,
      usageDelta,
      vlans,
      vlanDelta: growth(vlans, vlansBefore),
      alerts,
      alertDelta: null, // pas d'historique des contrôles : aucune évolution à afficher
    },
    addressUsage: {
      used: t.v4used,
      reserved: t.v4res,
      available: Math.max(0, t.v4cap - t.v4used - t.v4res),
      total: t.v4cap,
      pct: usageRate,
    },
    versionSplit: {
      ipv4: t.v4used,
      ipv6: t.v6used,
      total: versionTotal,
      ipv4Pct: versionTotal ? (t.v4used / versionTotal) * 100 : 0,
      ipv6Pct: versionTotal ? (t.v6used / versionTotal) * 100 : 0,
    },
    topSites,
    statusSplit,
    statusTotal,
    history,
    alerts: currentProblems,
  };
}
