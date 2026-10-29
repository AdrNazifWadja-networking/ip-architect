/**
 * Rapports : vues de synthèse calculées en direct depuis le projet actif (rien n'est stocké).
 *
 * Chaque rapport est une liste de tableaux génériques (colonnes typées + lignes) : la page les affiche, l'export CSV
 * et l'impression réutilisent exactement les mêmes données. Les libellés de colonnes sont traduits côté affichage
 * (t.reports.columns[clé]) ; ici on ne produit que des clés et des valeurs.
 *
 * Capacités : les totaux d'adresses ne portent que sur l'IPv4. Un réseau IPv6 contient des milliards de milliards
 * d'adresses : une « occupation » en pourcentage n'aurait aucun sens, ces cellules restent vides (null).
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getOrgName } from "./appsettings";
import { parseIp } from "../ip/cidr";
import { ApiError } from "../types";

export { REPORT_KINDS, isReportKind, type ReportKind, type ColumnType, type ReportColumn, type ReportCell, type ReportTable, type Report } from "../reportTypes";
import { isReportKind, type Report, type ReportCell, type ReportKind, type ReportTable } from "../reportTypes";

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.min(100, (part / whole) * 100) : null);
const free = (cap: number, used: number, reserved: number): number => Math.max(0, cap - used - reserved);

interface NetRow {
  id: number;
  cidr: string;
  name: string;
  version: 4 | 6;
  site_id: number | null;
  site_name: string | null;
  vlan: number | null;
  vrf_id: number | null;
  vrf_name: string | null;
  status: string;
  used_ips: number;
  reserved_ips: number;
  capacity: number;
}

function loadNetworks(db: Db, projectId: number): NetRow[] {
  return db
    .prepare(
      `SELECT n.id, n.cidr, n.name, n.version, n.site_id, s.name AS site_name, n.vlan, n.vrf_id, v.name AS vrf_name,
              n.status, n.used_ips, n.reserved_ips, n.capacity
       FROM networks n LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN vrfs v ON v.id = n.vrf_id
       WHERE n.project_id = ? ORDER BY LOWER(COALESCE(s.name, '')), n.version, n.cidr`,
    )
    .all(projectId) as NetRow[];
}

const count = (db: Db, sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { c: number }).c;

/** Totaux IPv4 d'un groupe de réseaux. */
function v4Totals(nets: NetRow[]) {
  const v4 = nets.filter((n) => n.version === 4);
  const capacity = v4.reduce((a, n) => a + n.capacity, 0);
  const used = v4.reduce((a, n) => a + n.used_ips, 0);
  const reserved = v4.reduce((a, n) => a + n.reserved_ips, 0);
  return { capacity, used, reserved, free: free(capacity, used, reserved), occupancy: pct(used + reserved, capacity), hasV4: v4.length > 0 };
}

/* ---------------------------------- Rapports ---------------------------------- */

function summary(db: Db, projectId: number): ReportTable[] {
  const nets = loadNetworks(db, projectId);
  const v4 = v4Totals(nets);
  const c = (sql: string) => count(db, sql, projectId);
  const rows: ReportCell[][] = [
    ["networks", nets.length],
    ["networksV4", nets.filter((n) => n.version === 4).length],
    ["networksV6", nets.filter((n) => n.version === 6).length],
    ["sites", c("SELECT COUNT(*) AS c FROM sites WHERE project_id = ?")],
    ["vlans", c("SELECT COUNT(*) AS c FROM vlans WHERE project_id = ?")],
    ["vrfs", c("SELECT COUNT(*) AS c FROM vrfs WHERE project_id = ?")],
    ["scopes", c("SELECT COUNT(*) AS c FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id WHERE n.project_id = ?")],
    [
      "reservations",
      c(
        `SELECT COUNT(*) AS c FROM dhcp_reservations r JOIN dhcp_scopes d ON d.id = r.scope_id
         JOIN networks n ON n.id = d.network_id WHERE n.project_id = ?`,
      ),
    ],
    ["addresses", c("SELECT COUNT(*) AS c FROM ip_addresses a JOIN networks n ON n.id = a.network_id WHERE n.project_id = ?")],
    ["v4Capacity", v4.hasV4 ? v4.capacity : null],
    ["v4Used", v4.hasV4 ? v4.used : null],
    ["v4Reserved", v4.hasV4 ? v4.reserved : null],
    ["v4Free", v4.hasV4 ? v4.free : null],
    ["v4Occupancy", v4.occupancy],
  ];
  // une ligne par indicateur ; le type dépend de la ligne (pourcentage pour l'occupation), exprimé par la clé
  const statuses = ["active", "inactive", "maintenance", "error"];
  return [
    { id: "totals", columns: [{ key: "metric", type: "status" }, { key: "value", type: "int" }], rows },
    {
      id: "byStatus",
      columns: [{ key: "status", type: "status" }, { key: "networks", type: "int" }, { key: "share", type: "pct" }],
      rows: statuses.map((s) => {
        const n = nets.filter((x) => x.status === s).length;
        return [s, n, pct(n, nets.length)];
      }),
    },
  ];
}

