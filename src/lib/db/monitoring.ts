/**
 * Supervision : contrôles calculés en direct à partir des données du projet actif (rien n'est stocké, rien ne devient obsolète).
 *
 * - Capacité : occupation (utilisées + réservées) de chaque réseau comparée à deux seuils réglables.
 * - Cohérence : VLAN référencé mais non défini, VLAN inutilisé, réseau en erreur / en maintenance / sans site,
 *   nom d'hôte en double, adresse statique à l'intérieur d'une plage DHCP active.
 * - Prévision : tendance linéaire de l'utilisation IPv4 globale (historique quotidien) -> jours avant saturation.
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getNetwork, listAddresses } from "./ipam";
import { parseIp } from "../ip/cidr";
import { MAX_PROBE_ADDRESSES } from "../monitor/ping";
import { scanNewHostCounts } from "./scans";
import { ApiError } from "../types";

export const DEFAULT_WARN_PCT = 80;
export const DEFAULT_CRIT_PCT = 90;

export interface Thresholds {
  warnPct: number;
  critPct: number;
}

export type FindingSeverity = "critical" | "warning" | "info";

export type FindingKind =
  | "capacity"
  | "networkError"
  | "vlanUndefined"
  | "duplicateHostname"
  | "staticInDhcpPool"
  | "vlanUnused"
  | "networkMaintenance"
  | "networkNoSite"
  | "scanNewHosts";

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** Variables du message traduit (t.monitoring.findings[kind]). */
  params: Record<string, string | number>;
  /** Page où corriger le problème. */
  href: string;
}

export interface CapacityRow {
  id: number;
  cidr: string;
  name: string;
  siteName: string | null;
  version: 4 | 6;
  /** (utilisées + réservées) / capacité, en %, plafonné à 100. */
  occupancyPct: number;
  used: number;
  reserved: number;
  capacity: number;
  level: "ok" | "warning" | "critical";
}

export interface Forecast {
  /** Nombre de relevés quotidiens utilisés. */
  points: number;
  currentPct: number;
  /** Points de pourcentage gagnés par jour (tendance linéaire). */
  slopePerDay: number;
  /** Jours avant 100 % si la tendance se poursuit ; null = pas de saturation prévisible. */
  daysToFull: number | null;
  trend: "rising" | "flat" | "falling";
}

export interface MonitoringData {
  thresholds: Thresholds;
  status: "ok" | "warning" | "critical";
  counts: Record<FindingSeverity, number>;
  findings: Finding[];
  /** Réseaux triés par occupation décroissante (tous, hors inactifs). */
  capacity: CapacityRow[];
  forecast: Forecast | null;
}

/* ------------------------------ Seuils ------------------------------ */

function readSetting(db: Db, key: string): number | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function getThresholds(db: Db = getDb()): Thresholds {
  const warnPct = readSetting(db, "monitor_warn_pct");
  const critPct = readSetting(db, "monitor_crit_pct");
  // valeurs enregistrées incohérentes (base modifiée à la main) : retour aux défauts plutôt qu'une supervision faussée
  if (warnPct !== null && critPct !== null && validThresholds(warnPct, critPct)) return { warnPct, critPct };
  return { warnPct: DEFAULT_WARN_PCT, critPct: DEFAULT_CRIT_PCT };
}

function validThresholds(warn: unknown, crit: unknown): boolean {
  return (
    typeof warn === "number" &&
    typeof crit === "number" &&
    Number.isInteger(warn) &&
    Number.isInteger(crit) &&
    warn >= 1 &&
    crit <= 100 &&
    warn < crit
  );
}

export function setThresholds(input: { warnPct?: unknown; critPct?: unknown }, db: Db = getDb()): Thresholds {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const current = getThresholds(db);
  const warn = input.warnPct === undefined ? current.warnPct : input.warnPct;
  const crit = input.critPct === undefined ? current.critPct : input.critPct;
  if (!validThresholds(warn, crit)) throw new ApiError("invalidThresholds", 422);
  const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    put.run("monitor_warn_pct", String(warn));
    put.run("monitor_crit_pct", String(crit));
  })();
  return { warnPct: warn as number, critPct: crit as number };
}

/* ----------------------------- Prévision ----------------------------- */

const DAY_MS = 86_400_000;
/** Au moins 7 relevés, sur au moins 7 jours : en dessous, une tendance n'a pas de sens. */
const MIN_POINTS = 7;
/** Une pente inférieure à 0,01 point/jour est considérée comme nulle. */
const FLAT = 0.01;
const MAX_DAYS = 3650;

