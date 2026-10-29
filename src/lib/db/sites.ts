/** Sites : emplacements physiques (bureau, datacenter, agence…) auxquels se rattachent réseaux et VLANs. */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { ApiError, type CreateSiteInput, type SiteRow, type UpdateSiteInput } from "../types";

interface RawSite {
  id: number;
  name: string;
  address: string | null;
  description: string | null;
  created_at: string | null;
  network_count: number;
  vlan_count: number;
  v4_pct: number | null;
}

const SITE_SELECT = `
  SELECT s.id, s.name, s.address, s.description, s.created_at,
         (SELECT COUNT(*) FROM networks n WHERE n.site_id = s.id) AS network_count,
         (SELECT COUNT(*) FROM vlans v WHERE v.site_id = s.id) AS vlan_count,
         (SELECT SUM(n.used_ips) * 100.0 / NULLIF(SUM(n.capacity), 0)
            FROM networks n WHERE n.site_id = s.id AND n.version = 4) AS v4_pct
  FROM sites s`;

function mapSite(r: RawSite): SiteRow {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    description: r.description,
    networkCount: r.network_count,
    vlanCount: r.vlan_count,
    ipv4UsagePct: r.v4_pct === null ? null : Math.min(100, r.v4_pct),
    createdAt: r.created_at,
  };
}

/** Texte libre facultatif : vide -> null, trop long -> erreur. */
function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new ApiError("textTooLong", 422, { max });
  return s;
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);
  return name;
}

/** Deux sites d'un même projet ne peuvent pas porter le même nom (casse ignorée). */
function assertNameFree(db: Db, projectId: number, name: string, exceptId?: number): void {
  // comparaison en JavaScript : le LOWER() de SQLite ne connaît que l'ASCII (« Lomé » et « LOMÉ » seraient deux noms)
  const wanted = name.toLowerCase();
  const rows = db.prepare("SELECT id, name FROM sites WHERE project_id = ?").all(projectId) as unknown as Array<{ id: number; name: string }>;
  const row = rows.find((r) => r.id !== exceptId && r.name.toLowerCase() === wanted);
  if (row) throw new ApiError("siteNameTaken", 409, { name });
}

export function listSitesDetailed(filters: { q?: string } = {}, db: Db = getDb()): SiteRow[] {
  const project = getActiveProject(db);
  const where = ["s.project_id = ?"];
  const params: (string | number)[] = [project.id];
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push("(LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.address, '')) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ?)");
    params.push(like, like, like);
  }
  const rows = db
    .prepare(`${SITE_SELECT} WHERE ${where.join(" AND ")} ORDER BY LOWER(s.name)`)
    .all(...params) as RawSite[];
  return rows.map(mapSite);
}

export function getSite(id: number, db: Db = getDb()): SiteRow {
  const project = getActiveProject(db);
  const row = db.prepare(`${SITE_SELECT} WHERE s.id = ? AND s.project_id = ?`).get(id, project.id) as RawSite | undefined;
  if (!row) throw new ApiError("siteNotFound", 404);
  return mapSite(row);
}

export function createSite(input: CreateSiteInput, db: Db = getDb()): SiteRow {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const name = cleanName(input.name);
  const address = cleanText(input.address, 200);
  const description = cleanText(input.description, 200);
  return db.transaction(() => {
    assertNameFree(db, project.id, name);
    const id = Number(
      db
        .prepare("INSERT INTO sites (project_id, name, address, description, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(project.id, name, address, description, new Date().toISOString()).lastInsertRowid,
    );
    return getSite(id, db);
  })();
}

export function updateSite(id: number, input: UpdateSiteInput, db: Db = getDb()): SiteRow {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) {
    throw new ApiError("invalidBody", 400);
  }
  const project = getActiveProject(db);
  const current = getSite(id, db);

  const name = input.name !== undefined ? cleanName(input.name) : current.name;
  const address = input.address !== undefined ? cleanText(input.address, 200) : current.address;
  const description = input.description !== undefined ? cleanText(input.description, 200) : current.description;

  return db.transaction(() => {
    if (name.toLowerCase() !== current.name.toLowerCase()) assertNameFree(db, project.id, name, id);
    db.prepare("UPDATE sites SET name = ?, address = ?, description = ? WHERE id = ?").run(name, address, description, id);
    return getSite(id, db);
  })();
}

/**
 * Un site qui contient encore des réseaux ou des VLANs ne se supprime pas : la base les « détacherait » en silence
 * (et deux VLANs de même numéro pourraient alors entrer en collision dans l'espace global).
 */
export function deleteSite(id: number, db: Db = getDb()): void {
  const site = getSite(id, db);
  const n = site.networkCount + site.vlanCount;
  if (n > 0) throw new ApiError("siteInUse", 409, { networks: site.networkCount, vlans: site.vlanCount });
  db.prepare("DELETE FROM sites WHERE id = ?").run(id);
}
