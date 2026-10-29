import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getNetwork } from "./ipam";
import { cidrOverlap } from "../ip/cidr";
import {
  MAX_RT_PER_LIST,
  VRF_NAME_PATTERN,
  normalizeRouteId,
  renderCiscoVrf,
  splitList,
} from "../vrf/rd";
import { ApiError, type CreateVrfInput, type NetworkRow, type VrfRow } from "../types";

/* ------------------------------- Lecture --------------------------------- */

interface RawVrf {
  id: number;
  name: string;
  rd: string | null;
  rt_import: string;
  rt_export: string;
  description: string | null;
  created_at: string;
  network_count: number;
  v4_pct: number | null;
}

const VRF_SELECT = `
  SELECT v.id, v.name, v.rd, v.rt_import, v.rt_export, v.description, v.created_at,
         (SELECT COUNT(*) FROM networks n WHERE n.vrf_id = v.id) AS network_count,
         (SELECT SUM(n.used_ips) * 100.0 / NULLIF(SUM(n.capacity), 0)
            FROM networks n WHERE n.vrf_id = v.id AND n.version = 4) AS v4_pct
  FROM vrfs v`;

const csv = (raw: string): string[] => raw.split(",").filter(Boolean);

function mapVrf(r: RawVrf): VrfRow {
  return {
    id: r.id,
    name: r.name,
    rd: r.rd,
    rtImport: csv(r.rt_import),
    rtExport: csv(r.rt_export),
    description: r.description,
    networkCount: r.network_count,
    ipv4UsagePct: r.v4_pct === null ? null : Math.min(100, r.v4_pct),
    createdAt: r.created_at,
  };
}

export function listVrfs(filters: { q?: string } = {}, db: Db = getDb()): VrfRow[] {
  const project = getActiveProject(db);
  const where = ["v.project_id = ?"];
  const params: (string | number)[] = [project.id];
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push("(LOWER(v.name) LIKE ? OR LOWER(COALESCE(v.rd, '')) LIKE ? OR LOWER(COALESCE(v.description, '')) LIKE ?)");
    params.push(like, like, like);
  }
  const rows = db
    .prepare(`${VRF_SELECT} WHERE ${where.join(" AND ")} ORDER BY LOWER(v.name)`)
    .all(...params) as RawVrf[];
  return rows.map(mapVrf);
}

export function getVrf(id: number, db: Db = getDb()): VrfRow {
  const project = getActiveProject(db);
  const row = db.prepare(`${VRF_SELECT} WHERE v.id = ? AND v.project_id = ?`).get(id, project.id) as
    | RawVrf
    | undefined;
  if (!row) throw new ApiError("vrfNotFound", 404);
  return mapVrf(row);
}

/** Nombre de réseaux sans VRF (table de routage globale). */
export function countGlobalNetworks(db: Db = getDb()): number {
  const project = getActiveProject(db);
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM networks WHERE project_id = ? AND vrf_id IS NULL")
    .get(project.id) as { c: number };
  return row.c;
}

/* ------------------------------ Validation ------------------------------- */

export function parseRouteTargets(input: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const item of splitList(input)) {
    const rt = normalizeRouteId(item);
    if (!rt) throw new ApiError("invalidRt", 422, { value: item });
    if (!out.includes(rt)) out.push(rt);
  }
  if (out.length > MAX_RT_PER_LIST) throw new ApiError("tooManyRt", 422, { n: MAX_RT_PER_LIST });
  return out;
}

/* --------------------------------- VRF ----------------------------------- */

