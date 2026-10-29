import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { demoDismissed } from "./demoMark";
import { seedAlerts, seedDatabase, seedDemoAddresses, seedDemoDhcp, seedDemoVrfs } from "./seed";

export type Db = Database.Database;

export const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "ip-architect.db");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  description TEXT,
  created_at TEXT
);

-- Réglages applicatifs (clé/valeur) : pour l'instant, le projet actif (active_project_id).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vlans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- VRF : espace d'adressage isolé. Un réseau sans VRF (vrf_id NULL) appartient à la table de routage globale.
CREATE TABLE IF NOT EXISTS vrfs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rd TEXT,
  rt_import TEXT NOT NULL DEFAULT '',
  rt_export TEXT NOT NULL DEFAULT '',
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vrfs_name ON vrfs(project_id, LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_vrfs_rd ON vrfs(project_id, rd) WHERE rd IS NOT NULL;

CREATE TABLE IF NOT EXISTS networks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  cidr TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version IN (4, 6)),
  name TEXT NOT NULL,
  vlan INTEGER,
  vrf_id INTEGER REFERENCES vrfs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance','error')),
  used_ips INTEGER NOT NULL DEFAULT 0,
  reserved_ips INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_networks_project ON networks(project_id);
CREATE INDEX IF NOT EXISTS idx_networks_site ON networks(site_id);
CREATE INDEX IF NOT EXISTS idx_networks_vrf ON networks(vrf_id);

-- Les alertes sont structurées (kind + sujet) : le texte affiché est traduit selon la langue de l'utilisateur.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('overlap','dhcp','usage','prefix','backup')),
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  subject TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('network','pool','project')),
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_history (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  ipv4 REAL NOT NULL,
  ipv6 REAL NOT NULL,
  active REAL NOT NULL,
  PRIMARY KEY (project_id, day)
);

-- Un numéro de VLAN est unique par site (COALESCE : les VLAN « globaux », sans site, sont uniques entre eux).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vlans_unique ON vlans(project_id, COALESCE(site_id, 0), number);

-- IPAM : adresses inventoriées. Les compteurs networks.used_ips / reserved_ips restent la référence
-- pour le dashboard et valent toujours AU MOINS le nombre d'adresses inventoriées (le reste = non inventorié).
CREATE TABLE IF NOT EXISTS ip_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('used','reserved')),
  hostname TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, address)
);

-- Planification : plans d'adressage (brouillon -> appliqué). L'allocation d'un brouillon est calculée à la volée.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_cidr TEXT NOT NULL,
  vrf_id INTEGER REFERENCES vrfs(id) ON DELETE SET NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  hosts INTEGER,
  prefix INTEGER,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  vlan INTEGER,
  applied_cidr TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id);

-- Utilisateurs : comptes de connexion (globaux, pas par projet) et sessions. Tant qu'aucun compte n'existe,
-- l'application reste ouverte (comportement historique) ; créer le premier administrateur active la connexion.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  email TEXT,
  email_verified_at TEXT,
  project_scope TEXT NOT NULL DEFAULT 'all',
  active_project_id INTEGER,
  auth_source TEXT NOT NULL DEFAULT 'local',
  external_id TEXT
);

-- Rôle d'un compte « à projets choisis » dans chacun de ses projets (viewer ou editor). Absent = pas d'accès.
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users(auth_source, external_id) WHERE external_id IS NOT NULL;

-- Scan réseau : résultat d'un scan terminé (hôtes qui ont répondu, en JSON). Les derniers scans de chaque réseau sont gardés.
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  cidr TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  total INTEGER NOT NULL,
  options TEXT NOT NULL,
  hosts TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_scans_network ON scans(network_id, id);

-- Scans programmés (un par réseau) et hôtes que l'on a choisi d'ignorer (appareils connus mais volontairement non inventoriés).
CREATE TABLE IF NOT EXISTS scan_schedules (
  network_id INTEGER PRIMARY KEY REFERENCES networks(id) ON DELETE CASCADE,
  every_hours INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  alert INTEGER NOT NULL DEFAULT 1,
  options TEXT NOT NULL,
  last_started_at TEXT
);
CREATE TABLE IF NOT EXISTS scan_ignored (
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, address)
);

