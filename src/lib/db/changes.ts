/**
 * Instantanés « avant / après » pour le journal d'audit : pour un objet, la liste des champs utiles à un humain
 * (valeurs lisibles : nom du site, nom de la VRF…), choisis UN PAR UN. Aucun mot de passe, jeton, clé d'API,
 * adresse e-mail ni empreinte n'y figure jamais. `snapshot` ne lève pas d'exception : en cas de problème, null.
 */
import { getDb, type Db } from "./index";
import { getAppSettings } from "./appsettings";
import { getAiConfig } from "./aisettings";
import { getAlertConfig } from "./alerts";
import { getSignupConfig } from "./signupsettings";
import { getSsoConfig } from "./ssosettings";
import { diffSnapshots, type ChangeSet, type Snapshot } from "../changeTypes";
import type { AuditEntity } from "../auditTypes";

export type SnapshotKind = AuditEntity | "signupSettings" | "ssoSettings" | "assistantSettings" | "alertSettings";

type Row = Record<string, string | number | null>;

const SQL: Partial<Record<AuditEntity, { sql: string; bool?: string[] }>> = {
  network: {
    sql: `SELECT n.name, n.cidr, s.name AS site, n.vlan, n.status, v.name AS vrf, n.used_ips AS usedIps, n.reserved_ips AS reservedIps,
                 (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT g.name FROM network_tags x JOIN tags g ON g.id = x.tag_id WHERE x.network_id = n.id ORDER BY LOWER(g.name))) AS tags,
                 (SELECT GROUP_CONCAT(k || '=' || val, ', ') FROM (SELECT f.key AS k, v.value AS val FROM network_custom_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.network_id = n.id ORDER BY f.key)) AS fields
          FROM networks n LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN vrfs v ON v.id = n.vrf_id WHERE n.id = ?`,
  },
  address: {
    sql: `SELECT address, status, hostname, description,
                 (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT g.name FROM address_tags x JOIN tags g ON g.id = x.tag_id WHERE x.address_id = ip_addresses.id ORDER BY LOWER(g.name))) AS tags,
                 (SELECT GROUP_CONCAT(k || '=' || val, ', ') FROM (SELECT f.key AS k, v.value AS val FROM address_custom_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.address_id = ip_addresses.id ORDER BY f.key)) AS fields
          FROM ip_addresses WHERE id = ?`,
  },
  tag: { sql: "SELECT name, color FROM tags WHERE id = ?" },
  // l'adresse complète peut contenir un secret (Slack, Teams…) : on ne journalise que le nom, les événements et l'état
  webhook: { sql: "SELECT name, events, active FROM webhooks WHERE id = ?", bool: ["active"] },
  customField: { sql: "SELECT entity, key, label, type, options, required FROM custom_fields WHERE id = ?", bool: ["required"] },
  vlan: { sql: "SELECT v.number, v.name, s.name AS site FROM vlans v LEFT JOIN sites s ON s.id = v.site_id WHERE v.id = ?" },
  site: { sql: "SELECT name, address, description FROM sites WHERE id = ?" },
  vrf: { sql: "SELECT name, rd, rt_import AS rtImport, rt_export AS rtExport, description FROM vrfs WHERE id = ?" },
  project: { sql: "SELECT name, description FROM projects WHERE id = ?" },
  dhcpScope: {
    sql: "SELECT name, range_start AS rangeStart, range_end AS rangeEnd, gateway, dns, lease_seconds AS leaseSeconds, enabled FROM dhcp_scopes WHERE id = ?",
    bool: ["enabled"],
  },
  dhcpReservation: { sql: "SELECT mac, address, hostname, description FROM dhcp_reservations WHERE id = ?" },
  plan: {
    sql: "SELECT p.name, p.description, p.parent_cidr AS parentCidr, p.status, v.name AS vrf FROM plans p LEFT JOIN vrfs v ON v.id = p.vrf_id WHERE p.id = ?",
  },
  tpClass: {
    // les noms des étudiants ne sont pas journalisés : seulement leur nombre
    sql: "SELECT name, (SELECT COUNT(*) FROM tp_class_members WHERE class_id = tp_classes.id) AS members FROM tp_classes WHERE id = ?",
  },
  exercise: {
    sql: "SELECT title, description, max_attempts AS maxAttempts, due_at AS dueAt, published, show_solution AS showSolution, (SELECT name FROM tp_classes c WHERE c.id = tp_exercises.class_id) AS class FROM tp_exercises WHERE id = ?",
    bool: ["published", "showSolution"],
  },
  // pas d'e-mail ni de mot de passe : seulement ce qui change les droits ou l'affichage
  user: {
    sql: `SELECT display_name AS displayName, role, active, project_scope AS projectScope,
                 (SELECT GROUP_CONCAT(project_id || ':' || role) FROM (SELECT project_id, role FROM project_members WHERE user_id = users.id ORDER BY project_id)) AS projectRoles
          FROM users WHERE id = ?`,
    bool: ["active"],
  },
};

