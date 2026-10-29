/**
 * Outils de l'assistant : TOUS en lecture seule, sur le projet actif. Le modèle ne calcule rien lui-même : chaque chiffre,
 * adresse ou découpage vient d'ici (moteur IP exact en BigInt, supervision, simulateur, rapports).
 *
 * Une erreur d'outil (paramètre invalide, objet introuvable) est renvoyée AU MODÈLE sous forme { error }, pour qu'il puisse
 * se corriger ; elle n'interrompt pas la conversation.
 */
import { getDb, type Db } from "../db";
import { listNetworks, getActiveProject } from "../db/queries";
import { getNetwork, listAddresses, listVlans } from "../db/ipam";
import { listScopes } from "../db/dhcp";
import { listVrfs } from "../db/vrf";
import { listSitesDetailed } from "../db/sites";
import { getMonitoring } from "../db/monitoring";
import { getReport } from "../db/reports";
import { isSimMode, simulate } from "../db/simulator";
import { calcSubnet, cidrContains, formatIp, normalizeCidr, parseIp } from "../ip/cidr";
import { REPORT_KINDS } from "../reportTypes";
import { ApiError, type NetworkStatus } from "../types";
import { AI_TOOL_RESULT_MAX_CHARS } from "./types";
import type { LlmTool } from "./client";

const MAX_ROWS = 60;
const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): LlmTool => ({
  type: "function",
  // Gemini est strict sur les schémas : « required » vide et « enum » non textuel sont refusés (400)
  function: { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}) } },
});