function sites(db: Db, projectId: number): ReportTable[] {
  const nets = loadNetworks(db, projectId);
  const siteRows = db.prepare("SELECT id, name FROM sites WHERE project_id = ? ORDER BY LOWER(name)").all(projectId) as {
    id: number;
    name: string;
  }[];
  const vlanCount = new Map(
    (db.prepare("SELECT site_id, COUNT(*) AS c FROM vlans WHERE project_id = ? GROUP BY site_id").all(projectId) as {
      site_id: number | null;
      c: number;
    }[]).map((r) => [r.site_id, r.c]),
  );
  const groups: { name: string | null; id: number | null }[] = [...siteRows.map((s) => ({ name: s.name, id: s.id as number | null }))];
  if (nets.some((n) => n.site_id === null) || vlanCount.has(null)) groups.push({ name: null, id: null });

  const rows: ReportCell[][] = groups.map((g) => {
    const mine = nets.filter((n) => n.site_id === g.id);
    const t = v4Totals(mine);
    return [g.name, mine.length, vlanCount.get(g.id) ?? 0, t.hasV4 ? t.capacity : null, t.hasV4 ? t.used : null, t.hasV4 ? t.reserved : null, t.hasV4 ? t.free : null, t.occupancy];
  });
  const all = v4Totals(nets);
  return [
    {
      id: "sites",
      columns: [
        { key: "site", type: "text" },
        { key: "networks", type: "int" },
        { key: "vlans", type: "int" },
        { key: "capacity", type: "int" },
        { key: "used", type: "int" },
        { key: "reserved", type: "int" },
        { key: "free", type: "int" },
        { key: "occupancy", type: "pct" },
      ],
      rows,
      footer: [
        null,
        nets.length,
        [...vlanCount.values()].reduce((a, b) => a + b, 0),
        all.hasV4 ? all.capacity : null,
        all.hasV4 ? all.used : null,
        all.hasV4 ? all.reserved : null,
        all.hasV4 ? all.free : null,
        all.occupancy,
      ],
    },
  ];
}

function networks(db: Db, projectId: number): ReportTable[] {
  const nets = loadNetworks(db, projectId);
  const scopes = new Map(
    (db
      .prepare(
        `SELECT d.network_id AS id, COUNT(*) AS c FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
         WHERE n.project_id = ? GROUP BY d.network_id`,
      )
      .all(projectId) as { id: number; c: number }[]).map((r) => [r.id, r.c]),
  );
  const rows: ReportCell[][] = nets.map((n) => {
    const v4 = n.version === 4;
    return [
      n.cidr,
      n.name,
      n.site_name,
      n.vrf_name,
      n.vlan,
      n.status,
      v4 ? n.capacity : null,
      n.used_ips,
      n.reserved_ips,
      v4 ? free(n.capacity, n.used_ips, n.reserved_ips) : null,
      v4 ? pct(n.used_ips + n.reserved_ips, n.capacity) : null,
      scopes.get(n.id) ?? 0,
    ];
  });
  const t = v4Totals(nets);
  return [
    {
      id: "networks",
      columns: [
        { key: "cidr", type: "text" },
        { key: "name", type: "text" },
        { key: "site", type: "text" },
        { key: "vrf", type: "text" },
        { key: "vlan", type: "int" },
        { key: "status", type: "status" },
        { key: "capacity", type: "int" },
        { key: "used", type: "int" },
        { key: "reserved", type: "int" },
        { key: "free", type: "int" },
        { key: "occupancy", type: "pct" },
        { key: "scopes", type: "int" },
      ],
      rows,
      footer: [null, null, null, null, null, null, t.hasV4 ? t.capacity : null, t.used, t.reserved, t.hasV4 ? t.free : null, t.occupancy, [...scopes.values()].reduce((a, b) => a + b, 0)],
    },
  ];
}

