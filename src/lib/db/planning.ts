/**
 * Planification : plans d'adressage. Un plan = un bloc parent (éventuellement dans une VRF) + une liste de besoins
 * (nom, nombre d'hôtes ou préfixe, site, VLAN). Tant que le plan est un brouillon, l'allocation est recalculée à
 * chaque lecture à partir des réseaux existants ; « Appliquer » crée réellement les réseaux (tout ou rien) et
 * fige le plan.
 */
import { getDb, type Db } from "./index";
import { getActiveProject, createNetwork } from "./queries";
import { cidrOverlap, normalizeCidr, parseCidr } from "../ip/cidr";
import { allocatePlan, needPrefix } from "../plan/plan";
import {
  ApiError,
  type ApplyPlanInput,
  type CreatePlanInput,
  type NetworkStatus,
  type PlanDetail,
  type PlanItem,
  type PlanItemInput,
  type PlanRow,
  type PlanStatus,
  type UpdatePlanInput,
} from "../types";

export const MAX_PLAN_ITEMS = 200;
const MAX_HOSTS = 2_147_483_647;
const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];

interface RawPlan {
  id: number;
  name: string;
  parent_cidr: string;
  vrf_id: number | null;
  vrf_name: string | null;
  description: string | null;
  status: PlanStatus;
  created_at: string;
  item_count: number;
}

const PLAN_SELECT = `
  SELECT p.id, p.name, p.parent_cidr, p.vrf_id, v.name AS vrf_name, p.description, p.status, p.created_at,
         (SELECT COUNT(*) FROM plan_items i WHERE i.plan_id = p.id) AS item_count
  FROM plans p LEFT JOIN vrfs v ON v.id = p.vrf_id`;

function mapPlan(r: RawPlan): PlanRow {
  return {
    id: r.id,
    name: r.name,
    parentCidr: r.parent_cidr,
    vrfId: r.vrf_id,
    vrfName: r.vrf_name,
    description: r.description,
    status: r.status,
    itemCount: r.item_count,
    createdAt: r.created_at,
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);
  return name;
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 200) throw new ApiError("textTooLong", 422, { max: 200 });
  return s;
}

function checkVrf(db: Db, projectId: number, vrfId: unknown): number | null {
  if (vrfId === undefined || vrfId === null) return null;
  if (!Number.isInteger(vrfId)) throw new ApiError("invalidId", 400);
  if (!db.prepare("SELECT 1 FROM vrfs WHERE id = ? AND project_id = ?").get(vrfId, projectId)) throw new ApiError("vrfNotFound", 422);
  return vrfId as number;
}

interface CleanItem {
  name: string;
  hosts: number | null;
  prefix: number | null;
  siteId: number | null;
  vlan: number | null;
}

function cleanItems(db: Db, projectId: number, parentCidr: string, raw: unknown): CleanItem[] {
  if (!Array.isArray(raw)) throw new ApiError("invalidBody", 400);
  if (raw.length > MAX_PLAN_ITEMS) throw new ApiError("planTooManyItems", 422, { max: MAX_PLAN_ITEMS });
  const parent = parseCidr(parentCidr)!;
  return raw.map((x: PlanItemInput) => {
    if (!x || typeof x !== "object") throw new ApiError("invalidBody", 400);
    const name = cleanName(x.name);
    const hasHosts = x.hosts !== undefined && x.hosts !== null;
    const hasPrefix = x.prefix !== undefined && x.prefix !== null;
    if (hasHosts === hasPrefix) throw new ApiError("planItemSize", 422);
    if (hasHosts) {
      if (parent.version !== 4) throw new ApiError("planHostsV6", 422);
      if (!Number.isInteger(x.hosts) || (x.hosts as number) < 1 || (x.hosts as number) > MAX_HOSTS) throw new ApiError("planHostsInvalid", 422);
    }
    if (hasPrefix) {
      const p = needPrefix(parent.version, { hosts: null, prefix: x.prefix as number });
      // le préfixe doit exister et pouvoir tenir dans le bloc parent
      if (p === null || p < parent.prefix) throw new ApiError("planPrefixInvalid", 422);
    }
    const vlan = x.vlan ?? null;
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) throw new ApiError("invalidVlan", 422);
    const siteId = x.siteId ?? null;
    if (siteId !== null && !db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, projectId)) {
      throw new ApiError("siteNotFound", 422);
    }
    return { name, hosts: hasHosts ? (x.hosts as number) : null, prefix: hasPrefix ? (x.prefix as number) : null, siteId, vlan };
  });
}

/** Réseaux déjà existants (même projet, même VRF) qui chevauchent le bloc. */
function takenIn(db: Db, projectId: number, parentCidr: string, vrfId: number | null): string[] {
  const parent = parseCidr(parentCidr)!;
  return (
    db
      .prepare("SELECT cidr FROM networks WHERE project_id = ? AND version = ? AND vrf_id IS ? ORDER BY id")
      .all(projectId, parent.version, vrfId) as { cidr: string }[]
  )
    .map((r) => r.cidr)
    .filter((c) => cidrOverlap(c, parentCidr));
}

export function listPlans(db: Db = getDb()): PlanRow[] {
  const project = getActiveProject(db);
  return (db.prepare(`${PLAN_SELECT} WHERE p.project_id = ? ORDER BY p.id DESC`).all(project.id) as RawPlan[]).map(mapPlan);
}