export const TOOLS: LlmTool[] = [
  fn("get_report", "Rapport de synthèse calculé sur le projet actif : summary (totaux, capacité IPv4, réseaux par statut), sites (occupation par site), networks (inventaire), dhcp, vlans, vrf.", {
    kind: { type: "string", enum: [...REPORT_KINDS] },
  }, ["kind"]),
  fn("list_networks", "Liste les réseaux du projet (CIDR, nom, site, VLAN, VRF, statut, adresses utilisées/réservées, occupation). Filtres facultatifs.", {
    q: { type: "string", description: "texte recherché dans le CIDR, le nom, le site ou la VRF" },
    status: { type: "string", enum: STATUSES },
    version: { type: "integer", description: "4 ou 6" },
  }),
  fn("get_network", "Détail d'un réseau (par id ou par CIDR exact) : adresses inventoriées et plages DHCP.", {
    id: { type: "integer" },
    cidr: { type: "string", description: "ex. 10.1.10.0/24" },
  }),
  fn("search_address", "Trouve une adresse IP : où elle est inventoriée (hôte, statut) et dans quels réseaux elle se situe.", {
    address: { type: "string", description: "ex. 10.1.10.15" },
  }, ["address"]),
  fn("list_vlans", "Liste les VLANs (numéro, nom, site, nombre de réseaux).", { q: { type: "string" } }),
  fn("list_sites", "Liste les sites (adresse, nombre de réseaux et de VLANs, utilisation IPv4).", { q: { type: "string" } }),
  fn("list_vrfs", "Liste les VRF (RD, route targets, nombre de réseaux, utilisation IPv4)."),
  fn("list_dhcp_scopes", "Liste les plages DHCP (réseau, plage, passerelle, DNS, bail, réservations, adresses distribuables, conflits)."),
  fn("monitoring_status", "État de santé de l'adressage : contrôles (capacité, VLAN non défini, noms d'hôte en double, adresse statique dans une plage DHCP…), occupation par réseau et prévision de saturation."),
  fn("calculate_subnet", "Calcule exactement un sous-réseau IPv4 ou IPv6 : réseau, diffusion, masque, première/dernière adresse, nombre d'adresses.", {
    cidr: { type: "string", description: "ex. 192.168.1.37/26" },
  }, ["cidr"]),
  fn("simulate", "Simulation en lecture seule. split : découper un réseau (networkId ou cidr, newPrefix). merge : agréger (cidrs[] et/ou networkIds[]). free : espace libre d'un bloc (parent, vrfId?, prefix? pour trouver le premier emplacement). fit : un CIDR peut-il être créé ? (cidr, vrfId?).", {
    mode: { type: "string", enum: ["split", "merge", "free", "fit"] },
    cidr: { type: "string" },
    networkId: { type: "integer" },
    newPrefix: { type: "integer" },
    cidrs: { type: "array", items: { type: "string" } },
    networkIds: { type: "array", items: { type: "integer" } },
    parent: { type: "string" },
    vrfId: { type: "integer" },
    prefix: { type: "integer" },
  }, ["mode"]),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

/** JSON sûr : les BigInt deviennent du texte. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function capped<T>(rows: T[]): { total: number; truncated: boolean; rows: T[] } {
  return { total: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) };
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

function requireStr(v: unknown, what: string): string {
  const s = str(v);
  if (!s) throw new ApiError("invalidBody", 400, { what });
  return s;
}

function runTool(name: string, a: Record<string, unknown>, db: Db): unknown {
  switch (name) {
    case "get_report": {
      const kind = str(a.kind);
      const r = getReport(kind ?? "", db);
      return {
        kind: r.kind,
        project: r.project,
        tables: r.tables.map((t) => ({
          id: t.id,
          columns: t.columns.map((c) => c.key),
          ...capped(t.rows),
          footer: t.footer ?? null,
        })),
        note: "Capacités et occupations : IPv4 uniquement. null = sans objet.",
      };
    }
    case "list_networks": {
      const status = str(a.status) as NetworkStatus | undefined;
      const version = int(a.version);
      const rows = listNetworks(
        { q: str(a.q), status: status && STATUSES.includes(status) ? status : undefined, version: version === 4 || version === 6 ? version : undefined },
        db,
      ).map((n) => ({
        id: n.id,
        cidr: n.cidr,
        name: n.name,
        site: n.siteName,
        vlan: n.vlan,
        vrf: n.vrfName ?? "globale",
        status: n.status,
        used: n.usedIps,
        reserved: n.reservedIps,
        ...(n.version === 4 ? { capacity: n.capacity, usagePct: Math.round(n.usagePct * 10) / 10 } : {}),
      }));
      return capped(rows);
    }
    case "get_network": {
      const id = int(a.id);
      const cidrIn = str(a.cidr);
      let net;
      if (id !== undefined) net = getNetwork(id, db);
      else if (cidrIn) {
        const cidr = normalizeCidr(cidrIn);
        const found = cidr ? listNetworks({}, db).filter((n) => n.cidr === cidr) : [];
        if (found.length === 0) throw new ApiError("networkNotFound", 404);
        net = found[0];
        if (found.length > 1) return { error: "plusieurs réseaux ont ce CIDR (VRF différentes) : précisez l'id", candidates: found.map((n) => ({ id: n.id, vrf: n.vrfName ?? "globale" })) };
      } else throw new ApiError("invalidBody", 400);
      const addrs = listAddresses(net.id, db).map((x) => ({ address: x.address, status: x.status, hostname: x.hostname, description: x.description }));
      const scopes = listScopes({}, db)
        .filter((s) => s.networkId === net.id)
        .map((s) => ({ name: s.name, range: `${s.rangeStart} - ${s.rangeEnd}`, gateway: s.gateway, enabled: s.enabled, reservations: s.reservationCount, distributable: s.distributable }));
      return {
        network: { id: net.id, cidr: net.cidr, name: net.name, site: net.siteName, vlan: net.vlan, vrf: net.vrfName ?? "globale", status: net.status, used: net.usedIps, reserved: net.reservedIps, ...(net.version === 4 ? { capacity: net.capacity } : {}) },
        addresses: capped(addrs),
        dhcpScopes: scopes,
      };
    }
    case "search_address": {
      const raw = requireStr(a.address, "address");
      const p = parseIp(raw);
      if (!p) throw new ApiError("invalidAddress", 422);
      const addr = formatIp(p.version, p.value);
      const project = getActiveProject(db);
      const inventoried = (
        db
          .prepare(
            `SELECT n.id AS network_id, n.cidr, n.name AS network_name, v.name AS vrf, x.status, x.hostname, x.description
             FROM ip_addresses x JOIN networks n ON n.id = x.network_id LEFT JOIN vrfs v ON v.id = n.vrf_id
             WHERE n.project_id = ? AND x.address = ?`,
          )
          .all(project.id, addr) as Record<string, unknown>[]
      ).map((r) => ({ networkId: r.network_id, network: r.cidr, networkName: r.network_name, vrf: r.vrf ?? "globale", status: r.status, hostname: r.hostname, description: r.description }));
      const containing = listNetworks({}, db)
        .filter((n) => cidrContains(n.cidr, `${addr}/${p.version === 4 ? 32 : 128}`))
        .map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, vrf: n.vrfName ?? "globale", site: n.siteName }));
      return { address: addr, inventoried, containedInNetworks: containing };
    }
    case "list_vlans":
      return capped(listVlans({ q: str(a.q) }, db).map((v) => ({ number: v.number, name: v.name, site: v.siteName, networks: v.networkCount })));
    case "list_sites":
      return capped(listSitesDetailed({ q: str(a.q) }, db).map((s) => ({ name: s.name, address: s.address, description: s.description, networks: s.networkCount, vlans: s.vlanCount, ipv4UsagePct: s.ipv4UsagePct === null ? null : Math.round(s.ipv4UsagePct * 10) / 10 })));
    case "list_vrfs":
      return capped(listVrfs({}, db).map((v) => ({ name: v.name, rd: v.rd, rtImport: v.rtImport, rtExport: v.rtExport, description: v.description, networks: v.networkCount, ipv4UsagePct: v.ipv4UsagePct === null ? null : Math.round(v.ipv4UsagePct * 10) / 10 })));
    case "list_dhcp_scopes":
      return capped(listScopes({}, db).map((s) => ({ id: s.id, name: s.name, network: s.networkCidr, site: s.siteName, range: `${s.rangeStart} - ${s.rangeEnd}`, gateway: s.gateway, dns: s.dns, leaseSeconds: s.leaseSeconds, enabled: s.enabled, poolSize: s.poolSize, reservations: s.reservationCount, conflicts: s.conflictCount, distributable: s.distributable })));
    case "monitoring_status": {
      const m = getMonitoring(db);
      return {
        status: m.status,
        counts: m.counts,
        thresholds: m.thresholds,
        findings: capped(m.findings.map((f) => ({ kind: f.kind, severity: f.severity, ...f.params }))),
        mostOccupied: m.capacity.slice(0, 10).map((c) => ({ cidr: c.cidr, name: c.name, site: c.siteName, occupancyPct: Math.round(c.occupancyPct * 10) / 10, level: c.level })),
        forecast: m.forecast,
      };
    }
    case "calculate_subnet": {
      const s = calcSubnet(requireStr(a.cidr, "cidr"));
      if (!s) throw new ApiError("invalidCidr", 422);
      return s;
    }
    case "simulate": {
      const mode = str(a.mode);
      if (!isSimMode(mode)) throw new ApiError("simInvalid", 422);
      const { mode: _m, ...params } = a;
      return simulate(mode, params, db);
    }
    default:
      throw new ApiError("simInvalid", 422);
  }
}

export interface ToolOutcome {
  content: string;
  args: Record<string, unknown>;
  failed: boolean;
}

/** Exécute un appel d'outil demandé par le modèle. Ne lève jamais : renvoie le texte à lui retransmettre. */
export function executeTool(name: string, rawArgs: string, db: Db = getDb()): ToolOutcome {
  let args: Record<string, unknown> = {};
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    else return { content: toJson({ error: "les arguments doivent être un objet JSON" }), args, failed: true };
  } catch {
    return { content: toJson({ error: "arguments JSON invalides" }), args, failed: true };
  }
  if (!TOOL_NAMES.has(name)) return { content: toJson({ error: `outil inconnu : ${name.slice(0, 60)}` }), args, failed: true };
  try {
    let text = toJson(runTool(name, args, db));
    if (text.length > AI_TOOL_RESULT_MAX_CHARS) {
      text = toJson({ truncated: true, note: "résultat trop long, tronqué : affinez la demande (filtre q, réseau précis)", partial: text.slice(0, AI_TOOL_RESULT_MAX_CHARS) });
    }
    return { content: text, args, failed: false };
  } catch (e) {
    // les codes d'erreur de l'application sont des phrases courtes sans donnée sensible
    if (e instanceof ApiError) return { content: toJson({ error: e.code, ...(e.params ?? {}) }), args, failed: true };
    console.error("assistant : outil en échec", name, e);
    return { content: toJson({ error: "erreur interne de l'outil" }), args, failed: true };
  }
}