function dhcp(db: Db, projectId: number): ReportTable[] {
  const scopes = db
    .prepare(
      `SELECT d.id, d.name, n.cidr, v.name AS vrf, d.range_start, d.range_end, d.lease_seconds, d.enabled,
              (SELECT COUNT(*) FROM dhcp_reservations r WHERE r.scope_id = d.id) AS reservations
       FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id LEFT JOIN vrfs v ON v.id = n.vrf_id
       WHERE n.project_id = ? ORDER BY n.id, d.id`,
    )
    .all(projectId) as {
    id: number;
    name: string;
    cidr: string;
    vrf: string | null;
    range_start: string;
    range_end: string;
    lease_seconds: number;
    enabled: number;
    reservations: number;
  }[];
  const rows: ReportCell[][] = scopes.map((s) => {
    const lo = parseIp(s.range_start)?.value;
    const hi = parseIp(s.range_end)?.value;
    const size = lo !== undefined && hi !== undefined && hi >= lo ? Number(hi - lo + 1n) : null;
    return [s.name, s.cidr, s.vrf, s.range_start, s.range_end, size, s.reservations, s.lease_seconds, s.enabled === 1];
  });
  const sizes = rows.map((r) => r[5] as number | null).filter((n): n is number => n !== null);
  return [
    {
      id: "dhcp",
      columns: [
        { key: "scope", type: "text" },
        { key: "network", type: "text" },
        { key: "vrf", type: "text" },
        { key: "rangeStart", type: "text" },
        { key: "rangeEnd", type: "text" },
        { key: "poolSize", type: "int" },
        { key: "reservations", type: "int" },
        { key: "lease", type: "int" },
        { key: "enabled", type: "bool" },
      ],
      rows,
      footer: [null, null, null, null, null, sizes.reduce((a, b) => a + b, 0), scopes.reduce((a, s) => a + s.reservations, 0), null, null],
    },
  ];
}

function vlans(db: Db, projectId: number): ReportTable[] {
  const defined = db
    .prepare(
      `SELECT v.number, v.name, v.site_id, s.name AS site FROM vlans v LEFT JOIN sites s ON s.id = v.site_id
       WHERE v.project_id = ? ORDER BY LOWER(COALESCE(s.name, '')), v.number`,
    )
    .all(projectId) as { number: number; name: string; site_id: number | null; site: string | null }[];
  const nets = loadNetworks(db, projectId);
  const key = (site: number | null, number: number) => `${site ?? 0}:${number}`;
  const byVlan = new Map<string, NetRow[]>();
  for (const n of nets) {
    if (n.vlan === null) continue;
    const k = key(n.site_id, n.vlan);
    byVlan.set(k, [...(byVlan.get(k) ?? []), n]);
  }
  const rows: ReportCell[][] = defined.map((v) => {
    const mine = byVlan.get(key(v.site_id, v.number)) ?? [];
    return [v.number, v.name, v.site, mine.length, mine.map((n) => n.cidr).join(" "), true];
  });
  // VLAN utilisés par un réseau mais jamais définis : à corriger
  const definedKeys = new Set(defined.map((v) => key(v.site_id, v.number)));
  for (const [k, list] of byVlan) {
    if (definedKeys.has(k)) continue;
    rows.push([list[0].vlan, null, list[0].site_name, list.length, list.map((n) => n.cidr).join(" "), false]);
  }
  return [
    {
      id: "vlans",
      columns: [
        { key: "number", type: "int" },
        { key: "name", type: "text" },
        { key: "site", type: "text" },
        { key: "networks", type: "int" },
        { key: "cidrs", type: "text" },
        { key: "defined", type: "bool" },
      ],
      rows,
    },
  ];
}

function vrf(db: Db, projectId: number): ReportTable[] {
  const nets = loadNetworks(db, projectId);
  const list = db.prepare("SELECT id, name, rd FROM vrfs WHERE project_id = ? ORDER BY LOWER(name)").all(projectId) as {
    id: number;
    name: string;
    rd: string | null;
  }[];
  const groups: { id: number | null; name: string | null; rd: string | null }[] = [
    { id: null, name: null, rd: null },
    ...list.map((v) => ({ id: v.id as number | null, name: v.name as string | null, rd: v.rd })),
  ];
  const rows: ReportCell[][] = groups
    .map((g) => {
      const mine = nets.filter((n) => n.vrf_id === g.id);
      const t = v4Totals(mine);
      return { g, mine, row: [g.name, g.rd, mine.length, t.hasV4 ? t.capacity : null, t.hasV4 ? t.used : null, t.hasV4 ? t.reserved : null, t.occupancy] as ReportCell[] };
    })
    // la table globale n'apparaît que si elle contient quelque chose
    .filter((x) => x.g.id !== null || x.mine.length > 0)
    .map((x) => x.row);
  return [
    {
      id: "vrf",
      columns: [
        { key: "vrf", type: "text" },
        { key: "rd", type: "text" },
        { key: "networks", type: "int" },
        { key: "capacity", type: "int" },
        { key: "used", type: "int" },
        { key: "reserved", type: "int" },
        { key: "occupancy", type: "pct" },
      ],
      rows,
    },
  ];
}

const BUILDERS: Record<ReportKind, (db: Db, projectId: number) => ReportTable[]> = {
  summary,
  sites,
  networks,
  dhcp,
  vlans,
  vrf,
};

export function getReport(kind: string, db: Db = getDb()): Report {
  if (!isReportKind(kind)) throw new ApiError("invalidReport", 404);
  const project = getActiveProject(db);
  return {
    kind,
    project: project.name,
    organization: getOrgName(db),
    generatedAt: new Date().toISOString(),
    tables: BUILDERS[kind](db, project.id),
  };
}