function plain(row: Row, bool: string[] = []): Snapshot {
  const out: Snapshot = {};
  for (const [k, v] of Object.entries(row)) out[k] = bool.includes(k) ? v === 1 : v;
  return out;
}

export function snapshot(kind: SnapshotKind, id: number, db: Db = getDb()): Snapshot | null {
  try {
    switch (kind) {
      case "settings": {
        const s = getAppSettings(db);
        return { orgName: s.orgName, auditRetentionDays: s.auditRetentionDays, warnPct: s.thresholds.warnPct, critPct: s.thresholds.critPct };
      }
      case "assistantSettings": {
        const c = getAiConfig(db);
        return { enabled: c.enabled, provider: c.provider, baseUrl: c.baseUrl, model: c.model };
      }
      case "signupSettings": {
        const c = getSignupConfig(db);
        return {
          enabled: c.enabled,
          domains: c.domains.join(","),
          consoleMode: c.consoleMode,
          smtpHost: c.smtp.host,
          smtpPort: c.smtp.port,
          smtpSecurity: c.smtp.security,
          smtpFrom: c.smtp.from,
        };
      }
      case "ssoSettings": {
        // jamais de secret, de DN de service, ni de noms de groupes : seulement l'état et les réglages techniques
        const { oidc, ldap } = getSsoConfig(db);
        return {
          oidcEnabled: oidc.enabled, oidcIssuer: oidc.issuer, oidcClientId: oidc.clientId, oidcSecret: oidc.hasSecret,
          ldapEnabled: ldap.enabled, ldapUrl: ldap.url, ldapStartTls: ldap.startTls, ldapBaseDn: ldap.baseDn, ldapPassword: ldap.hasPassword,
          oidcGroups: oidc.allowedGroups.length + oidc.adminGroups.length + oidc.editorGroups.length,
          ldapGroups: ldap.allowedGroups.length + ldap.adminGroups.length + ldap.editorGroups.length,
        };
      }
      case "alertSettings": {
        const c = getAlertConfig(db);
        // les adresses des destinataires sont des données personnelles : on ne journalise que leur nombre
        return { enabled: c.enabled, recipients: c.recipients.length, projectRecipients: c.projectRecipients.reduce((n, p) => n + p.recipients.length, 0), minSeverity: c.minSeverity, intervalMin: c.intervalMin, locale: c.locale };
      }
      default: {
        const q = SQL[kind as AuditEntity];
        if (!q) return null;
        const row = db.prepare(q.sql).get(id) as Row | undefined;
        return row ? plain(row, q.bool) : null;
      }
    }
  } catch {
    return null;
  }
}

/** Prend l'instantané AVANT l'opération ; `updated()` / `removed()` donnent l'historique à journaliser APRÈS son succès. */
export function trackChanges(kind: SnapshotKind, id: number, db: Db = getDb()) {
  const before = snapshot(kind, id, db);
  return {
    updated: (): ChangeSet | null => diffSnapshots(before, snapshot(kind, id, db)),
    removed: (): ChangeSet | null => diffSnapshots(before, null),
  };
}