/** Régression linéaire (moindres carrés) de l'utilisation IPv4 en fonction du jour. Pur : testable sans base. */
export function forecastFromHistory(history: { day: string; ipv4: number }[]): Forecast | null {
  const pts = history
    .map((h) => ({ x: Date.parse(`${h.day}T00:00:00Z`) / DAY_MS, y: h.ipv4 }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length < MIN_POINTS || pts[pts.length - 1].x - pts[0].x < MIN_POINTS - 1) return null;

  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const current = pts[n - 1].y;
  const trend = slope > FLAT ? "rising" : slope < -FLAT ? "falling" : "flat";
  let daysToFull: number | null = null;
  if (trend === "rising" && current < 100) {
    const d = Math.ceil((100 - current) / slope);
    if (d <= MAX_DAYS) daysToFull = d;
  } else if (current >= 100) daysToFull = 0;
  return { points: n, currentPct: current, slopePerDay: slope, daysToFull, trend };
}

/* ------------------------------ Contrôles ------------------------------ */

const round1 = (n: number) => Math.round(n * 10) / 10;

interface NetRow {
  id: number;
  cidr: string;
  name: string;
  version: 4 | 6;
  site_id: number | null;
  site_name: string | null;
  vlan: number | null;
  status: "active" | "inactive" | "maintenance" | "error";
  used_ips: number;
  reserved_ips: number;
  capacity: number;
  vrf_id: number | null;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function getMonitoring(db: Db = getDb(), projectId?: number): MonitoringData {
  const project = projectId !== undefined ? { id: projectId } : getActiveProject(db);
  const thresholds = getThresholds(db);
  const findings: Finding[] = [];

  const nets = db
    .prepare(
      `SELECT n.id, n.cidr, n.name, n.version, n.site_id, s.name AS site_name, n.vlan, n.status,
              n.used_ips, n.reserved_ips, n.capacity, n.vrf_id
       FROM networks n LEFT JOIN sites s ON s.id = n.site_id
       WHERE n.project_id = ? ORDER BY n.id`,
    )
    .all(project.id) as NetRow[];

  /* Capacité */
  const capacity: CapacityRow[] = [];
  for (const n of nets) {
    if (n.status === "inactive") continue; // un réseau inactif n'est pas supervisé
    const pct = n.capacity > 0 ? Math.min(100, ((n.used_ips + n.reserved_ips) / n.capacity) * 100) : 0;
    const level = pct >= thresholds.critPct ? "critical" : pct >= thresholds.warnPct ? "warning" : "ok";
    capacity.push({
      id: n.id,
      cidr: n.cidr,
      name: n.name,
      siteName: n.site_name,
      version: n.version,
      occupancyPct: pct,
      used: n.used_ips,
      reserved: n.reserved_ips,
      capacity: n.capacity,
      level,
    });
    if (level !== "ok") {
      findings.push({
        kind: "capacity",
        severity: level,
        params: { cidr: n.cidr, name: n.name, pct: round1(pct), used: n.used_ips + n.reserved_ips, capacity: n.capacity },
        href: `/ipam/${n.id}`,
      });
    }
  }
  capacity.sort((a, b) => b.occupancyPct - a.occupancyPct || a.cidr.localeCompare(b.cidr));

  /* Hôtes inconnus découverts par les scans programmés (avec alerte) */
  for (const s of scanNewHostCounts(db, project.id)) {
    findings.push({ kind: "scanNewHosts", severity: "warning", params: { cidr: s.cidr, name: s.name, count: s.count, hosts: s.hosts }, href: "/scan" });
  }

  /* États des réseaux, rattachement au site, VLAN référencé */
  const vlans = db.prepare("SELECT site_id, number, name FROM vlans WHERE project_id = ?").all(project.id) as {
    site_id: number | null;
    number: number;
    name: string;
  }[];
  const vlanKey = (site: number | null, number: number) => `${site ?? 0}:${number}`;
  const defined = new Set(vlans.map((v) => vlanKey(v.site_id, v.number)));
  const referenced = new Set<string>();

  for (const n of nets) {
    if (n.status === "error") {
      findings.push({ kind: "networkError", severity: "critical", params: { cidr: n.cidr, name: n.name }, href: "/reseaux" });
    } else if (n.status === "maintenance") {
      findings.push({ kind: "networkMaintenance", severity: "info", params: { cidr: n.cidr, name: n.name }, href: "/reseaux" });
    }
    if (n.site_id === null) {
      findings.push({ kind: "networkNoSite", severity: "info", params: { cidr: n.cidr, name: n.name }, href: "/reseaux" });
    }
    if (n.vlan !== null) {
      const key = vlanKey(n.site_id, n.vlan);
      referenced.add(key);
      if (!defined.has(key)) {
        findings.push({
          kind: "vlanUndefined",
          severity: "warning",
          params: { cidr: n.cidr, name: n.name, vlan: n.vlan },
          href: "/vlans",
        });
      }
    }
  }
  for (const v of vlans) {
    if (!referenced.has(vlanKey(v.site_id, v.number))) {
      findings.push({ kind: "vlanUnused", severity: "info", params: { vlan: v.number, name: v.name }, href: "/vlans" });
    }
  }

  /* Noms d'hôte en double : même nom (casse ignorée) dans le même espace d'adressage (même VRF) */
  const hosts = db
    .prepare(
      `SELECT LOWER(a.hostname) AS host, n.vrf_id AS vrf, COUNT(*) AS c, GROUP_CONCAT(a.address, ', ') AS addrs
       FROM ip_addresses a JOIN networks n ON n.id = a.network_id
       WHERE n.project_id = ? AND a.hostname IS NOT NULL AND a.hostname != ''
       GROUP BY LOWER(a.hostname), n.vrf_id HAVING COUNT(*) > 1 ORDER BY host`,
    )
    .all(project.id) as { host: string; vrf: number | null; c: number; addrs: string }[];
  for (const h of hosts) {
    findings.push({
      kind: "duplicateHostname",
      severity: "warning",
      params: { hostname: h.host, n: h.c, addresses: h.addrs },
      href: "/ipam",
    });
  }

  /* Adresse statique dans une plage DHCP active (les réservations DHCP elles-mêmes sont normales) */
  const scopes = db
    .prepare(
      `SELECT d.id, d.name, d.network_id, d.range_start, d.range_end
       FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
       WHERE n.project_id = ? AND d.enabled = 1`,
    )
    .all(project.id) as { id: number; name: string; network_id: number; range_start: string; range_end: string }[];
  const addrStmt = db.prepare(
    `SELECT a.address FROM ip_addresses a
     WHERE a.network_id = ?
       AND NOT EXISTS (SELECT 1 FROM dhcp_reservations r JOIN dhcp_scopes d ON d.id = r.scope_id
                       WHERE d.network_id = a.network_id AND r.address = a.address)`,
  );
  for (const s of scopes) {
    const lo = parseIp(s.range_start)?.value;
    const hi = parseIp(s.range_end)?.value;
    if (lo === undefined || hi === undefined) continue;
    const inside = (addrStmt.all(s.network_id) as { address: string }[])
      .filter((a) => {
        const v = parseIp(a.address)?.value;
        return v !== undefined && v >= lo && v <= hi;
      })
      .map((a) => a.address);
    for (const address of inside) {
      findings.push({
        kind: "staticInDhcpPool",
        severity: "warning",
        params: { address, scope: s.name, start: s.range_start, end: s.range_end },
        href: `/dhcp/${s.id}`,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts: Record<FindingSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const history = db
    .prepare("SELECT day, ipv4 FROM usage_history WHERE project_id = ? ORDER BY day DESC LIMIT 60")
    .all(project.id) as { day: string; ipv4: number }[];

  return {
    thresholds,
    status: counts.critical > 0 ? "critical" : counts.warning > 0 ? "warning" : "ok",
    counts,
    findings,
    capacity,
    forecast: forecastFromHistory(history),
  };
}

/* ------------------------------- Sonde ------------------------------- */

export interface ProbeTargets {
  networkId: number;
  cidr: string;
  /** Adresses inventoriées à tester (au plus MAX_PROBE_ADDRESSES, par ordre croissant). */
  targets: { address: string; hostname: string | null }[];
  /** Nombre d'adresses inventoriées au total. */
  total: number;
}

/** Adresses inventoriées d'un réseau du projet actif, prêtes à être testées. */
export function getProbeTargets(networkId: number, db: Db = getDb()): ProbeTargets {
  const net = getNetwork(networkId, db); // 404 si le réseau n'est pas dans le projet actif
  const all = listAddresses(networkId, db);
  if (all.length === 0) throw new ApiError("noAddressToProbe", 422);
  return {
    networkId,
    cidr: net.cidr,
    targets: all.slice(0, MAX_PROBE_ADDRESSES).map((a) => ({ address: a.address, hostname: a.hostname })),
    total: all.length,
  };
}