export function getPlan(id: number, db: Db = getDb()): PlanDetail {
  const project = getActiveProject(db);
  const row = db.prepare(`${PLAN_SELECT} WHERE p.id = ? AND p.project_id = ?`).get(id, project.id) as RawPlan | undefined;
  if (!row) throw new ApiError("planNotFound", 404);
  const items = (
    db
      .prepare(
        `SELECT i.id, i.position, i.name, i.hosts, i.prefix, i.site_id, s.name AS site_name, i.vlan, i.applied_cidr
         FROM plan_items i LEFT JOIN sites s ON s.id = i.site_id WHERE i.plan_id = ? ORDER BY i.position`,
      )
      .all(id) as {
      id: number;
      position: number;
      name: string;
      hosts: number | null;
      prefix: number | null;
      site_id: number | null;
      site_name: string | null;
      vlan: number | null;
      applied_cidr: string | null;
    }[]
  ).map(
    (i): PlanItem => ({
      id: i.id,
      position: i.position,
      name: i.name,
      hosts: i.hosts,
      prefix: i.prefix,
      siteId: i.site_id,
      siteName: i.site_name,
      vlan: i.vlan,
      appliedCidr: i.applied_cidr,
    }),
  );
  return { ...mapPlan(row), items, taken: takenIn(db, project.id, row.parent_cidr, row.vrf_id) };
}

function replaceItems(db: Db, planId: number, items: CleanItem[]): void {
  db.prepare("DELETE FROM plan_items WHERE plan_id = ?").run(planId);
  const ins = db.prepare("INSERT INTO plan_items (plan_id, position, name, hosts, prefix, site_id, vlan) VALUES (?, ?, ?, ?, ?, ?, ?)");
  items.forEach((it, i) => ins.run(planId, i + 1, it.name, it.hosts, it.prefix, it.siteId, it.vlan));
}

export function createPlan(input: CreatePlanInput, db: Db = getDb()): PlanDetail {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const name = cleanName(input.name);
  const parent = normalizeCidr(typeof input.parentCidr === "string" ? input.parentCidr : "");
  if (!parent) throw new ApiError("invalidCidr", 422);
  const description = cleanDescription(input.description);
  const vrfId = checkVrf(db, project.id, input.vrfId);
  const items = input.items === undefined ? [] : cleanItems(db, project.id, parent, input.items);
  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO plans (project_id, name, parent_cidr, vrf_id, description, status, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)")
        .run(project.id, name, parent, vrfId, description, new Date().toISOString()).lastInsertRowid,
    );
    replaceItems(db, id, items);
    return getPlan(id, db);
  })();
}

export function updatePlan(id: number, input: UpdatePlanInput, db: Db = getDb()): PlanDetail {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const current = getPlan(id, db);
  const structural = input.parentCidr !== undefined || input.vrfId !== undefined || input.items !== undefined;
  if (current.status === "applied" && structural) throw new ApiError("planLocked", 409);

  const name = input.name !== undefined ? cleanName(input.name) : current.name;
  const description = input.description !== undefined ? cleanDescription(input.description) : current.description;
  let parent = current.parentCidr;
  if (input.parentCidr !== undefined) {
    const n = normalizeCidr(typeof input.parentCidr === "string" ? input.parentCidr : "");
    if (!n) throw new ApiError("invalidCidr", 422);
    parent = n;
  }
  const vrfId = input.vrfId !== undefined ? checkVrf(db, project.id, input.vrfId) : current.vrfId;
  // si le bloc change, les besoins existants doivent rester valides pour le nouveau bloc (même version, préfixes plausibles)
  const rawItems: PlanItemInput[] =
    input.items !== undefined
      ? input.items
      : current.items.map((i) => ({ name: i.name, hosts: i.hosts, prefix: i.prefix, siteId: i.siteId, vlan: i.vlan }));
  const items = current.status === "applied" ? null : cleanItems(db, project.id, parent, rawItems);

  return db.transaction(() => {
    db.prepare("UPDATE plans SET name = ?, parent_cidr = ?, vrf_id = ?, description = ? WHERE id = ?").run(name, parent, vrfId, description, id);
    if (items) replaceItems(db, id, items);
    return getPlan(id, db);
  })();
}

export function deletePlan(id: number, db: Db = getDb()): void {
  getPlan(id, db); // 404 si absent du projet actif
  db.prepare("DELETE FROM plans WHERE id = ?").run(id); // les réseaux déjà créés par le plan sont conservés
}

/**
 * Crée les réseaux du plan à leur emplacement calculé, tout ou rien : si un seul besoin n'a pas de place, rien n'est créé.
 * Chaque réseau passe par createNetwork (mêmes contrôles que l'interface, dont le chevauchement).
 */
export function applyPlan(id: number, input: ApplyPlanInput = {}, db: Db = getDb()): PlanDetail {
  const plan = getPlan(id, db);
  if (plan.status === "applied") throw new ApiError("planLocked", 409);
  if (plan.items.length === 0) throw new ApiError("planNoItems", 422);
  const status = input.status ?? "inactive";
  if (!STATUSES.includes(status)) throw new ApiError("invalidStatus", 422);

  const alloc = allocatePlan(plan.parentCidr, plan.taken, plan.items);
  const failed = alloc.filter((a) => a.cidr === null).length;
  if (failed > 0) throw new ApiError("planCannotApply", 409, { n: failed });

  return db.transaction(() => {
    plan.items.forEach((item, i) => {
      const cidr = alloc[i].cidr!;
      createNetwork({ cidr, name: item.name, siteId: item.siteId, vlan: item.vlan, vrfId: plan.vrfId, status }, db, { skipRequired: true });
      db.prepare("UPDATE plan_items SET applied_cidr = ? WHERE id = ?").run(cidr, item.id);
    });
    db.prepare("UPDATE plans SET status = 'applied' WHERE id = ?").run(id);
    return getPlan(id, db);
  })();
}