-- Topologie réseau : identifiants SNMP (la communauté est un secret : jamais renvoyée, retirée des sauvegardes), équipements, liens
-- (a_device < b_device : un lien n'existe qu'une fois) et machines vues sur les ports des équipements.
CREATE TABLE IF NOT EXISTS snmp_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  community TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 161,
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS topo_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  info TEXT,
  chassis_id TEXT,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  credential_id INTEGER REFERENCES snmp_credentials(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  pos_x REAL,
  pos_y REAL,
  last_seen_at TEXT,
  ports TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_topo_devices_project ON topo_devices(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topo_devices_chassis ON topo_devices(project_id, chassis_id) WHERE chassis_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS topo_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  a_device INTEGER NOT NULL REFERENCES topo_devices(id) ON DELETE CASCADE,
  a_port TEXT,
  b_device INTEGER NOT NULL REFERENCES topo_devices(id) ON DELETE CASCADE,
  b_port TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  reported_by INTEGER,
  speed_mbps INTEGER,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_topo_links_project ON topo_links(project_id);
CREATE TABLE IF NOT EXISTS topo_clients (
  device_id INTEGER NOT NULL REFERENCES topo_devices(id) ON DELETE CASCADE,
  mac TEXT NOT NULL,
  port TEXT,
  ip TEXT,
  vlan INTEGER,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (device_id, mac)
);

-- Connexion unique (OpenID Connect) : une ligne par tentative en cours, à usage unique, valable 10 minutes.
-- Seuls les hash de « state » et du cookie de liaison sont conservés.
CREATE TABLE IF NOT EXISTS sso_flows (
  state_hash TEXT PRIMARY KEY,
  bind_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Inscriptions en attente de vérification de l'adresse e-mail. Le mot de passe est déjà haché (scrypt) ; le code ne l'est
-- qu'en SHA-256 salé et n'est valable que 2 minutes (expires_at). Une seule demande par adresse. Aucune clé étrangère.
CREATE TABLE IF NOT EXISTS signup_requests (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT
);

-- Mot de passe oublié : une demande en attente par compte. Le code n'est conservé que salé et haché (SHA-256), valable 10 minutes.
CREATE TABLE IF NOT EXISTS password_resets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_alert_recipients (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (project_id, email)
);

CREATE TABLE IF NOT EXISTS alert_state (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  first_sent_at TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

-- Seul le hash SHA-256 du jeton est stocké : une copie de la base ne permet pas de se faire passer pour quelqu'un.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- Journal d'audit : qui a fait quoi, quand. Aucune clé étrangère : l'historique survit à la suppression d'un compte ou d'un projet.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  username TEXT,
  project_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  ip TEXT,
  changes TEXT,
  via TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_username ON audit_log(username);

-- Jetons d'API : seul le hash SHA-256 est stocké (le jeton lui-même n'est montré qu'une fois, à sa création).
-- Le rôle d'un jeton est plafonné par celui de son propriétaire et n'est jamais « admin ».
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- Mode TP : exercices corrigés automatiquement et remises des étudiants. Une remise garde le nom du compte (user_id passe à
-- NULL si le compte est supprimé : les notes ne disparaissent pas avec lui).
CREATE TABLE IF NOT EXISTS tp_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  config TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  due_at TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  show_solution INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  class_id INTEGER
);
-- Classes du mode TP : un exercice peut être réservé à une classe (class_id NULL = tous les étudiants).
CREATE TABLE IF NOT EXISTS tp_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tp_classes_name ON tp_classes(LOWER(name));
CREATE TABLE IF NOT EXISTS tp_class_members (
  class_id INTEGER NOT NULL REFERENCES tp_classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tp_members_user ON tp_class_members(user_id);
CREATE TABLE IF NOT EXISTS tp_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id INTEGER NOT NULL REFERENCES tp_exercises(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  answers TEXT NOT NULL,
  score INTEGER NOT NULL,
  result TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE (exercise_id, user_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_tp_sub_ex ON tp_submissions(exercise_id);

-- Notifications lues : une ligne par (compte, contrôle de supervision). user_id = 0 quand l'application est ouverte (aucun compte).
-- Aucune clé étrangère : les lignes d'un compte supprimé sont nettoyées par pruneReads.
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, fingerprint)
);

-- DHCP : une plage de distribution (IPv4) par ensemble d'adresses d'un réseau, plus des réservations MAC -> IP.
CREATE TABLE IF NOT EXISTS dhcp_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  gateway TEXT,
  dns TEXT NOT NULL DEFAULT '',
  lease_seconds INTEGER NOT NULL DEFAULT 86400,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dhcp_scopes_network ON dhcp_scopes(network_id);

CREATE TABLE IF NOT EXISTS dhcp_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  mac TEXT NOT NULL,
  address TEXT NOT NULL,
  hostname TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (scope_id, mac),
  UNIQUE (scope_id, address)
);

-- Étiquettes et champs personnalisés (par projet) sur les réseaux et les adresses IP.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(project_id, LOWER(name));
CREATE TABLE IF NOT EXISTS network_tags (
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (network_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_network_tags_tag ON network_tags(tag_id);
CREATE TABLE IF NOT EXISTS address_tags (
  address_id INTEGER NOT NULL REFERENCES ip_addresses(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (address_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_address_tags_tag ON address_tags(tag_id);
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, entity, key)
);
CREATE TABLE IF NOT EXISTS network_custom_values (
  network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (network_id, field_id)
);
CREATE TABLE IF NOT EXISTS address_custom_values (
  address_id INTEGER NOT NULL REFERENCES ip_addresses(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (address_id, field_id)
);

-- Webhooks : un appel HTTP signé à chaque changement d'adressage du projet. File d'envoi durable (reprise après redémarrage).
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  response_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_hook ON webhook_deliveries(webhook_id, id);
`;

declare global {
  // eslint-disable-next-line no-var
  var __ipArchitectDb: Db | undefined;
}

/**
 * Migration v1.0 -> v1.1 : l'ancienne table `alerts` contenait des textes français en dur (title/detail).
 * Elle est recréée au format structuré. Ce ne sont que des alertes de démonstration : aucune donnée utilisateur perdue.
 * Retourne true si la table a été supprimée (il faudra alors réinsérer les alertes de démo).
 */
function dropLegacyAlerts(db: Db): boolean {
  const cols = db.prepare("PRAGMA table_info(alerts)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "subject")) {
    db.exec("DROP TABLE alerts");
    return true;
  }
  return false;
}

/**
 * Migration v1.3 -> v1.4 : la colonne networks.vrf_id n'existait pas. Elle est ajoutée AVANT la création du schéma
 * (l'index sur vrf_id en dépend). Valeur NULL pour tous les réseaux existants = VRF globale : rien ne change pour eux.
 */
function addVrfColumn(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(networks)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "vrf_id")) {
    db.exec("ALTER TABLE networks ADD COLUMN vrf_id INTEGER REFERENCES vrfs(id) ON DELETE SET NULL");
  }
}

/**
 * Migration v1.x -> inscription par e-mail : users gagne email / email_verified_at (NULL pour les comptes existants).
 * Ajoutées AVANT la création du schéma, dont l'index unique sur email dépend de la colonne.
 */
function addUserEmailColumns(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.length === 0) return; // table absente : SCHEMA la créera avec les colonnes
  for (const c of ["email", "email_verified_at"]) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
  }
  // accès par projet : les comptes existants gardent leur rôle dans TOUS les projets
  if (!cols.some((x) => x.name === "project_scope")) db.exec("ALTER TABLE users ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'all'");
  if (!cols.some((x) => x.name === "active_project_id")) db.exec("ALTER TABLE users ADD COLUMN active_project_id INTEGER");
  // connexion unique : les comptes existants sont « local » (mot de passe propre à l'application)
  if (!cols.some((x) => x.name === "auth_source")) db.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
  if (!cols.some((x) => x.name === "external_id")) db.exec("ALTER TABLE users ADD COLUMN external_id TEXT");
}

/** Mode TP : un exercice peut être réservé à une classe. Colonne facultative (NULL = tous), sans clé étrangère : supprimer une classe utilisée est refusé par le code. */
function addTpClassColumn(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(tp_exercises)").all() as { name: string }[];
  if (cols.length === 0) return;
  if (!cols.some((x) => x.name === "class_id")) db.exec("ALTER TABLE tp_exercises ADD COLUMN class_id INTEGER");
}

/** Le journal gagne l'historique avant/après (changes) et l'origine « jeton d'API » (via) : colonnes facultatives, NULL pour l'existant. */
function addAuditColumns(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
  if (cols.length === 0) return; // table absente : SCHEMA la créera avec les colonnes
  for (const c of ["changes", "via"]) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${c} TEXT`);
  }
}

/**
 * Migration v1.5 -> v1.6 : projects et sites gagnent description / adresse / date de création.
 * Colonnes facultatives (NULL pour les lignes existantes) : aucune donnée n'est modifiée.
 */
function addSiteProjectColumns(db: Db): void {
  const want: Record<string, string[]> = {
    projects: ["description", "created_at"],
    sites: ["address", "description", "created_at"],
  };
  for (const [table, columns] of Object.entries(want)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length === 0) continue; // table absente : SCHEMA la créera avec les colonnes
    for (const c of columns) {
      if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
    }
  }
}

/** Ouvre (une seule fois) la base SQLite, crée le schéma et injecte des données de démo si elle est vide. */
export function getDb(): Db {
  if (!globalThis.__ipArchitectDb) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const legacyAlertsDropped = dropLegacyAlerts(db);
    // Migration v1.3 -> v1.4 : les VRF n'existaient pas encore (une seule fois).
    const hadVrfTable = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vrfs'")
      .get();
    addVrfColumn(db);
    addSiteProjectColumns(db);
    addUserEmailColumns(db);
    addTpClassColumn(db);
    addAuditColumns(db);
    // Migration v1.1 -> v1.2 : la table ip_addresses n'existait pas encore (une seule fois).
    const hadAddressesTable = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ip_addresses'")
      .get();
    // Migration v1.2 -> v1.3 : les tables DHCP n'existaient pas encore (une seule fois).
    const hadDhcpTable = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dhcp_scopes'")
      .get();
    db.exec(SCHEMA);

    const row = db.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number };
    if (row.c === 0) {
      // démonstration déjà quittée : on ne la recrée plus, on repart d'un projet vide
      if (demoDismissed(db)) db.prepare("INSERT INTO projects (name, created_at) VALUES (?, ?)").run("Mon projet", new Date().toISOString());
      else seedDatabase(db);
    } else {
      const project = db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number };
      if (legacyAlertsDropped) seedAlerts(db, project.id);
      // Base créée avant l'IPAM : on ajoute des adresses de démonstration, une seule fois,
      // uniquement sur les réseaux de démonstration (vos propres réseaux ne sont jamais touchés).
      if (!hadAddressesTable) db.transaction(() => seedDemoAddresses(db, project.id))();
      // Idem pour le DHCP : plages de démonstration uniquement sur les réseaux de démonstration.
      if (!hadDhcpTable) db.transaction(() => seedDemoDhcp(db, project.id))();
      // Idem pour les VRF : quelques VRF de démonstration, rattachées aux seuls réseaux de démonstration.
      if (!hadVrfTable) db.transaction(() => seedDemoVrfs(db, project.id))();
    }

    globalThis.__ipArchitectDb = db;
  }
  return globalThis.__ipArchitectDb;
}