export function createVrf(input: CreateVrfInput, db: Db = getDb()): VrfRow {
  const project = getActiveProject(db);

  const name = (input.name ?? "").trim();
  if (!name) throw new ApiError("nameRequired", 422);
  if (!VRF_NAME_PATTERN.test(name)) throw new ApiError("invalidVrfName", 422);

  const rdRaw = (input.rd ?? "").toString().trim();
  const rd = rdRaw ? normalizeRouteId(rdRaw) : null;
  if (rdRaw && !rd) throw new ApiError("invalidRd", 422);

  const rtImport = parseRouteTargets(input.rtImport);
  const rtExport = parseRouteTargets(input.rtExport);
  // Les route-targets ne servent que si la VRF a un RD (sinon : VRF-Lite) : on refuse une saisie qui serait ignorée.
  if (!rd && (rtImport.length > 0 || rtExport.length > 0)) throw new ApiError("rtNeedsRd", 422);

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    const d = String(input.description).trim();
    if (d.length > 200) throw new ApiError("textTooLong", 422, { max: 200 });
    description = d || null;
  }

  const run = db.transaction((): number => {
    if (db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(project.id, name)) {
      throw new ApiError("vrfNameTaken", 409, { name });
    }
    if (rd && db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND rd = ?").get(project.id, rd)) {
      throw new ApiError("rdTaken", 409, { rd });
    }
    const res = db
      .prepare(
        `INSERT INTO vrfs (project_id, name, rd, rt_import, rt_export, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project.id, name, rd, rtImport.join(","), rtExport.join(","), description, new Date().toISOString());
    return Number(res.lastInsertRowid);
  });

  return getVrf(run(), db);
}

/** Une VRF qui contient encore des réseaux ne peut pas être supprimée : ils changeraient d'espace d'adressage sans prévenir. */
export function deleteVrf(id: number, db: Db = getDb()): void {
  const vrf = getVrf(id, db);
  if (vrf.networkCount > 0) throw new ApiError("vrfInUse", 409, { n: vrf.networkCount });
  db.prepare("DELETE FROM vrfs WHERE id = ?").run(id);
}

/**
 * Déplace un réseau vers une VRF (null = table globale). Le chevauchement est vérifié dans la VRF de destination :
 * le déplacement est refusé s'il créerait deux réseaux qui se recouvrent dans le même espace d'adressage.
 */
export function moveNetworkToVrf(networkId: number, vrfId: number | null, db: Db = getDb()): NetworkRow {
  const project = getActiveProject(db);
  const net = db
    .prepare("SELECT id, cidr, version, vrf_id FROM networks WHERE id = ? AND project_id = ?")
    .get(networkId, project.id) as { id: number; cidr: string; version: number; vrf_id: number | null } | undefined;
  if (!net) throw new ApiError("networkNotFound", 404);

  if (vrfId !== null) {
    if (!Number.isInteger(vrfId)) throw new ApiError("invalidId", 400);
    getVrf(vrfId, db); // 404 si la VRF n'existe pas
  }
  if (net.vrf_id === vrfId) return getNetwork(networkId, db);

  const run = db.transaction(() => {
    const others = db
      .prepare("SELECT cidr, name FROM networks WHERE project_id = ? AND version = ? AND vrf_id IS ? AND id != ?")
      .all(project.id, net.version, vrfId, networkId) as { cidr: string; name: string }[];
    const clash = others.find((o) => cidrOverlap(o.cidr, net.cidr));
    if (clash) throw new ApiError("overlap", 409, { cidr: clash.cidr, name: clash.name });
    db.prepare("UPDATE networks SET vrf_id = ? WHERE id = ?").run(vrfId, networkId);
  });
  run();
  return getNetwork(networkId, db);
}

/* -------------------------------- Export ---------------------------------- */

/** Configuration Cisco IOS-XE de la VRF, prête à coller sur un routeur. */
export function exportVrfConfig(id: number, db: Db = getDb()): string {
  const vrf = getVrf(id, db);
  const networks = db
    .prepare("SELECT cidr, name, version FROM networks WHERE vrf_id = ? ORDER BY version, cidr")
    .all(id) as { cidr: string; name: string; version: number }[];
  return renderCiscoVrf({
    name: vrf.name,
    rd: vrf.rd,
    rtImport: vrf.rtImport,
    rtExport: vrf.rtExport,
    description: vrf.description,
    hasIpv6: networks.some((n) => n.version === 6),
    networks: networks.map((n) => ({ cidr: n.cidr, name: n.name })),
  });
}
